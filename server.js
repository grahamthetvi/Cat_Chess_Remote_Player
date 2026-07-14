const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const STREAM_TARGET = process.env.STREAM_TARGET || 'http://127.0.0.1:8080';
const STREAM_HEALTH_TIMEOUT_MS = Number(process.env.STREAM_HEALTH_TIMEOUT_MS || 3000);
const ACCESS_TOKEN = process.env.ARCADE_ACCESS_TOKEN;
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const COOKIE_NAME = 'arcade_access';
const ALLOWED_EMBED_ORIGINS = (process.env.ALLOWED_EMBED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
  .map(origin => {
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

// Trust X-Forwarded-Proto only from a local reverse proxy by default. If your
// proxy is elsewhere, set TRUST_PROXY to its specific IP address or CIDR.
app.set('trust proxy', TRUST_PROXY);
app.use(express.urlencoded({ extended: false }));

// Keep the portal same-origin by default. Set ALLOWED_EMBED_ORIGINS to a
// comma-separated list of trusted website origins to permit iframe embedding.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  next();
});

function constantTimeEqual(value, expected) {
  const valueBuffer = Buffer.from(value || '');
  const expectedBuffer = Buffer.from(expected || '');
  return valueBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

function sessionValue() {
  if (!ACCESS_TOKEN) {
    return '';
  }

  // The shared secret never appears in the cookie itself.
  return crypto.createHmac('sha256', ACCESS_TOKEN)
    .update('arcade-access-session')
    .digest('base64url');
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
      // A malformed, user-controlled Cookie header is simply not a session.
    }
  }
  return cookies;
}

function isAuthenticated(request) {
  return !ACCESS_TOKEN || constantTimeEqual(parseCookies(request)[COOKIE_NAME], sessionValue());
}

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}

function setSessionCookie(request, response) {
  response.cookie(COOKIE_NAME, sessionValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.secure,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/'
  });
}

function loginPage(returnTo, error = false) {
  const message = error
    ? '<p class="error">That access token was not recognized. Try again.</p>'
    : '<p>Enter the shared arcade access token to continue.</p>';
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Unlock the Arcade</title>
        <style>
          body { align-items: center; background: #0f0f1a; color: #f5f3ff; display: flex; font: 16px system-ui, sans-serif; justify-content: center; margin: 0; min-height: 100vh; }
          main { background: #1a1a2e; border: 1px solid #8065c7; border-radius: 16px; box-shadow: 0 12px 36px #0008; box-sizing: border-box; max-width: 420px; padding: 2rem; width: calc(100% - 2rem); }
          h1 { margin-top: 0; } p { color: #d5d0e8; line-height: 1.5; } label { display: block; margin: 1.5rem 0 .5rem; } input, button { border-radius: 8px; box-sizing: border-box; font: inherit; padding: .8rem; width: 100%; } input { border: 1px solid #aaa; } button { background: #8b6bd6; border: 0; color: white; cursor: pointer; font-weight: 700; margin-top: 1rem; } .error { color: #ff9bad; }
        </style>
      </head>
      <body>
        <main>
          <h1>🐱 Unlock the Arcade</h1>
          ${message}
          <form method="post" action="/unlock">
            <input type="hidden" name="returnTo" value="${returnTo.replace(/"/g, '&quot;')}">
            <label for="access-token">Access token</label>
            <input id="access-token" name="accessToken" type="password" autocomplete="current-password" required autofocus>
            <button type="submit">Unlock</button>
          </form>
        </main>
      </body>
    </html>`;
}

// Public by design for external uptime monitoring. It reveals no target,
// uptime, or other deployment details.
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/unlock', (req, res) => {
  res.type('html').send(loginPage(safeReturnTo(req.query.returnTo)));
});

app.post('/unlock', (req, res) => {
  const returnTo = safeReturnTo(req.body.returnTo);
  if (!ACCESS_TOKEN || constantTimeEqual(req.body.accessToken, ACCESS_TOKEN)) {
    setSessionCookie(req, res);
    return res.redirect(returnTo);
  }

  return res.status(401).type('html').send(loginPage(returnTo, true));
});

// A one-time token link is exchanged for an HttpOnly cookie, then the token is
// removed from the URL before any portal or stream content is served.
app.use((req, res, next) => {
  if (!ACCESS_TOKEN || !Object.prototype.hasOwnProperty.call(req.query, 'access_token')) {
    return next();
  }

  if (!constantTimeEqual(req.query.access_token, ACCESS_TOKEN)) {
    return res.status(401).type('html').send(loginPage(safeReturnTo(req.path), true));
  }

  setSessionCookie(req, res);
  const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
  url.searchParams.delete('access_token');
  return res.redirect(`${url.pathname}${url.search}`);
});

function requireAccess(request, response, next) {
  if (isAuthenticated(request)) {
    return next();
  }
  return response.redirect(`/unlock?returnTo=${encodeURIComponent(request.originalUrl)}`);
}

// Everything except the deliberately minimal health and unlock endpoints is
// protected, including static files and the stream proxy.
app.use(requireAccess);

// Serve static assets from public/ folder
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight, linkable entry point for websites and iframe embeds.
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redirect /stream to /stream/ to preserve relative paths for proxied assets
app.get('/stream', (req, res) => {
  res.redirect('/stream/');
});

// Configure the proxy middleware to forward to moonlight-web-stream
const streamProxy = createProxyMiddleware({
  target: STREAM_TARGET,
  changeOrigin: true,
  ws: true, // Enable WebSocket proxying
  pathRewrite: {
    '^/stream': '', // Remove /stream prefix before forwarding
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
              <h1>🕹️ Stream Bridge Unreachable</h1>
              <p>The Express portal is active, but the background streaming service (moonlight-web-stream) is not responding at <strong>${STREAM_TARGET}</strong>.</p>
              <p>Please ensure Sunshine and the moonlight-web-stream service are running on the host laptop.</p>
            </div>
          </body>
        </html>
      `);
    }
  }
});

// Mount proxy for stream (HTTP and WebSocket)
app.use('/stream', streamProxy);

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

// Checks whether the configured moonlight-web-stream bridge accepts HTTP.
app.get('/api/stream-status', async (req, res) => {
  const stream = await checkStreamTarget();
  res.status(stream.available ? 200 : 503).json({
    portal: 'healthy',
    streamTarget: STREAM_TARGET,
    ...stream
  });
});

// Catch-all route to serve the main frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🐱 ADDISON & ELIZABETH'S COZY ARCADE PORTAL IS ALIVE`);
  console.log(`======================================================`);
  console.log(`Portal Address: http://localhost:${PORT}`);
  console.log(`Listening on: ${BIND_HOST}:${PORT}`);
  console.log(`Streaming Target: ${STREAM_TARGET}`);
  console.log(`Tailscale Address: http://<your-tailscale-ip>:${PORT}`);
  if (ACCESS_TOKEN) {
    console.log('Access control: enabled');
  } else {
    console.warn('Access control: DISABLED (set ARCADE_ACCESS_TOKEN before exposing this portal)');
  }
  console.log(`======================================================\n`);
});

// Manually bind the WebSocket upgrade handler to the proxy
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream') && isAuthenticated(req)) {
    streamProxy.upgrade(req, socket, head);
  } else {
    if (req.url.startsWith('/stream')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
  }
});
