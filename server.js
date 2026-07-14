const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SECRETS_PATH = path.join(DATA_DIR, 'arcade.secrets.json');
const KNOWN_IPS_PATH = path.join(DATA_DIR, 'known-ips.json');
const NOTES_PATH = path.join(DATA_DIR, 'session-note.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');
const LAUNCH_SCRIPT = path.join(ROOT, 'scripts', 'launch-game.ps1');

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const STREAM_TARGET = process.env.STREAM_TARGET || 'http://127.0.0.1:8080';
const STREAM_HEALTH_TIMEOUT_MS = Number(process.env.STREAM_HEALTH_TIMEOUT_MS || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const PUBLIC_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.PUBLIC_MODE || '').toLowerCase());
const COOKIE_ACCESS = 'arcade_access';
const COOKIE_IDENTITY = 'arcade_identity';
const VALID_NAMES = new Set(['Liz', 'Addison']);
const PRESENCE_TTL_MS = 45_000;
const UNLOCK_MAX_FAILURES = 8;
const UNLOCK_LOCKOUT_MS = 15 * 60 * 1000;
const INVITE_COOLDOWN_MS = 60_000;
const BRIDGE_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const PUBLIC_DIR = path.join(ROOT, 'public');

ensureDataDir();
const secrets = loadSecrets();
const ACCESS_TOKEN = process.env.ARCADE_ACCESS_TOKEN || secrets.accessToken || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || secrets.discordWebhookUrl || '';
const PUBLIC_PLAY_URL = process.env.PUBLIC_PLAY_URL || secrets.publicPlayUrl || '';
const SECURITY_QUESTION = secrets.securityQuestion || 'Where was our first date?';
const ACCEPTED_KEYWORDS = normalizeKeywordList(secrets.acceptedKeywords || []);
const SIGNING_SECRET = ACCESS_TOKEN || secrets.accessToken || 'dev-local-signing-key';

if (PUBLIC_MODE && !ACCESS_TOKEN) {
  console.error('[Arcade] PUBLIC_MODE requires ARCADE_ACCESS_TOKEN or accessToken in data/arcade.secrets.json');
  process.exit(1);
}

const ALLOWED_EMBED_ORIGINS = (process.env.ALLOWED_EMBED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      console.warn(`[Arcade Embed] Ignoring invalid embed origin: ${origin}`);
      return null;
    }
  })
  .filter(Boolean);

const frameAncestors = ["'self'", ...new Set(ALLOWED_EMBED_ORIGINS)].join(' ');
const presenceByName = new Map();
const unlockFailures = new Map();
let lastInviteAt = 0;
let lastBridgeNotifyAt = 0;
let lastBridgeAvailable = null;

app.set('trust proxy', TRUST_PROXY);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  next();
});

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSecrets() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
  } catch (error) {
    console.warn(`[Arcade Secrets] Could not load ${SECRETS_PATH}: ${error.message}`);
    return {};
  }
}

