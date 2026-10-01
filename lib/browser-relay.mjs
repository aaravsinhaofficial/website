import http from 'node:http';
import https from 'node:https';
import { createProxyServer } from 'http-proxy-3';

export const BROWSER_BASE_PATH = '/browser/session';
const WEBSITE_ORIGINS = ['https://aaravsinha.dev', 'https://www.aaravsinha.dev'];
const DISCOVERY_PATH = '/aaravsinhaofficial/cb2150b8e06a3f800b4a050874ba063b/raw/connection.json';
const TUNNEL_HOST = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
const SESSION_COOKIE = '__Host-home_browser';
const RELAY_PATH_QUERY = '__browser_relay_path';
const requestContext = Symbol('browserRelayContext');

function validateTarget(value, allowLoopbackForTests = false) {
  const url = new URL(value);
  const loopback = allowLoopbackForTests && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!loopback && (url.protocol !== 'https:' || !TUNNEL_HOST.test(url.hostname) || url.port)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid browser endpoint.');
  }
  return url.origin;
}

/** The only network-discovered destination is this repository's own Gist. */
export function createTargetResolver({ discoveryUrl, fetchImpl = fetch, now = Date.now, cacheMs = 15_000 } = {}) {
  const discovery = new URL(discoveryUrl);
  if (discovery.protocol !== 'https:' || discovery.hostname !== 'gist.githubusercontent.com' || discovery.port ||
      discovery.username || discovery.password || discovery.pathname !== DISCOVERY_PATH || discovery.search || discovery.hash) {
    throw new Error('Invalid browser discovery configuration.');
  }
  let cached = null;
  let pending = null;
  let generation = 0;

  async function resolveTarget() {
    if (cached && now() < cached.expiresAt) return cached.origin;
    if (pending) return pending;
    cached = null; // Expired data is never a fallback if discovery is unavailable.
    const startedGeneration = generation;
    pending = (async () => {
      const url = new URL(discovery);
      url.searchParams.set('_browser_relay', String(Math.floor(now() / cacheMs)));
      const response = await fetchImpl(url, {
        redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
      });
      if (!response.ok || Number(response.headers.get('content-length')) > 4096) throw new Error('Browser discovery unavailable.');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new Error('Browser discovery response is too large.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record || typeof record.url !== 'string' || !record.url) throw new Error('Home browser is offline.');
      const origin = validateTarget(record.url);
      if (generation === startedGeneration) cached = { origin, expiresAt: now() + cacheMs };
      return origin;
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  resolveTarget.invalidate = () => { cached = null; generation += 1; };
  return resolveTarget;
}

function upstreamPath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.length > 16_384) return null;
  const question = rawUrl.indexOf('?');
  const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
  const query = new URLSearchParams(question < 0 ? '' : rawUrl.slice(question + 1));
  let suffix;
  if (rawPath === BROWSER_BASE_PATH || rawPath.startsWith(`${BROWSER_BASE_PATH}/`)) {
    suffix = rawPath.slice(BROWSER_BASE_PATH.length).replace(/^\//, '');
  } else if (rawPath === '/api/browser-relay' && query.getAll(RELAY_PATH_QUERY).length === 1) {
    suffix = query.get(RELAY_PATH_QUERY);
    query.delete(RELAY_PATH_QUERY);
  } else return null;
  if (!suffix || suffix === '/') suffix = '';
  if (/[\\?#\u0000-\u0020\u007f]/.test(suffix) || suffix.startsWith('/')) return null;
  let encoded;
  try {
    encoded = suffix.split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\\/%?#\u0000-\u001f\u007f]/.test(decoded)) throw new Error('Invalid path.');
      return encodeURIComponent(decoded);
    }).join('/');
  } catch { return null; }
  const search = query.toString();
  return `${BROWSER_BASE_PATH}/${encoded}${search ? `?${search}` : ''}`;
}

function requestOrigin(req, allowedOrigins) {
  if (typeof req.headers.host !== 'string') return null;
  return allowedOrigins.find(origin => new URL(origin).host === req.headers.host.toLowerCase()) ?? null;
}

function onlySessionCookie(raw) {
  const values = String(raw || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${SESSION_COOKIE}=`));
  return values.length === 1 && new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9._-]{1,2048}$`).test(values[0]) ? values[0] : null;
}

function sanitizeSetCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [cookies]).flatMap(cookie => {
    if (typeof cookie !== 'string') return [];
    const [pair, ...attributes] = cookie.split(';').map(part => part.trim());
    if (!new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9._-]{0,2048}$`).test(pair)) return [];
    const lifetime = attributes.filter(attribute => /^(?:Max-Age=-?\d+|Expires=[A-Za-z0-9,: +\-]+)$/i.test(attribute));
    return [`${pair}; Path=/; Secure; HttpOnly; SameSite=Lax${lifetime.length ? `; ${lifetime.join('; ')}` : ''}`];
  });
}

function relayLocation(location, target) {
  const url = new URL(location, `${target}${BROWSER_BASE_PATH}/`);
  if (url.origin !== target || url.username || url.password) throw new Error('Invalid upstream redirect.');
  const path = url.pathname === BROWSER_BASE_PATH || url.pathname.startsWith(`${BROWSER_BASE_PATH}/`)
    ? url.pathname : `${BROWSER_BASE_PATH}${url.pathname}`;
  const validated = upstreamPath(`${path}${url.search}`);
  if (!validated) throw new Error('Invalid upstream redirect path.');
  return `${validated}${url.hash}`;
}

function reply(res, status, message) {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: message }));
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

/** Raw streaming HTTP/WS relay; authentication and browser state stay at home. */
export function createBrowserRelay({
  discoveryUrl, resolveTarget = createTargetResolver({ discoveryUrl }),
  allowedOrigins = WEBSITE_ORIGINS, allowLoopbackForTests = false, upgradeTimeoutMs = 10_000,
} = {}) {
  // http-proxy-3 defaults to agent:false, which otherwise opens a fresh TLS
  // connection for every asset. Share bounded pools across warm invocations.
  const agentOptions = {
    keepAlive: true, keepAliveMsecs: 1000, scheduling: 'lifo',
    maxSockets: 64, maxTotalSockets: 128, maxFreeSockets: 8, timeout: 60_000,
  };
  const upstreamAgents = { 'http:': new http.Agent(agentOptions), 'https:': new https.Agent(agentOptions) };
  const agentFor = target => upstreamAgents[new URL(target).protocol];
  const proxy = createProxyServer({ changeOrigin: true, xfwd: false, ws: true, secure: true, prependPath: false,
    followRedirects: false, proxyTimeout: 30_000, connectTimeout: 10_000 });
  const sockets = new Set();
  let closing = false;

  function sanitizeResponse(upstreamResponse, req) {
    const headers = upstreamResponse.headers;
    const asset = req.url.split('?')[0].match(/^\/browser\/session\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/);
    const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const assetTypeMatches = asset?.[1] === 'css' ? contentType === 'text/css'
      : asset?.[1] === 'js' && ['application/javascript', 'text/javascript'].includes(contentType);
    // Cache only versioned UI code in this browser. Login pages, API data,
    // downloads, and every unauthenticated/error response remain uncached.
    const privateAsset = upstreamResponse.statusCode === 200 && ['GET', 'HEAD'].includes(req.method) &&
      onlySessionCookie(req.headers.cookie) && assetTypeMatches && !headers['set-cookie'] && !headers['content-disposition'];
    headers['cache-control'] = privateAsset ? 'private, max-age=86400, immutable' : 'no-store';
    headers['cdn-cache-control'] = 'no-store';
    headers['vercel-cdn-cache-control'] = 'no-store';
    headers['x-robots-tag'] = 'noindex, nofollow, noarchive';
    headers['referrer-policy'] = 'no-referrer';
    headers['x-content-type-options'] = 'nosniff';
    const directives = String(headers['content-security-policy'] || '').split(';').map(value => value.trim())
      .filter(value => value && !/^connect-src(?:\s|$)/i.test(value));
    headers['content-security-policy'] = [...directives, "connect-src 'self'"].join('; ');
    for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'server', 'x-powered-by', 'alt-svc', 'refresh']) delete headers[name];
    if (headers['set-cookie']) {
      const cookies = sanitizeSetCookies(headers['set-cookie']);
      if (cookies.length) headers['set-cookie'] = cookies;
      else delete headers['set-cookie'];
    }
    if (headers.location) headers.location = relayLocation(headers.location, req[requestContext].target);
  }

  proxy.on('proxyRes', (upstreamResponse, req, res) => {
    if (upstreamResponse.statusCode >= 500) {
      resolveTarget.invalidate?.();
      // Finish synchronously before http-proxy's response handler checks
      // headersSent/finished. It then skips both header copying and piping.
      // Tunnel error pages can contain the private hostname and external HTML.
      reply(res, 502, 'Home browser connection unavailable.');
      upstreamResponse.destroy();
      return;
    }
    // Keep each HTTP hop independent; an upstream pool must not override a
    // downstream client's request to close its connection. WS has its own path.
    delete upstreamResponse.headers['keep-alive'];
    if (req.httpVersionMajor < 2) upstreamResponse.headers.connection = res.shouldKeepAlive ? 'keep-alive' : 'close';
    else delete upstreamResponse.headers.connection;
    try { sanitizeResponse(upstreamResponse, req); }
    catch { reply(res, 502, 'Invalid browser response.'); upstreamResponse.destroy(); }
  });
  proxy.on('proxyReqWs', (upstreamRequest, req, socket) => {
    let upgraded = false;
    const timer = setTimeout(() => upstreamRequest.destroy(new Error('Browser handshake timed out.')), upgradeTimeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    upstreamRequest.once('error', clear);
    upstreamRequest.once('upgrade', (response, upstreamSocket) => {
      clear();
      try { sanitizeResponse(response, req); }
      catch { upstreamSocket.destroy(); socket.destroy(); return; }
      upgraded = true;
      sockets.add(upstreamSocket);
      upstreamSocket.once('close', () => sockets.delete(upstreamSocket));
    });
    upstreamRequest.once('response', response => {
      clear();
      try { sanitizeResponse(response, req); }
      catch { response.destroy(); socket.destroy(); }
      if (response.statusCode >= 500) resolveTarget.invalidate?.();
    });
    socket.once('close', () => { clear(); if (!upgraded) upstreamRequest.destroy(); });
  });
  proxy.on('error', (_error, req, destination) => {
    resolveTarget.invalidate?.();
    if (destination instanceof http.ServerResponse) reply(destination, 502, 'Home browser connection unavailable.');
    else rejectUpgrade(destination, 502);
  });

  async function prepare(req, websocket) {
    const origin = requestOrigin(req, allowedOrigins);
    const path = upstreamPath(req.url);
    const method = req.method || '';
    if (closing || !origin || !path || !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    if ((websocket || !['GET', 'HEAD', 'OPTIONS'].includes(method)) && req.headers.origin !== origin) return false;
    if (websocket && (method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket')) return false;
    const target = validateTarget(await resolveTarget(), allowLoopbackForTests);
    const sessionCookie = onlySessionCookie(req.headers.cookie);
    for (const key of Object.keys(req.headers)) {
      if (/^(?:x-forwarded-|x-vercel-|cf-)/i.test(key) || ['authorization', 'proxy-authorization', 'forwarded', 'cookie', 'referer', 'x-real-ip'].includes(key)) delete req.headers[key];
    }
    if (sessionCookie) req.headers.cookie = sessionCookie;
    req.headers.origin = target;
    req.url = path;
    req[requestContext] = { target, origin };
    return target;
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 300_000 }, async (req, res) => {
    try {
      const target = await prepare(req, false);
      if (!target) return reply(res, 403, 'Browser relay request denied.');
      if (!res.destroyed) proxy.web(req, res, {
        target, agent: agentFor(target), headers: { connection: 'keep-alive' },
      });
    } catch { reply(res, 503, 'Home browser is offline.'); }
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const target = await prepare(req, true);
      if (!target) return rejectUpgrade(socket, 403);
      if (!socket.destroyed) proxy.ws(req, socket, head, { target, agent: agentFor(target) });
    } catch { rejectUpgrade(socket, 503); }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_req, socket) => rejectUpgrade(socket, 403));
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400));
  return {
    server,
    async close() {
      closing = true;
      proxy.close();
      for (const socket of sockets) socket.destroy();
      for (const agent of Object.values(upstreamAgents)) agent.destroy();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}
