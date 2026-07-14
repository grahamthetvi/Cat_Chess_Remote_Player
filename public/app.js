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

  let connected = false;
  let streamHealthy = false;
  let iframeLoadTimer = null;
  let usingConfiguredProxy = false;

  connectBtn.addEventListener('click', startConnection);
  quickStartBtn.addEventListener('click', startConnection);
  reconnectBtn.addEventListener('click', startConnection);
  disconnectBtn.addEventListener('click', stopConnection);
  hudDisconnect.addEventListener('click', stopConnection);
  hudReconnect.addEventListener('click', startConnection);
  hudFullscreen.addEventListener('click', toggleFullscreen);
  window.addEventListener('online', checkStreamHealth);
  window.addEventListener('offline', () => showFailure('Browser is offline', 'Reconnect to the network, then try again.'));
  window.addEventListener('beforeunload', cleanupStream);

  setDisconnected('Checking stream bridge…');
  checkStreamHealth();
  window.setInterval(checkStreamHealth, 30000);

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
      if (!connected) showFailure('Could not check stream bridge', 'The portal cannot reach its health endpoint. Try again shortly.');
    }
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
      // An external bridge can be cross-origin. Its document is intentionally
      // opaque to the portal, so only the load timeout can detect failure.
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
      ? 'Connect to open the embedded Moonlight stream.'
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
});
