import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createDesktopAuth } from './auth.mjs';
import { createDisplayReader } from './displays.mjs';

export const DESKTOP_BASE_PATH = '/desktop/session';
const COOKIE = '__Host-home_desktop';
const WEBSITE_ORIGINS = ['https://aaravsinha.dev', 'https://www.aaravsinha.dev'];
const TUNNEL_HOST = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
const MAX_BUFFER = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function reply(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(status === 204 ? '' : JSON.stringify(body));
}

function failure(res, status, code, message, headers) {
  reply(res, status, { error: { code, message } }, headers);
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

async function loginBody(req, timeoutMs) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error(), { status: 415 });
  }
  if (Number(req.headers['content-length']) > 2048) throw Object.assign(new Error(), { status: 413 });
  const raw = await new Promise((resolveBody, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', ended);
      req.off('error', failed);
      req.off('aborted', aborted);
      if (error) { req.once('error', () => {}); req.resume(); reject(error); }
      else resolveBody(Buffer.concat(chunks).toString('utf8'));
    }
    const data = chunk => {
      size += chunk.length;
      if (size > 2048) return finish(Object.assign(new Error(), { status: 413 }));
      chunks.push(chunk);
    };
    const ended = () => finish();
    const failed = () => finish(Object.assign(new Error(), { status: 400 }));
    const aborted = failed;
    const timer = setTimeout(() => finish(Object.assign(new Error(), { status: 408 })), timeoutMs);
    timer.unref();
    req.on('data', data);
    req.once('end', ended);
    req.once('error', failed);
    req.once('aborted', aborted);
  });
  let body;
  try { body = JSON.parse(raw); } catch { throw Object.assign(new Error(), { status: 400 }); }
  if (!body || Array.isArray(body) || typeof body.password !== 'string' || !body.password.length ||
      Buffer.byteLength(body.password) > 1024) {
    throw Object.assign(new Error(), { status: 400 });
  }
  return body;
}

