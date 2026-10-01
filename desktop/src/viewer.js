import RFB from './display-rfb.js';

const $ = id => document.getElementById(id);
const base = '/desktop/session';
let rfb, reconnectTimer, active = true, connected = false, credentials = null, commandHeld = false, generation = 0;
let retryDelay = 1500;
let displayLayout = null;
let preferredDisplay = null;
try { preferredDisplay = localStorage.getItem('home-desktop.display'); } catch {}
function displayControls() {
  const state = rfb?.displayState;
  const ready = connected && state?.ready;
  $('previous-display').disabled = $('next-display').disabled = !ready || state.displays.length < 2;
  const selected = ready ? state.displays[state.index] : null;
  $('display-label').textContent = selected ? `Screen ${state.index + 1} of ${state.displays.length}` : 'Displays';
  $('display-switch').title = selected?.name || (connected ? 'Checking display layout…' : 'Connect to switch displays');
  if (selected) {
    preferredDisplay = selected.id;
    try { localStorage.setItem('home-desktop.display', selected.id); } catch {}
  }
}
function changeDisplay(direction) {
  const state = rfb?.displayState;
  if (!connected || !state?.ready || state.displays.length < 2) return;
  releaseCommand();
  const index = (state.index + direction + state.displays.length) % state.displays.length;
  rfb.selectDisplay(state.displays[index].id);
  displayControls();
  rfb.focus();
}
async function refreshDisplays(client = rfb) {
  if (!client) return;
  try {
    const layout = await api('/displays');
    if (client !== rfb) return;
    displayLayout = layout;
    const savedDisplay = preferredDisplay;
    client.setDisplayLayout(layout);
    if (savedDisplay) client.selectDisplay(savedDisplay);
    displayControls();
  } catch {
    // A temporary metadata failure keeps the currently selected screen.
  }
}
const status = text => { $('status').textContent = text; };
function panel(heading, message, form = null) {
  $('panel').hidden = false;
  $('heading').textContent = heading;
  $('message').textContent = message;
  $('login').hidden = form !== 'login';
  $('mac-login').hidden = form !== 'mac-login';
  $('error').textContent = '';
}
async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(12000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'The home connection is temporarily unavailable.');
  return result;
}
function releaseCommand() {
  if (commandHeld && rfb) rfb.sendKey(0xffeb, 'MetaLeft', false);
  commandHeld = false;
  $('command').setAttribute('aria-pressed', 'false');
}
function disconnect() {
  clearTimeout(reconnectTimer);
  generation++;
  releaseCommand();
  connected = false;
  $('command').disabled = true;
  if (rfb) { const previous = rfb; rfb = null; previous.disconnect(); }
  displayControls();
}
function retry() {
  if (!active) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(check, retryDelay);
  retryDelay = Math.min(retryDelay * 1.5, 15000);
}
async function check() {
  if (!active || rfb) return;
  const run = generation;
  status('Connecting…');
  try {
    const state = await api('/auth/status');
    if (!active || run !== generation) return;
    $('lock').disabled = !state.authenticated;
    if (!state.authenticated) {
      credentials = null;
      status('Locked');
      panel('Unlock your desktop.', 'Enter your website password to connect to your Mac.', 'login');
      return;
    }
    if (!state.desktopAvailable) {
      status('Screen sharing is off');
      panel('Your Mac is online.', 'Turn on Screen Sharing in System Settings → General → Sharing, with access limited to your Mac account.');
      retry(); return;
    }
    try { displayLayout = await api('/displays'); } catch { displayLayout = null; }
    if (!active || run !== generation) return;
    connect();
  } catch {
    if (!active || run !== generation) return;
    status('Reconnecting…');
    panel('Waiting for your Mac.', 'The connection will retry automatically. Your apps and windows stay open.');
    retry();
  }
}
function connect() {
  const run = ++generation;
  panel('Connecting to your Mac…', 'Your desktop will appear here shortly.');
  const ws = new URL(`${base}/websockify`, location.origin);
  ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new RFB($('screen'), ws.href, {shared: true, ...(credentials ? {credentials} : {})});
  rfb = client;
  client.scaleViewport = $('fit').getAttribute('aria-pressed') === 'true';
  client.resizeSession = false;
  client.qualityLevel = 5;
  client.compressionLevel = 2;
  client.background = '#090c12';
  client.addEventListener('displaychange', () => { if (run === generation) displayControls(); });
  if (displayLayout) client.setDisplayLayout(displayLayout);
  if (preferredDisplay) client.selectDisplay(preferredDisplay);
  client.addEventListener('connect', () => {
    if (run !== generation) return;
    connected = true; retryDelay = 1500;
    $('panel').hidden = true;
    $('command').disabled = false;
    status('Connected to your Mac');
    displayControls();
    if (!displayLayout) refreshDisplays(client);
    client.focus();
  });
  client.addEventListener('credentialsrequired', event => {
    if (run !== generation) return;
    const needsUser = event.detail.types.includes('username');
    $('username').hidden = $('username-label').hidden = !needsUser;
    panel('Sign in to your Mac.', 'Use the account that is allowed in your Mac’s Screen Sharing settings.', 'mac-login');
    $('mac-password').focus();
  });
  client.addEventListener('securityfailure', () => {
    if (run !== generation) return;
    credentials = null; active = false;
    status('Mac sign-in failed');
    panel('Check your Mac sign-in.', 'Verify your Mac username and password, then select Reconnect to try again.');
  });
  client.addEventListener('disconnect', () => {
    if (run !== generation) return;
    rfb = null; connected = false; commandHeld = false;
    displayControls();
    $('command').disabled = true;
    $('command').setAttribute('aria-pressed', 'false');
    if (!active) return;
    status('Reconnecting…');
    panel('Reconnecting to your Mac…', 'Your apps and windows remain open.');
    retry();
  });
}
$('login').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  $('error').textContent = '';
  try {
    await api('/auth/login', {password: $('password').value});
    $('password').value = '';
    active = true; retryDelay = 1500; await check();
  } catch (error) { $('error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('mac-login').addEventListener('submit', event => {
  event.preventDefault();
  if (!rfb) return;
  credentials = {username: $('username').value, password: $('mac-password').value};
  rfb.sendCredentials(credentials);
  $('mac-password').value = '';
  panel('Connecting to your Mac…', 'Signing in to Screen Sharing.');
});
$('lock').addEventListener('click', async () => {
  active = false; disconnect(); credentials = null;
  $('lock').disabled = true;
  status('Locking…');
  panel('Locking the viewer…', 'Your Mac apps will remain open.');
  try { await api('/auth/logout', {}); active = true; await check(); }
  catch { status('Disconnected'); panel('Viewer disconnected.', 'Could not confirm logout. Select Lock viewer again when the connection returns.'); $('lock').disabled = false; }
});
$('reconnect').addEventListener('click', () => { disconnect(); active = true; retryDelay = 1500; check(); });
$('previous-display').addEventListener('click', () => changeDisplay(-1));
$('next-display').addEventListener('click', () => changeDisplay(1));
$('fit').addEventListener('click', () => { const fit = $('fit').getAttribute('aria-pressed') !== 'true'; $('fit').setAttribute('aria-pressed', String(fit)); if (rfb) rfb.scaleViewport = fit; });
$('command').addEventListener('click', () => {
  if (!connected || !rfb) return;
  commandHeld = !commandHeld;
  rfb.sendKey(0xffeb, 'MetaLeft', commandHeld);
  $('command').setAttribute('aria-pressed', String(commandHeld)); rfb.focus();
});
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { status('Fullscreen is unavailable in this browser'); } });
window.addEventListener('blur', releaseCommand);
window.addEventListener('pagehide', () => { active = false; disconnect(); credentials = null; });
window.addEventListener('pageshow', event => { if (event.persisted) { active = true; check(); } });
setInterval(() => { if (connected) refreshDisplays(); }, 15000);
window.addEventListener('online', () => { if (active && !rfb) { clearTimeout(reconnectTimer); check(); } });
check();
