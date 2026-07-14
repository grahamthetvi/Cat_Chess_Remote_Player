/**
 * Addison & Elizabeth's Cozy Arcade - Frontend Controller (app.js)
 */

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const connectBtn = document.getElementById('connect-btn');
  const disconnectBtn = document.getElementById('disconnect-btn');
  const quickStartBtn = document.getElementById('quick-start-btn');
  const reconnectBtn = document.getElementById('overlay-reconnect-btn');
  const mobileConnectBtn = document.getElementById('mobile-connect-btn');
  const bridgeUrlInput = document.getElementById('bridge-url');
  const mainGameContainer = document.getElementById('main-game-container');
  const streamOverlay = document.getElementById('stream-overlay');
  const overlayIcon = document.getElementById('overlay-icon');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayMessage = document.getElementById('overlay-message');
  const iframeContainer = document.getElementById('iframe-container');
  const streamIframe = document.getElementById('stream-iframe');
  const hudControls = document.getElementById('hud-controls');
  const hudReconnect = document.getElementById('hud-reconnect');
  const hudFullscreen = document.getElementById('hud-fullscreen');
  const hudDisconnect = document.getElementById('hud-disconnect');
  const streamHealth = document.getElementById('stream-health');
  const streamHealthDetail = document.getElementById('stream-health-detail');
  const gameStatus = document.getElementById('game-status');
  const presencePill = document.getElementById('presence-pill');
  const youAre = document.getElementById('you-are');
  const coopChecklist = document.getElementById('coop-checklist');
  const launchGameBtn = document.getElementById('launch-game-btn');
  const inviteBtn = document.getElementById('invite-btn');
  const actionFeedback = document.getElementById('action-feedback');
  const sessionNote = document.getElementById('session-note');
  const saveNoteBtn = document.getElementById('save-note-btn');
  const noteMeta = document.getElementById('note-meta');
  const qosGuidance = document.getElementById('qos-guidance');
  const openNewTabLink = document.getElementById('open-new-tab-link');

  const QOS_PRESETS = {
    smooth: 'Smooth: 720p, 30–40 FPS, lower bitrate — best on weak hotel Wi‑Fi.',
    balanced: 'Balanced: 1080p, 40–60 FPS, medium bitrate — default home Wi‑Fi / Tailscale.',
    pretty: 'Pretty: 1080p, 60 FPS, higher bitrate — use on a strong LAN or fast tailnet link.'
  };

  let connected = false;
  let streamHealthy = false;
  let gameRunning = false;
  let iframeLoadTimer = null;
  let usingConfiguredProxy = false;
  let currentName = null;

  if (document.documentElement.classList.contains('embed-mode')) {
    openNewTabLink.href = '/play';
  } else {
    openNewTabLink.classList.add('hidden');
  }

  connectBtn.addEventListener('click', startConnection);
  quickStartBtn.addEventListener('click', startConnection);
  reconnectBtn.addEventListener('click', startConnection);
  mobileConnectBtn.addEventListener('click', startConnection);
  disconnectBtn.addEventListener('click', stopConnection);
  hudDisconnect.addEventListener('click', stopConnection);
  hudReconnect.addEventListener('click', startConnection);
  hudFullscreen.addEventListener('click', toggleFullscreen);
  launchGameBtn.addEventListener('click', launchGame);
  inviteBtn.addEventListener('click', sendInvite);
  saveNoteBtn.addEventListener('click', saveNote);
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', () => showFailure('Browser is offline', 'Reconnect to the network, then try again.'));
  window.addEventListener('beforeunload', cleanupStream);

  document.querySelectorAll('[data-switch-name]').forEach((button) => {
    button.addEventListener('click', () => switchIdentity(button.getAttribute('data-switch-name')));
  });

  document.querySelectorAll('.qos-btn').forEach((button) => {
    button.addEventListener('click', () => selectQosPreset(button.getAttribute('data-preset')));
  });

  const savedQos = localStorage.getItem('arcadeQosPreset') || 'balanced';
  selectQosPreset(savedQos, false);

  setDisconnected('Checking stream bridge…');
  refreshStatus();
  loadNote();
  window.setInterval(refreshStatus, 20000);
  window.setInterval(sendPresence, 20000);

  async function refreshStatus() {
    await Promise.all([
      checkStreamHealth(),
      checkGameStatus(),
      checkCoopStatus(),
      sendPresence()
    ]);
  }

  async function checkStreamHealth() {
    try {
      const response = await fetch('/api/stream-status', { cache: 'no-store' });
      const status = await response.json();
      streamHealthy = Boolean(status.available);
      streamHealth.textContent = streamHealthy
        ? `Reachable (${status.latencyMs} ms)`
        : 'Unavailable';
      streamHealth.classList.toggle('text-success', streamHealthy);
      streamHealth.classList.toggle('text-error', !streamHealthy);
      streamHealthDetail.textContent = streamHealthy
        ? `HTTP ${status.statusCode} • ${new Date(status.checkedAt).toLocaleTimeString()}`
        : (status.error || 'No response');

      if (!streamHealthy && usingConfiguredProxy) {
        showFailure('Stream bridge is unavailable', 'Start Sunshine and moonlight-web-stream, then try again.');
      } else if (streamHealthy && !connected) {
        setDisconnected('Stream bridge ready');
      }
    } catch (error) {
      streamHealthy = false;
      streamHealth.textContent = 'Status check failed';
      streamHealth.classList.remove('text-success');
      streamHealth.classList.add('text-error');
      streamHealthDetail.textContent = error.message;
      if (!connected) {
        showFailure('Could not check stream bridge', 'The portal cannot reach its health endpoint. Try again shortly.');
      }
    }
  }

  async function checkGameStatus() {
    try {
      const response = await fetch('/api/game-status', { cache: 'no-store' });
      const status = await response.json();
      gameRunning = Boolean(status.running);
      if (!status.configured) {
        gameStatus.textContent = 'Not configured';
        gameStatus.classList.add('text-error');
        gameStatus.classList.remove('text-success');
      } else {
        gameStatus.textContent = gameRunning ? 'Running' : 'Not running';
        gameStatus.classList.toggle('text-success', gameRunning);
        gameStatus.classList.toggle('text-error', !gameRunning);
      }
    } catch (error) {
      gameStatus.textContent = 'Unknown';
      gameStatus.classList.remove('text-success');
      gameStatus.classList.add('text-error');
    }
  }

  async function checkCoopStatus() {
    try {
      const response = await fetch('/api/coop-status', { cache: 'no-store' });
      if (!response.ok) return;
      const status = await response.json();
      currentName = status.you;
      youAre.textContent = currentName ? `Signed in as ${currentName}` : 'Signed in';
      updateChecklist(status);
      renderPresence(status.presence || []);
    } catch {
      // Presence is best-effort.
    }
  }

  async function sendPresence() {
    try {
      const response = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (!response.ok) return;
      const data = await response.json();
      currentName = data.you || currentName;
      renderPresence(data.people || []);
    } catch {
      // Ignore transient presence failures.
    }
  }

  function renderPresence(people) {
    if (!people.length) {
      presencePill.textContent = currentName ? `${currentName} here` : 'Nobody else here yet';
      return;
    }
    presencePill.textContent = people.map((person) => `${person.name} here`).join(' · ');
  }

  function updateChecklist(status) {
    const states = {
      unlocked: true,
      bridge: Boolean(status.bridgeHealthy),
      game: Boolean(status.gameRunning),
      both: Boolean(status.bothPresent)
    };
    coopChecklist.querySelectorAll('[data-check]').forEach((item) => {
      const key = item.getAttribute('data-check');
      item.classList.toggle('ready', Boolean(states[key]));
    });
  }

  async function startConnection() {
    const targetUrl = bridgeUrlInput.value.trim() || '/stream/';
    const usesConfiguredProxy = targetUrl === '/stream' || targetUrl.startsWith('/stream/');
    if (usesConfiguredProxy) {
      await checkStreamHealth();
      if (!streamHealthy) return;
    }

    cleanupStream();
    connected = true;
    usingConfiguredProxy = usesConfiguredProxy;
    iframeContainer.classList.remove('hidden');
    streamOverlay.classList.remove('hidden');
    overlayIcon.textContent = '⌛';
    overlayTitle.textContent = 'Loading stream…';
    overlayMessage.textContent = 'Waiting for the Moonlight page to respond.';
    quickStartBtn.classList.add('hidden');
    reconnectBtn.classList.add('hidden');
    setConnectionControls(true, 'Connecting to stream…');

    streamIframe.onload = () => {
      window.clearTimeout(iframeLoadTimer);
      if (!connected) return;
      if (iframeLooksLikeProxyError()) {
        showFailure('Stream bridge returned an error', 'moonlight-web-stream could not serve the stream page. Verify the service, then reconnect.');
        return;
      }
      streamOverlay.classList.add('hidden');
      setConnectionControls(true, 'Stream page loaded');
    };
    streamIframe.onerror = () => showFailure('Stream page failed to load', 'Check the bridge address, then reconnect.');
    iframeLoadTimer = window.setTimeout(() => {
      showFailure('Stream page timed out', 'moonlight-web-stream did not load within 15 seconds. Verify it is running and reconnect.');
    }, 15000);
    streamIframe.src = targetUrl;
  }

  function stopConnection() {
    cleanupStream();
    connected = false;
    usingConfiguredProxy = false;
    setDisconnected('Disconnected');
  }

  function cleanupStream() {
    window.clearTimeout(iframeLoadTimer);
    iframeLoadTimer = null;
    streamIframe.onload = null;
    streamIframe.onerror = null;
    streamIframe.src = 'about:blank';
  }

  function iframeLooksLikeProxyError() {
    try {
      return streamIframe.contentDocument?.title === 'Arcade Service Unavailable';
    } catch {
      return false;
    }
  }

  function showFailure(title, message) {
    cleanupStream();
    connected = false;
    usingConfiguredProxy = false;
    iframeContainer.classList.add('hidden');
    streamOverlay.classList.remove('hidden');
    overlayIcon.textContent = '⚠️';
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    quickStartBtn.classList.add('hidden');
    reconnectBtn.classList.remove('hidden');
    setConnectionControls(false, title);
  }

  function setDisconnected(message) {
    iframeContainer.classList.add('hidden');
    streamOverlay.classList.remove('hidden');
    overlayIcon.textContent = '🎮😸';
    overlayTitle.textContent = streamHealthy ? 'Ready to Play?' : 'Checking stream bridge…';
    overlayMessage.textContent = streamHealthy
      ? 'Connect to open the embedded Moonlight stream. Both of you can join for split-screen.'
      : 'The portal is verifying that moonlight-web-stream is reachable.';
    quickStartBtn.classList.toggle('hidden', !streamHealthy);
    reconnectBtn.classList.toggle('hidden', streamHealthy);
    setConnectionControls(false, message);
  }

  function setConnectionControls(isConnected, message) {
    statusDot.className = `pulse-indicator ${isConnected ? 'status-online' : 'status-offline'}`;
    statusText.textContent = message;
    statusText.style.color = isConnected ? 'var(--status-online)' : 'var(--text-muted)';
    connectBtn.classList.toggle('hidden', isConnected);
    disconnectBtn.classList.toggle('hidden', !isConnected);
    hudControls.classList.toggle('hidden', !isConnected);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await mainGameContainer.requestFullscreen();
      }
    } catch (error) {
      console.error('[Cozy Arcade] Fullscreen failed:', error);
    }
  }

  async function launchGame() {
    setFeedback('Starting Cat Chess…');
    try {
      const response = await fetch('/api/launch-game', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setFeedback(result.error || 'Could not launch the game.');
        return;
      }
      setFeedback(result.message || 'Game ready.');
      await checkGameStatus();
      await checkCoopStatus();
    } catch (error) {
      setFeedback(error.message);
    }
  }

  async function sendInvite() {
    setFeedback('Sending Discord invite…');
    try {
      const response = await fetch('/api/notify/invite', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) {
        setFeedback(result.error || 'Invite failed.');
        return;
      }
      setFeedback('Invite sent.');
    } catch (error) {
      setFeedback(error.message);
    }
  }

  async function loadNote() {
    try {
      const response = await fetch('/api/notes', { cache: 'no-store' });
      if (!response.ok) return;
      const note = await response.json();
      sessionNote.value = note.text || '';
      noteMeta.textContent = note.updatedAt
        ? `Last edited by ${note.lastEditor || 'unknown'} · ${new Date(note.updatedAt).toLocaleString()}`
        : 'Not saved yet';
    } catch {
      noteMeta.textContent = 'Could not load note';
    }
  }

  async function saveNote() {
    try {
      const response = await fetch('/api/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sessionNote.value })
      });
      const note = await response.json();
      if (!response.ok) {
        setFeedback(note.error || 'Could not save note.');
        return;
      }
      noteMeta.textContent = `Last edited by ${note.lastEditor} · ${new Date(note.updatedAt).toLocaleString()}`;
      setFeedback('Note saved.');
    } catch (error) {
      setFeedback(error.message);
    }
  }

  async function switchIdentity(displayName) {
    try {
      const response = await fetch('/api/identity/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName })
      });
      const result = await response.json();
      if (!response.ok) {
        setFeedback(result.error || 'Could not switch identity.');
        return;
      }
      currentName = result.name;
      youAre.textContent = `Signed in as ${currentName}`;
      setFeedback(`Now playing as ${currentName}.`);
      await sendPresence();
      await checkCoopStatus();
    } catch (error) {
      setFeedback(error.message);
    }
  }

  function selectQosPreset(preset, persist = true) {
    if (!QOS_PRESETS[preset]) return;
    document.querySelectorAll('.qos-btn').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-preset') === preset);
    });
    qosGuidance.textContent = QOS_PRESETS[preset];
    if (persist) {
      localStorage.setItem('arcadeQosPreset', preset);
    }
  }

  function setFeedback(message) {
    actionFeedback.textContent = message;
  }
});
