(() => {
  'use strict';

  // The server relay discovers the home browser. The viewer stays on this site.
  const SESSION_BASE = '/browser/session';
  const FETCH_TIMEOUT = 12000;
  const POLL_INTERVAL = 30000;
  const el = (id) => document.getElementById(id);
  const frame = el('remote-browser');
  const screen = el('connection-screen');
  const reconnectButton = el('reconnect');
  const retryButton = el('retry');
  const lockButton = el('lock');
  const directLink = el('open-directly');
  const fullscreenButton = el('fullscreen');
  let attempt = 0;
  let connecting = false;
  let loaded = false;
  let failedHealthChecks = 0;
  let pollTimer;
  let frameTimer;
  let noticeTimer;

  function setStatus(label, state) {
    el('status-label').textContent = label;
    el('connection-status').dataset.state = state;
  }

  function showScreen(title, description, { loading = false, retry = false } = {}) {
    el('screen-title').textContent = title;
    el('screen-description').textContent = description;
    el('loading-indicator').hidden = !loading;
    retryButton.hidden = !retry;
    screen.hidden = false;
    frame.hidden = true;
    el('workspace').setAttribute('aria-busy', String(loading));
  }

  function showNotice(message) {
    clearTimeout(noticeTimer);
    el('connection-notice').textContent = message;
    el('connection-notice').hidden = false;
    noticeTimer = setTimeout(() => { el('connection-notice').hidden = true; }, 14000);
  }

  async function fetchJSON(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        cache: 'no-store', credentials: 'same-origin', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Service unavailable');
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkHealth() {
    // Reachability does not guarantee that the remote browser's video stream works.
    const health = await fetchJSON(`${SESSION_BASE}/auth/health`);
    if (health.status !== 'ready') throw new Error('Home browser is not ready');
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, POLL_INTERVAL);
  }

  function showOffline() {
    setStatus('Home server offline', 'offline');
    showScreen('No connection to home.', 'Make sure your home computer is awake and the home browser service is running. This page will try again automatically.', { retry: true });
  }

  async function poll() {
    if (document.hidden || connecting) {
      schedulePoll();
      return;
    }
    if (!loaded) {
      await connect();
      return;
    }
    const checkedAttempt = attempt;
    try {
      await checkHealth();
      if (checkedAttempt !== attempt) return;
      failedHealthChecks = 0;
      setStatus('Home server online', 'online');
    } catch {
      if (checkedAttempt !== attempt) return;
      failedHealthChecks += 1;
      setStatus('Checking connection…', 'loading');
      if (failedHealthChecks >= 2) {
        loaded = false;
        showOffline();
      }
    } finally {
      if (checkedAttempt === attempt) schedulePoll();
    }
  }

  async function connect() {
    if (connecting) return;
    const currentAttempt = ++attempt;
    connecting = true;
    loaded = false;
    directLink.hidden = true;
    directLink.removeAttribute('href');
    lockButton.hidden = true;
    failedHealthChecks = 0;
    clearTimeout(pollTimer);
    clearTimeout(frameTimer);
    el('connection-notice').hidden = true;
    reconnectButton.disabled = true;
    retryButton.disabled = true;
    setStatus('Connecting to home…', 'loading');
    showScreen('Your browser, back home.', 'Connecting to your saved browser session.', { loading: true });

    try {
      await checkHealth();
      if (currentAttempt !== attempt) return;
      directLink.href = `${SESSION_BASE}/`;
      directLink.hidden = false;
      lockButton.hidden = false;
      el('screen-description').textContent = 'Opening a private browser through your home internet.';

      // Install this handler only after the health check; an initial about:blank load
      // must not count as a response from the home server.
      frame.onload = () => {
        if (currentAttempt !== attempt) return;
        clearTimeout(frameTimer);
        loaded = true;
        connecting = false;
        reconnectButton.disabled = false;
        retryButton.disabled = false;
        screen.hidden = true;
        frame.hidden = false;
        el('workspace').setAttribute('aria-busy', 'false');
        setStatus('Home server online', 'online');
        schedulePoll();
      };
      frame.hidden = false;
      frame.src = `${SESSION_BASE}/`;
      frameTimer = setTimeout(() => {
        if (currentAttempt !== attempt || loaded) return;
        connecting = false;
        reconnectButton.disabled = false;
        retryButton.disabled = false;
        setStatus('Browser taking longer', 'offline');
        showScreen('Still waiting for your browser.', 'Try reconnecting, or choose Open session above to use a separate tab.', { retry: true });
        schedulePoll();
      }, 25000);
    } catch {
      if (currentAttempt !== attempt) return;
      connecting = false;
      reconnectButton.disabled = false;
      retryButton.disabled = false;
      showOffline();
      schedulePoll();
    }
  }

  reconnectButton.addEventListener('click', connect);
  retryButton.addEventListener('click', connect);
  lockButton.addEventListener('click', async () => {
    if (lockButton.disabled) return;
    const lockingAttempt = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    lockButton.disabled = true;
    try {
      const response = await fetch(`${SESSION_BASE}/auth/logout`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Could not lock browser');
      if (attempt === lockingAttempt) frame.src = `${SESSION_BASE}/`;
      setStatus('Browser locked', 'online');
      showNotice('Browser locked. Sign in again to continue.');
    } catch {
      showNotice('Could not confirm that the browser is locked. Choose Open session and sign out there, or try Lock again.');
    } finally {
      clearTimeout(timeout);
      lockButton.disabled = false;
    }
  });

  if (document.fullscreenEnabled) {
    fullscreenButton.hidden = false;
    fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await el('browser-shell').requestFullscreen();
      } catch {
        showNotice('Full screen is unavailable. You can use Open session for a separate browser tab.');
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const fullscreen = Boolean(document.fullscreenElement);
      el('fullscreen-label').textContent = fullscreen ? 'Exit full screen' : 'Full screen';
      fullscreenButton.title = fullscreen ? 'Exit full screen' : 'Enter full screen';
      fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
    });
  }

  window.addEventListener('online', () => { if (!loaded) connect(); });
  window.addEventListener('offline', () => {
    setStatus('Your device is offline', 'offline');
    showNotice('Your device is offline. Reconnect to the internet to reach your home browser.');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !connecting) {
      clearTimeout(pollTimer);
      poll();
    }
  });

  connect();
})();