function normalizeKeywordList(keywords) {
  return [...new Set(
    (Array.isArray(keywords) ? keywords : [])
      .map((word) => String(word || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean)
  )];
}

function normalizeAnswer(answer) {
  return String(answer || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function answerMatchesKeywords(answer) {
  if (!ACCEPTED_KEYWORDS.length) {
    return true;
  }
  const tokens = new Set(normalizeAnswer(answer));
  return ACCEPTED_KEYWORDS.some((keyword) => tokens.has(keyword));
}

function constantTimeEqual(value, expected) {
  const valueBuffer = Buffer.from(value || '');
  const expectedBuffer = Buffer.from(expected || '');
  return valueBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function accessSessionValue() {
  if (!ACCESS_TOKEN) {
    return '';
  }
  return crypto.createHmac('sha256', ACCESS_TOKEN)
    .update('arcade-access-session')
    .digest('base64url');
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function verifySignedPayload(token) {
  if (!token || !token.includes('.')) {
    return null;
  }
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', SIGNING_SECRET)
    .update(body)
    .digest('base64url');
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const cookies = {};
  for (const entry of (request.headers.cookie || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies.
    }
  }
  return cookies;
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function isAuthenticated(request) {
  return !ACCESS_TOKEN || constantTimeEqual(parseCookies(request)[COOKIE_ACCESS], accessSessionValue());
}

function getIdentity(request) {
  const payload = verifySignedPayload(parseCookies(request)[COOKIE_IDENTITY]);
  if (!payload || !VALID_NAMES.has(payload.name)) {
    return null;
  }
  return payload;
}

function identityRequired() {
  return Boolean(ACCESS_TOKEN) || fs.existsSync(SECRETS_PATH);
}

function needsIdentity(request) {
  return identityRequired() && !getIdentity(request);
}

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/play';
}

function hasPlayIdentity(request) {
  return !identityRequired() || Boolean(getIdentity(request));
}

function requireStreamSession(request, response, next) {
  if (!isAuthenticated(request)) {
    return response.status(401).type('html').send(`
      <html><body style="background:#0f0f1a;color:#ff9bad;font-family:sans-serif;padding:2rem;">
        <h1>Unauthorized</h1>
        <p>Unlock the arcade before connecting to the stream.</p>
        <p><a href="/unlock?returnTo=/play" style="color:#fbc2eb;">Unlock</a></p>
      </body></html>
    `);
  }
  if (!hasPlayIdentity(request)) {
    return response.redirect(`/identify?returnTo=${encodeURIComponent(request.originalUrl)}`);
  }
  return next();
}

function setCookie(response, name, value, request, maxAgeMs) {
  response.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.secure,
    maxAge: maxAgeMs,
    path: '/'
  });
}

function setAccessCookie(request, response) {
  if (!ACCESS_TOKEN) {
    return;
  }
  setCookie(response, COOKIE_ACCESS, accessSessionValue(), request, 1000 * 60 * 60 * 24 * 30);
}

function setIdentityCookie(request, response, name) {
  const payload = { name, claimedAt: new Date().toISOString() };
  setCookie(response, COOKIE_IDENTITY, signPayload(payload), request, 1000 * 60 * 60 * 24 * 30);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendAudit(entry) {
  ensureDataDir();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...entry
  });
  fs.appendFileSync(AUDIT_PATH, `${line}\n`, 'utf8');
}

function unlockLocked(ip) {
  const record = unlockFailures.get(ip);
  if (!record) {
    return false;
  }
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return true;
  }
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    unlockFailures.delete(ip);
  }
  return false;
}

function recordUnlockFailure(ip) {
  const current = unlockFailures.get(ip) || { fails: 0, lockedUntil: 0 };
  current.fails += 1;
  if (current.fails >= UNLOCK_MAX_FAILURES) {
    current.lockedUntil = Date.now() + UNLOCK_LOCKOUT_MS;
  }
  unlockFailures.set(ip, current);
  return current;
}

function clearUnlockFailures(ip) {
  unlockFailures.delete(ip);
}