/** Dedicated password-protected HTTP/WS gateway with a fixed local VNC target. */
export function createDesktopGateway(options = {}) {
  const configPath = options.configPath ?? process.env.HOME_DESKTOP_CONFIG ?? join(homedir(), 'Library', 'Application Support', 'aarav-home-desktop', 'config.json');
  const browserConfigPath = options.browserConfigPath ?? join(homedir(), 'Library', 'Application Support', 'aarav-home-browser', 'config.json');
  const now = options.now ?? Date.now;
  const auth = createDesktopAuth({ configPath });
  const readDisplays = createDisplayReader({ readRaw: options.readDisplaysForTests, now });
  const sessionTtlMs = Math.max(1, Math.min(options.sessionTtlMs ?? MAX_SESSION_MS, MAX_SESSION_MS));
  const bodyTimeoutMs = Math.max(1, Math.min(options.loginBodyTimeoutMs ?? 10_000, 10_000));
  const connectTimeoutMs = Math.max(1, Math.min(options.connectTimeoutMs ?? 2000, 2000));
  // The production destination is not configurable. Isolated tests may bind an
  // ephemeral local port without touching the Mac's actual Screen Sharing port.
  const vncPort = options.allowTestOverrides === true ? (options.testVncPort ?? 5900) : 5900;
  if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) throw new Error('Invalid desktop test port.');
  const sessions = new Map();
  const clients = new Set();
  const connectingVnc = new Set();
  const attempts = new Map();
  const ipLimit = options.ipLoginLimit ?? 8;
  const globalLimit = options.globalLoginLimit ?? 30;
  const ipWindow = options.ipWindowMs ?? 15 * 60 * 1000;
  const globalWindow = options.globalWindowMs ?? 60 * 1000;
  let globalAttempts = { count: 0, until: now() + globalWindow };
  let pendingLogins = 0;
  let closing = false;
  let readiness;
  let readinessPending;

  function requestContext(req) {
    let tunnel = null;
    try {
      // Browser credentials are never reused or returned by this gateway.
      const value = JSON.parse(readFileSync(browserConfigPath, 'utf8')).publicUrl;
      if (value) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !TUNNEL_HOST.test(url.hostname) || url.port ||
            url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        tunnel = url.origin;
      }
    } catch { return null; }
    const origins = new Set([...WEBSITE_ORIGINS, ...(tunnel ? [tunnel] : [])]);
    const host = req.headers.host;
    if (typeof host !== 'string' || /[\s,@/\\?#]/.test(host)) return null;
    const port = req.socket.localPort;
    const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const local = LOOPBACK.has(req.socket.remoteAddress) && localHosts.has(host.toLowerCase());
    const publicHost = [...origins].some(origin => new URL(origin).host === host.toLowerCase());
    if (!local && !publicHost) return null;
    if (local) origins.add(`http://${host.toLowerCase()}`);
    const forwarded = req.headers['x-forwarded-host'];
    if (forwarded !== undefined && (typeof forwarded !== 'string' || ![...origins].some(origin => new URL(origin).host === forwarded.toLowerCase()))) return null;
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return null;
    return { origins };
  }

  function route(req) {
    if (typeof req.url !== 'string') return null;
    // Hosting rewrites may append routing parameters. They never select a
    // destination or carry authentication here; only the raw pathname routes.
    const pathname = req.url.split('?', 1)[0];
    if (!pathname.startsWith(`${DESKTOP_BASE_PATH}/`) ||
        /[%\\#\u0000-\u0020\u007f]/.test(pathname)) return null;
    const suffix = pathname.slice(DESKTOP_BASE_PATH.length);
    return ['/auth/status', '/auth/login', '/auth/logout', '/health', '/websockify', '/displays'].includes(suffix) ? suffix : null;
  }

  function cookie(token, maxAge) {
    return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
  }

  function tokenFor(id, secret) {
    return `${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`;
  }

  function destroySession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    for (const close of session.connections) close(1008, 'Authentication required');
  }

  function getSession(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const id = token.split('.')[0];
    const session = sessions.get(id);
    if (!session) return null;
    const state = auth.state();
    if (state.fingerprint !== session.fingerprint || session.expiresAt <= now()) {
      destroySession(id);
      return null;
    }
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(tokenFor(id, state.sessionSecret)))) return null;
    return { id, session };
  }

  function checkRate(req) {
    const time = now();
    for (const [ip, record] of attempts) if (record.until <= time) attempts.delete(ip);
    if (globalAttempts.until <= time) globalAttempts = { count: 0, until: time + globalWindow };
    // Do not trust caller-supplied forwarding headers as a rate-limit identity.
    // The global limit also covers all requests passing through the local tunnel.
    const ip = req.socket.remoteAddress;
    const record = attempts.get(ip) ?? { count: 0, until: time + ipWindow };
    const limited = record.count >= ipLimit || globalAttempts.count >= globalLimit || pendingLogins >= 2 ||
      (!attempts.has(ip) && attempts.size >= 2048);
    if (limited) return Math.max(1, Math.ceil((Math.min(record.until, globalAttempts.until) - time) / 1000));
    record.count += 1;
    globalAttempts.count += 1;
    attempts.set(ip, record);
    return 0;
  }

  function connectVnc() {
    return new Promise((resolveVnc, reject) => {
      let settled = false;
      const socket = net.createConnection({ host: '127.0.0.1', port: vncPort });
      connectingVnc.add(socket);
      socket.setNoDelay(true);
      socket.pause();
      const timer = setTimeout(() => socket.destroy(new Error('Desktop unavailable.')), connectTimeoutMs);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); connectingVnc.delete(socket); };
      socket.once('connect', () => { settled = true; cleanup(); resolveVnc(socket); });
      socket.once('error', error => { settled = true; cleanup(); reject(error); });
      socket.once('close', () => { cleanup(); if (!settled) reject(new Error('Desktop unavailable.')); });
    });
  }

  async function desktopAvailable() {
    if (readiness && readiness.until > now()) return readiness.available;
    if (readinessPending) return readinessPending;
    readinessPending = (async () => {
      let available = false;
      try { const socket = await connectVnc(); socket.destroy(); available = true; } catch {}
      readiness = { available, until: now() + 1000 };
      return available;
    })();
    try { return await readinessPending; } finally { readinessPending = null; }
  }

  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  function bridge(ws, tcp, record) {
    let ended = false;
    let terminateTimer;
    const close = (code = 1011, reason = 'Desktop connection closed') => {
      if (ended) return;
      ended = true;
      record.connections.delete(close);
      tcp.destroy();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
        terminateTimer = setTimeout(() => ws.terminate(), 500);
        terminateTimer.unref();
      } else ws.terminate();
    };
    record.connections.add(close);
    ws.on('error', () => close());
    ws.on('close', () => { clearTimeout(terminateTimer); close(); });
    tcp.on('error', () => close());
    tcp.on('close', () => close());
    tcp.on('end', () => close(1000, 'Desktop connection closed'));
    ws.on('message', (data, binary) => {
      if (ended) return;
      if (!binary) return close(1003, 'Binary messages required');
      if (tcp.writableLength + data.length > MAX_BUFFER) return close(1009, 'Desktop connection overloaded');
      if (!tcp.write(data)) ws.pause();
    });
    tcp.on('drain', () => { if (!ended && ws.readyState === WebSocket.OPEN) ws.resume(); });
    tcp.on('data', chunk => {
      if (ended || ws.readyState !== WebSocket.OPEN) return close();
      tcp.pause();
      if (ws.bufferedAmount + chunk.length > MAX_BUFFER) return close(1009, 'Desktop connection overloaded');
      ws.send(chunk, { binary: true }, error => {
        if (error) close();
        else if (!ended && ws.readyState === WebSocket.OPEN) tcp.resume();
      });
    });
    tcp.resume();
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 15_000 }, async (req, res) => {
    try {
      if (closing) return failure(res, 503, 'unavailable', 'Desktop gateway is unavailable.');
      const ctx = requestContext(req);
      if (!ctx) return failure(res, 403, 'request_denied', 'Desktop request denied.');
      const path = route(req);
      if (!path) return failure(res, 404, 'not_found', 'Not found.');
      if (req.method === 'OPTIONS') {
        if (!ctx.origins.has(req.headers.origin)) return failure(res, 403, 'request_denied', 'Desktop request denied.');
        return reply(res, 204, null, { Allow: 'GET, POST, OPTIONS' });
      }
      if (req.method === 'POST' && !ctx.origins.has(req.headers.origin)) return failure(res, 403, 'request_denied', 'Desktop request denied.');
      if (path === '/auth/status' && req.method === 'GET') {
        auth.state(); // Invalid private configuration must fail closed even without a cookie.
        return reply(res, 200, { authenticated: Boolean(getSession(req)), desktopAvailable: await desktopAvailable() });
      }
      if (path === '/health' && req.method === 'GET') {
        const available = await desktopAvailable();
        return reply(res, available ? 200 : 503, { status: available ? 'ready' : 'unavailable', desktopAvailable: available });
      }
      if (path === '/displays' && req.method === 'GET') {
        const authenticated = getSession(req);
        if (!authenticated) return failure(res, 401, 'authentication_required', 'Authentication required.');
        const displays = await readDisplays();
        // A logout, expiry, or credential rotation during the native query also
        // revokes access to its result, including an otherwise valid cache hit.
        if (getSession(req)?.id !== authenticated.id) return failure(res, 401, 'authentication_required', 'Authentication required.');
        return reply(res, 200, displays);
      }
      if (path === '/auth/login' && req.method === 'POST') {
        const retryAfter = checkRate(req);
        if (retryAfter) return failure(res, 429, 'rate_limited', 'Too many attempts. Try again later.', { 'Retry-After': String(retryAfter), Connection: 'close' });
        pendingLogins += 1;
        try {
          const body = await loginBody(req, bodyTimeoutMs);
          if (sessions.size >= 64) return failure(res, 503, 'unavailable', 'Desktop gateway is unavailable.');
          const state = await auth.authenticate(body.password);
          if (!state) return failure(res, 401, 'invalid_credentials', 'Password was not accepted.');
          if (closing || res.destroyed) return failure(res, 503, 'unavailable', 'Desktop gateway is unavailable.');
          const previous = getSession(req);
          if (previous) destroySession(previous.id);
          const id = randomBytes(32).toString('base64url');
          const timer = setTimeout(() => destroySession(id), sessionTtlMs);
          timer.unref();
          sessions.set(id, { fingerprint: state.fingerprint, expiresAt: now() + sessionTtlMs, timer, connections: new Set(), pendingConnections: 0 });
          return reply(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(tokenFor(id, state.sessionSecret), Math.ceil(sessionTtlMs / 1000)) });
        } catch (error) {
          return failure(res, error.status ?? 503, error.status ? 'invalid_request' : 'unavailable', error.status ? 'Invalid login request.' : 'Desktop authentication is temporarily unavailable.', { Connection: 'close' });
        } finally { pendingLogins -= 1; }
      }
      if (path === '/auth/logout' && req.method === 'POST') {
        const session = getSession(req);
        if (session) destroySession(session.id);
        return reply(res, 200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
      }
      return failure(res, 405, 'method_not_allowed', 'Method not allowed.');
    } catch { failure(res, 503, 'unavailable', 'Desktop gateway is unavailable.'); }
  });

  server.on('upgrade', async (req, socket, head) => {
    let tcp;
    let reservation;
    try {
      const ctx = requestContext(req);
      if (closing || !ctx || !ctx.origins.has(req.headers.origin) || route(req) !== '/websockify' || req.method !== 'GET') return rejectUpgrade(socket, 403);
      const authenticated = getSession(req);
      if (!authenticated) return rejectUpgrade(socket, 401);
      if (authenticated.session.connections.size + authenticated.session.pendingConnections >= 2 || connectingVnc.size >= 16) return rejectUpgrade(socket, 429);
      reservation = authenticated.session;
      reservation.pendingConnections += 1;
      tcp = await connectVnc();
      if (socket.destroyed || closing) { tcp.destroy(); return; }
      if (getSession(req)?.id !== authenticated.id) { tcp.destroy(); return rejectUpgrade(socket, 401); }
      socket.once('close', () => tcp.destroy());
      let upgraded = false;
      // No async verifyClient is configured: rejected handshakes return without
      // invoking this callback, so their paused VNC socket must be closed here.
      wss.handleUpgrade(req, socket, head, ws => {
        upgraded = true;
        bridge(ws, tcp, authenticated.session);
      });
      if (!upgraded) tcp.destroy();
    } catch { tcp?.destroy(); rejectUpgrade(socket, 503); }
    finally { if (reservation) reservation.pendingConnections -= 1; }
  });
  server.on('connection', socket => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
  });
  server.on('connect', (_req, socket) => rejectUpgrade(socket, 403));
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400));

  const sweep = setInterval(() => {
    let state;
    try { state = auth.state(); } catch {}
    for (const [id, session] of sessions) {
      if (!state || state.fingerprint !== session.fingerprint || session.expiresAt <= now()) destroySession(id);
    }
  }, 1000);
  sweep.unref();
  server.once('close', () => clearInterval(sweep));
  server.port = Number(options.port ?? process.env.HOME_DESKTOP_PORT ?? 3083);
  server.closeGateway = async () => {
    closing = true;
    clearInterval(sweep);
    for (const id of sessions.keys()) destroySession(id);
    for (const socket of connectingVnc) socket.destroy();
    for (const socket of clients) socket.destroy();
    wss.close();
    await new Promise((done, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()));
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createDesktopGateway();
    server.on('error', () => { console.error('Desktop gateway could not start.'); process.exitCode = 1; });
    server.listen(server.port, '127.0.0.1', () => console.log(`Desktop gateway listening on 127.0.0.1:${server.port}`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
      await server.closeGateway();
      process.exit(0);
    });
  } catch { console.error('Desktop gateway configuration is missing, invalid, or not private.'); process.exitCode = 1; }
}