function loadKnownIps() {
  const data = readJsonFile(KNOWN_IPS_PATH, { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

function findKnownIp(ip) {
  return loadKnownIps().find((entry) => entry.ip === ip) || null;
}

function rememberIp(ip, name) {
  const entries = loadKnownIps().filter((entry) => entry.ip !== ip);
  entries.push({
    ip,
    name,
    lastSeen: new Date().toISOString()
  });
  writeJsonFile(KNOWN_IPS_PATH, { entries });
}

function pageShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { align-items: center; background: #0f0f1a; color: #f5f3ff; display: flex; font: 16px Outfit, system-ui, sans-serif; justify-content: center; margin: 0; min-height: 100vh; }
      main { background: #1a1a2e; border: 1px solid #8065c7; border-radius: 16px; box-shadow: 0 12px 36px #0008; box-sizing: border-box; max-width: 440px; padding: 2rem; width: calc(100% - 2rem); }
      h1 { margin-top: 0; font-family: Fredoka, system-ui, sans-serif; }
      p { color: #d5d0e8; line-height: 1.5; }
      label { display: block; margin: 1.25rem 0 .5rem; }
      input, button, select { border-radius: 8px; box-sizing: border-box; font: inherit; padding: .8rem; width: 100%; }
      input, select { border: 1px solid #aaa; background: #fff; color: #111; }
      button { background: #8b6bd6; border: 0; color: white; cursor: pointer; font-weight: 700; margin-top: 1rem; }
      .name-row { display: grid; gap: .75rem; grid-template-columns: 1fr 1fr; margin-top: 1rem; }
      .name-row button { margin-top: 0; }
      .error { color: #ff9bad; }
      .hint { color: #9a93b5; font-size: .9rem; }
    </style>
  </head>
  <body>
    <main>${bodyHtml}</main>
  </body>
</html>`;
}

function loginPage(returnTo, error = false, locked = false) {
  const message = locked
    ? '<p class="error">Too many failed attempts. Try again in a few minutes.</p>'
    : error
      ? '<p class="error">That access token was not recognized. Try again.</p>'
      : '<p>Enter the shared arcade access token to continue.</p>';
  return pageShell('Unlock the Arcade', `
    <h1>🐱 Unlock the Arcade</h1>
    ${message}
    <form method="post" action="/unlock">
      <input type="hidden" name="returnTo" value="${returnTo.replace(/"/g, '&quot;')}">
      <label for="access-token">Access token</label>
      <input id="access-token" name="accessToken" type="password" autocomplete="current-password" required autofocus ${locked ? 'disabled' : ''}>
      <button type="submit" ${locked ? 'disabled' : ''}>Unlock</button>
    </form>
  `);
}

function identifyPage(returnTo, options = {}) {
  const { error = '', requireQuestion = false, knownName = '' } = options;
  const questionBlock = requireQuestion ? `
    <label for="security-answer">${SECURITY_QUESTION.replace(/</g, '&lt;')}</label>
    <input id="security-answer" name="securityAnswer" type="text" autocomplete="off" required autofocus>
    <p class="hint">A short answer is fine — we match familiar keywords, not exact spelling.</p>
  ` : (knownName
    ? `<p class="hint">Welcome back${knownName ? `, ${knownName}` : ''}. Confirm who is playing on this device.</p>`
    : '<p class="hint">Who is joining the arcade on this device?</p>');

  return pageShell('Who is playing?', `
    <h1>🐾 Who is playing?</h1>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form method="post" action="/identify">
      <input type="hidden" name="returnTo" value="${returnTo.replace(/"/g, '&quot;')}">
      ${questionBlock}
      <div class="name-row">
        <button type="submit" name="displayName" value="Liz">Liz</button>
        <button type="submit" name="displayName" value="Addison">Addison</button>
      </div>
    </form>
  `);
}

function requireAccess(request, response, next) {
  if (!isAuthenticated(request)) {
    if (request.path.startsWith('/api/')) {
      return response.status(401).json({ error: 'Unauthorized' });
    }
    return response.redirect(`/unlock?returnTo=${encodeURIComponent(request.originalUrl)}`);
  }
  if (needsIdentity(request) && !request.path.startsWith('/identify') && !request.path.startsWith('/api/')) {
    return response.redirect(`/identify?returnTo=${encodeURIComponent(request.originalUrl)}`);
  }
  return next();
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/api/public-status', (req, res) => {
  res.json({
    awake: true,
    publicMode: PUBLIC_MODE,
    unlockRequired: Boolean(ACCESS_TOKEN)
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
});

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'style.css'));
});

app.get('/unlock', (req, res) => {
  const ip = clientIp(req);
  res.type('html').send(loginPage(safeReturnTo(req.query.returnTo), false, unlockLocked(ip)));
});

app.post('/unlock', (req, res) => {
  const returnTo = safeReturnTo(req.body.returnTo);
  const ip = clientIp(req);

  if (unlockLocked(ip)) {
    appendAudit({ action: 'unlock_locked', ip, success: false });
    return res.status(429).type('html').send(loginPage(returnTo, false, true));
  }

  if (!ACCESS_TOKEN || constantTimeEqual(req.body.accessToken, ACCESS_TOKEN)) {
    clearUnlockFailures(ip);
    setAccessCookie(req, res);
    appendAudit({ action: 'unlock', ip, success: true });
    return res.redirect(`/identify?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const failure = recordUnlockFailure(ip);
  appendAudit({ action: 'unlock', ip, success: false, fails: failure.fails });
  return res.status(401).type('html').send(loginPage(returnTo, true, unlockLocked(ip)));
});

app.use((req, res, next) => {
  if (!ACCESS_TOKEN || !Object.prototype.hasOwnProperty.call(req.query, 'access_token')) {
    return next();
  }

  const ip = clientIp(req);
  if (unlockLocked(ip)) {
    return res.status(429).type('html').send(loginPage(safeReturnTo(req.path), false, true));
  }

  if (!constantTimeEqual(req.query.access_token, ACCESS_TOKEN)) {
    recordUnlockFailure(ip);
    appendAudit({ action: 'unlock_link', ip, success: false });
    return res.status(401).type('html').send(loginPage(safeReturnTo(req.path), true));
  }

  clearUnlockFailures(ip);
  setAccessCookie(req, res);
  appendAudit({ action: 'unlock_link', ip, success: true });
  const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
  url.searchParams.delete('access_token');
  const nextPath = `${url.pathname}${url.search}` || '/play';
  return res.redirect(`/identify?returnTo=${encodeURIComponent(nextPath.startsWith('/') ? nextPath : '/play')}`);
});

app.get('/identify', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect(`/unlock?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  const ip = clientIp(req);
  const known = findKnownIp(ip);
  const requireQuestion = !known && ACCEPTED_KEYWORDS.length > 0;
  res.type('html').send(identifyPage(safeReturnTo(req.query.returnTo), {
    requireQuestion,
    knownName: known?.name || ''
  }));
});

app.post('/identify', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.redirect(`/unlock?returnTo=${encodeURIComponent('/identify')}`);
  }

  const returnTo = safeReturnTo(req.body.returnTo);
  const ip = clientIp(req);
  const known = findKnownIp(ip);
  const requireQuestion = !known && ACCEPTED_KEYWORDS.length > 0;
  const displayName = String(req.body.displayName || '');

  if (!VALID_NAMES.has(displayName)) {
    return res.status(400).type('html').send(identifyPage(returnTo, {
      error: 'Choose Liz or Addison.',
      requireQuestion,
      knownName: known?.name || ''
    }));
  }

  if (requireQuestion && !answerMatchesKeywords(req.body.securityAnswer)) {
    appendAudit({ action: 'identify', ip, success: false, reason: 'security_answer' });
    return res.status(401).type('html').send(identifyPage(returnTo, {
      error: 'That answer did not match. Try again.',
      requireQuestion: true
    }));
  }

  setIdentityCookie(req, res, displayName);
  rememberIp(ip, displayName);
  appendAudit({ action: 'identify', ip, name: displayName, success: true, knownIp: Boolean(known) });
  return res.redirect(returnTo);
});

app.use(requireAccess);
app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/play', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/stream', (req, res) => {
  res.redirect('/stream/');
});

const streamProxy = createProxyMiddleware({
  target: STREAM_TARGET,
  changeOrigin: true,
  ws: true,
  pathRewrite: {
    '^/stream': ''
  },
  logger: console,
  onError: (err, req, res) => {
    console.error(`[Arcade Proxy Error] Target: ${STREAM_TARGET}. Message: ${err.message}`);
    if (res.status) {
      res.status(502).send(`
        <html>
          <head>
            <title>Arcade Service Unavailable</title>
            <style>
              body { background-color: #0f0f1a; color: #ff758f; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              div { background: #1a1a2e; padding: 2rem; border-radius: 12px; border: 1px solid #ff758f; text-align: center; max-width: 450px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }
              h1 { margin-top: 0; font-size: 1.5rem; }
              p { color: #b5b5c9; line-height: 1.5; }
            </style>
          </head>
          <body>
            <div>
              <h1>Stream Bridge Unreachable</h1>
              <p>The Express portal is active, but moonlight-web-stream is not responding at <strong>${STREAM_TARGET}</strong>.</p>
              <p>Please ensure Sunshine and the moonlight-web-stream service are running on the host laptop.</p>
            </div>
          </body>
        </html>
      `);
    }
  }
});

app.use('/stream', requireStreamSession, streamProxy);

function checkStreamTarget() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target;

    try {
      target = new URL(STREAM_TARGET);
    } catch (error) {
      resolve({
        available: false,
        error: `Invalid STREAM_TARGET: ${error.message}`,
        checkedAt: new Date().toISOString()
      });
      return;
    }

    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, { method: 'GET' }, (response) => {
      const available = response.statusCode >= 200 && response.statusCode < 400;
      response.resume();
      resolve({
        available,
        statusCode: response.statusCode,
        ...(available ? {} : { error: `Bridge returned HTTP ${response.statusCode}` }),
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      });
    });

    request.setTimeout(STREAM_HEALTH_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out after ${STREAM_HEALTH_TIMEOUT_MS}ms`));
    });
    request.once('error', (error) => {
      resolve({
        available: false,
        error: error.message,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      });
    });
    request.end();
  });
}

async function maybeNotifyBridgeHealthy(stream) {
  if (!DISCORD_WEBHOOK_URL || !stream.available) {
    lastBridgeAvailable = stream.available;
    return;
  }
  if (lastBridgeAvailable === true) {
    return;
  }
  if (Date.now() - lastBridgeNotifyAt < BRIDGE_NOTIFY_COOLDOWN_MS) {
    lastBridgeAvailable = stream.available;
    return;
  }
  lastBridgeAvailable = stream.available;
  lastBridgeNotifyAt = Date.now();
  try {
    await sendDiscordMessage('Arcade stream bridge is online. Ready for Cat Chess.');
    appendAudit({ action: 'bridge_notify', success: true });
  } catch (error) {
    appendAudit({ action: 'bridge_notify', success: false, error: error.message });
  }
}

function sendDiscordMessage(content) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(DISCORD_WEBHOOK_URL);
    } catch (error) {
      reject(error);
      return;
    }

    const body = JSON.stringify({ content });
    const request = https.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Discord webhook HTTP ${response.statusCode}`));
      }
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function runLaunchHelper(action) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({
        ok: false,
        running: false,
        configured: false,
        error: 'Game launch is only available on the Windows host.'
      });
      return;
    }

    if (!fs.existsSync(LAUNCH_SCRIPT)) {
      resolve({
        ok: false,
        running: false,
        configured: false,
        error: 'launch-game.ps1 is missing.'
      });
      return;
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LAUNCH_SCRIPT, '-Action', action],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      resolve({ ok: false, running: false, configured: false, error: error.message });
    });
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch {
        resolve({
          ok: false,
          running: false,
          configured: false,
          error: stderr.trim() || 'Could not parse launch helper output.'
        });
      }
    });
  });
}

function activePresence() {
  const now = Date.now();
  const people = [];
  for (const [name, lastSeen] of presenceByName.entries()) {
    if (now - lastSeen <= PRESENCE_TTL_MS) {
      people.push({ name, lastSeen: new Date(lastSeen).toISOString() });
    } else {
      presenceByName.delete(name);
    }
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return people;
}

app.get('/api/stream-status', async (req, res) => {
  const stream = await checkStreamTarget();
  maybeNotifyBridgeHealthy(stream).catch(() => {});
  res.status(stream.available ? 200 : 503).json({
    portal: 'healthy',
    streamTarget: STREAM_TARGET,
    ...stream
  });
});

app.get('/api/me', (req, res) => {
  const identity = getIdentity(req);
  res.json({
    name: identity?.name || null,
    authenticated: true,
    ipKnown: Boolean(findKnownIp(clientIp(req)))
  });
});

app.post('/api/identity/switch', (req, res) => {
  const displayName = String(req.body?.displayName || '');
  if (!VALID_NAMES.has(displayName)) {
    return res.status(400).json({ error: 'displayName must be Liz or Addison' });
  }
  const ip = clientIp(req);
  setIdentityCookie(req, res, displayName);
  rememberIp(ip, displayName);
  appendAudit({ action: 'identity_switch', ip, name: displayName, success: true });
  return res.json({ name: displayName });
});

app.get('/api/presence', (req, res) => {
  res.json({ people: activePresence() });
});

app.post('/api/presence', (req, res) => {
  const identity = getIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'Identity required' });
  }
  presenceByName.set(identity.name, Date.now());
  res.json({ people: activePresence(), you: identity.name });
});

app.get('/api/notes', (req, res) => {
  const note = readJsonFile(NOTES_PATH, {
    text: '',
    lastEditor: null,
    updatedAt: null
  });
  res.json(note);
});

app.put('/api/notes', (req, res) => {
  const identity = getIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'Identity required' });
  }
  const text = String(req.body?.text ?? '').slice(0, 4000);
  const note = {
    text,
    lastEditor: identity.name,
    updatedAt: new Date().toISOString()
  };
  writeJsonFile(NOTES_PATH, note);
  appendAudit({ action: 'notes_update', name: identity.name, success: true });
  res.json(note);
});

app.get('/api/game-status', async (req, res) => {
  const result = await runLaunchHelper('status');
  res.status(result.ok ? 200 : 503).json(result);
});

app.post('/api/launch-game', async (req, res) => {
  const identity = getIdentity(req);
  const result = await runLaunchHelper('launch');
  appendAudit({
    action: 'launch_game',
    name: identity?.name || null,
    ip: clientIp(req),
    success: Boolean(result.ok),
    launched: Boolean(result.launched)
  });
  res.status(result.ok ? 200 : 503).json(result);
});

app.post('/api/notify/invite', async (req, res) => {
  const identity = getIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'Identity required' });
  }
  if (!DISCORD_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Discord webhook is not configured.' });
  }
  if (Date.now() - lastInviteAt < INVITE_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Please wait a minute before sending another invite.' });
  }

  const playUrl = PUBLIC_PLAY_URL || `${req.protocol}://${req.get('host')}/play`;
  const message = `${identity.name} invited you to Cat Chess: ${playUrl}`;

  try {
    await sendDiscordMessage(message);
    lastInviteAt = Date.now();
    appendAudit({ action: 'invite', name: identity.name, success: true });
    res.json({ ok: true });
  } catch (error) {
    appendAudit({ action: 'invite', name: identity.name, success: false, error: error.message });
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/audit', (req, res) => {
  try {
    if (!fs.existsSync(AUDIT_PATH)) {
      return res.json({ entries: [] });
    }
    const lines = fs.readFileSync(AUDIT_PATH, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-200)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ entries: lines.reverse() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/coop-status', async (req, res) => {
  const stream = await checkStreamTarget();
  const game = await runLaunchHelper('status');
  const people = activePresence();
  const names = new Set(people.map((person) => person.name));
  res.json({
    unlocked: true,
    bridgeHealthy: Boolean(stream.available),
    gameRunning: Boolean(game.running),
    gameConfigured: Boolean(game.configured),
    presence: people,
    bothPresent: names.has('Liz') && names.has('Addison'),
    you: getIdentity(req)?.name || null
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.redirect('/play');
});

const server = app.listen(PORT, BIND_HOST, () => {
  console.log('\n======================================================');
  console.log("🐱 ADDISON & ELIZABETH'S COZY ARCADE PORTAL IS ALIVE");
  console.log('======================================================');
  console.log(`Portal Address: http://localhost:${PORT}`);
  console.log(`Public landing: http://localhost:${PORT}/`);
  console.log(`Play (gated): http://localhost:${PORT}/play`);
  console.log(`Listening on: ${BIND_HOST}:${PORT}`);
  console.log(`Streaming Target: ${STREAM_TARGET}`);
  console.log(`Public mode: ${PUBLIC_MODE ? 'ON (token required)' : 'off'}`);
  if (ACCESS_TOKEN) {
    console.log('Access control: enabled');
  } else {
    console.warn('Access control: DISABLED (set ARCADE_ACCESS_TOKEN or data/arcade.secrets.json)');
  }
  if (fs.existsSync(SECRETS_PATH)) {
    console.log(`Secrets file: ${SECRETS_PATH}`);
  } else {
    console.log('Secrets file: not found (using env / defaults)');
  }
  console.log('Publish via Cloudflare Tunnel to this loopback port for lizandadd.com');
  console.log('Tailscale on clients is optional (admin/private access only)');
  console.log('======================================================\n');
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/stream')) {
    socket.destroy();
    return;
  }
  if (!isAuthenticated(req) || !hasPlayIdentity(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  streamProxy.upgrade(req, socket, head);
});