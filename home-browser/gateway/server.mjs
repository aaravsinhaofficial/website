import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProxyServer } from 'http-proxy-3';

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const WEBSITE_ORIGINS = new Set(['https://aaravsinha.dev', 'https://www.aaravsinha.dev']);
const FRAME_POLICY = "frame-ancestors 'self' https://aaravsinha.dev https://www.aaravsinha.dev";
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_HTML = readFileSync(new URL('./login.html', import.meta.url), 'utf8');

/** Stored format: scrypt$N$r$p$base64url(salt)$base64url(key). */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('Use a password between 12 characters and 1024 bytes.');
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parsePasswordHash(hash) {
  const parts = String(hash || '').split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$1' ||
      !/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) {
    throw new Error('HOME_BROWSER_PASSWORD_HASH must contain a valid scrypt password hash.');
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || salt.length > 64 || key.length !== 64) throw new Error('Invalid scrypt hash length.');
  return { salt, key };
}

function readConfig(configPath) {
  if (!configPath) return {};
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid browser configuration.');
  return parsed;
}

function parsePublicUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('The browser public URL must be an HTTPS origin.');
  return url;
}

function parseHost(value) {
  if (typeof value !== 'string' || value.length > 255 || /[\s,@/\\?#]/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    return { host: url.host, hostname: url.hostname, local: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) };
  } catch { return null; }
}

function reply(res, code, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': FRAME_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    ...headers,
  });
  res.end(payload);
}

async function readPassword(req, deadlineMs) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) {
    throw Object.assign(new Error('Unsupported content type.'), { status: 415 });
  }
  if (Number(req.headers['content-length']) > 2048) {
    req.resume();
    throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const finish = (error) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      if (error) {
        // Drain until the caller sends Connection: close, without retaining more body data.
        req.once('error', () => {});
        req.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > 2048) return finish(Object.assign(new Error('Request too large.'), { status: 413 }));
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(Object.assign(new Error('Request aborted.'), { status: 400 }));
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(Object.assign(new Error('Login request timed out.'), { status: 408 })), deadlineMs);
    timer.unref();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
  let body;
  try { body = contentType === 'application/json' ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); }
  catch { throw Object.assign(new Error('Invalid request.'), { status: 400 }); }
  if (!body || typeof body.password !== 'string' || Buffer.byteLength(body.password) > 1024) {
    throw Object.assign(new Error('Invalid password.'), { status: 400 });
  }
  return body.password;
}

/** Creates, but does not listen on, the gateway. Binding is loopback-only in the CLI. */
export function createGateway(options = {}) {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.HOME_BROWSER_CONFIG;
  const config = readConfig(configPath);
  const passwordHash = parsePasswordHash(options.passwordHash ?? env.HOME_BROWSER_PASSWORD_HASH ?? config.passwordHash);
  const sessionSecret = options.sessionSecret ?? env.HOME_BROWSER_SESSION_SECRET ?? config.sessionSecret;
  if (typeof sessionSecret !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(sessionSecret)) {
    throw new Error('HOME_BROWSER_SESSION_SECRET must be at least 32 random bytes encoded as base64url.');
  }
  const target = new URL(options.upstream ?? env.HOME_BROWSER_UPSTREAM ?? config.upstream ?? 'http://127.0.0.1:3080');
  if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('The browser upstream must be a loopback HTTP(S) origin.');
  }
  const publicUrlOverride = options.publicUrl ?? env.HOME_BROWSER_PUBLIC_URL;
  parsePublicUrl(publicUrlOverride ?? config.publicUrl);
  const basePath = env.HOME_BROWSER_BASE_PATH ?? '';
  if (typeof basePath !== 'string' || basePath.length > 128 ||
      (basePath !== '' && !/^(?:\/[A-Za-z0-9_-]+)+$/.test(basePath))) {
    throw new Error('HOME_BROWSER_BASE_PATH must be empty or slash-separated letters, numbers, underscores, and hyphens, without a trailing slash.');
  }
  const browserPath = `${basePath}/`;
  const loginPath = `${basePath}/auth/login`;
  const secureCookie = options.secureCookie ?? env.HOME_BROWSER_COOKIE_SECURE !== 'false';
  const cookieName = secureCookie ? '__Host-home_browser' : 'home_browser';
  const sessionTtlMs = Math.max(1, Math.min(options.sessionTtlMs ?? MAX_SESSION_MS, MAX_SESSION_MS));
  const loginBodyTimeoutMs = Math.max(1, Math.min(options.loginBodyTimeoutMs ?? 10_000, 10_000));
  const now = options.now ?? Date.now;
  const sessions = new Map();
  const clientSockets = new Set();
  const attempts = new Map();
  const ipLimit = options.ipLoginLimit ?? 8;
  const globalLimit = options.globalLoginLimit ?? 30;
  const ipWindowMs = options.ipWindowMs ?? 15 * 60 * 1000;
  const globalWindowMs = options.globalWindowMs ?? 60 * 1000;
  let globalAttempts = { count: 0, until: now() + globalWindowMs };
  let pendingHashes = 0;
  let closing = false;

  function context(req) {
    let publicUrl;
    try { publicUrl = parsePublicUrl(publicUrlOverride ?? readConfig(configPath).publicUrl); }
    catch { return null; } // Invalid config updates fail closed.
    const host = parseHost(req.headers.host);
    if (!host) return null;
    const acceptable = candidate => candidate && (candidate.local || (publicUrl
      ? candidate.host === publicUrl.host
      : /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(candidate.host)));
    if (!acceptable(host)) return null;
    const forwarded = req.headers['x-forwarded-host'] === undefined ? null : parseHost(req.headers['x-forwarded-host']);
    if (req.headers['x-forwarded-host'] !== undefined && !acceptable(forwarded)) return null;
    const effective = forwarded && !forwarded.local ? forwarded : host;
    const origin = effective.local ? `http://${effective.host}` : `https://${effective.host}`;
    if (!secureCookie && !effective.local) return null; // Never send a nonsecure cookie through a tunnel.
    return { origin, isPublic: !effective.local };
  }

  function originAllowed(req, ctx) {
    const origin = req.headers.origin;
    return typeof origin === 'string' && (origin === ctx.origin || WEBSITE_ORIGINS.has(origin));
  }

  function routePath(req, ctx) {
    const pathname = new URL(req.url, ctx.origin).pathname;
    if (!basePath) return pathname;
    const rawPathname = req.url.split('?')[0];
    const hasPrefix = value => value === basePath || value.startsWith(`${basePath}/`);
    // Check both representations so normalization cannot enter or escape the mounted route.
    if (!hasPrefix(rawPathname) || !hasPrefix(pathname) || rawPathname.includes('\\')) return null;
    return pathname.slice(basePath.length) || '/';
  }

  function corsHeaders(req) {
    return WEBSITE_ORIGINS.has(req.headers.origin) ? {
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    } : {};
  }

  function signedToken(id) {
    return `${id}.${createHmac('sha256', sessionSecret).update(id).digest('base64url')}`;
  }

  function cookie(token, maxAge) {
    return `${cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; ${secureCookie ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'}`;
  }

  function destroySession(id) {
    const session = sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    for (const socket of session.sockets) socket.destroy();
    sessions.delete(id);
  }

  function getSession(req) {
    const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [id] = token.split('.');
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(signedToken(id)))) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now()) { destroySession(id); return null; }
    return { id, ...session };
  }

  function checkRate(req, ctx) {
    const timestamp = now();
    for (const [ip, attempt] of attempts) if (attempt.until <= timestamp) attempts.delete(ip);
    if (globalAttempts.until <= timestamp) globalAttempts = { count: 0, until: timestamp + globalWindowMs };
    // Cloudflare overwrites this header; the global limit also covers spoofing through local clients.
    const cloudflareIp = req.headers['cf-connecting-ip'];
    const ip = ctx.isPublic && typeof cloudflareIp === 'string' && /^[a-fA-F0-9:.]{3,45}$/.test(cloudflareIp)
      ? cloudflareIp : req.socket.remoteAddress;
    const attempt = attempts.get(ip) ?? { count: 0, until: timestamp + ipWindowMs };
    const limited = globalAttempts.count >= globalLimit || attempt.count >= ipLimit ||
      (!attempts.has(ip) && attempts.size >= 2048) || pendingHashes >= 2;
    if (limited) return Math.max(1, Math.ceil((Math.min(attempt.until, globalAttempts.until) - timestamp) / 1000));
    attempt.count += 1;
    globalAttempts.count += 1;
    attempts.set(ip, attempt);
    return 0;
  }

  const Agent = target.protocol === 'https:' ? https.Agent : http.Agent;
  const upstreamAgent = new Agent({
    keepAlive: true, keepAliveMsecs: 1000, scheduling: 'lifo',
    maxSockets: 64, maxTotalSockets: 64, maxFreeSockets: 8, timeout: 60_000,
  });
  const proxy = createProxyServer({ target: target.origin, agent: upstreamAgent, ws: true, changeOrigin: true, xfwd: false, proxyTimeout: 30_000 });
  proxy.on('proxyRes', (upstreamResponse, req, res) => {
    delete upstreamResponse.headers['keep-alive'];
    if (req.httpVersionMajor < 2) upstreamResponse.headers.connection = res.shouldKeepAlive ? 'keep-alive' : 'close';
    else delete upstreamResponse.headers.connection;
    delete upstreamResponse.headers['x-frame-options'];
    const csp = upstreamResponse.headers['content-security-policy'];
    const directives = (Array.isArray(csp) ? csp.join('; ') : csp || '').split(';')
      .map(d => d.trim()).filter(d => d && !/^frame-ancestors\b/i.test(d));
    upstreamResponse.headers['content-security-policy'] = [...directives, FRAME_POLICY].join('; ');
    upstreamResponse.headers['cache-control'] = 'no-store';
    upstreamResponse.headers['x-robots-tag'] = 'noindex, nofollow, noarchive';
    upstreamResponse.headers['referrer-policy'] = 'no-referrer';
    upstreamResponse.headers['x-content-type-options'] = 'nosniff';
    // The parent site cannot read browser content, even if the upstream enables broad CORS.
    delete upstreamResponse.headers['access-control-allow-origin'];
    delete upstreamResponse.headers['access-control-allow-credentials'];
  });
  proxy.on('error', (error, req, res) => {
    if (res instanceof http.ServerResponse) {
      if (res.headersSent) res.destroy();
      else reply(res, 502, { error: 'The home browser is starting or unavailable.' });
    }
    else if (res && !res.destroyed) res.destroy();
  });

  function prepareProxy(req) {
    // Credentials belong to the gateway only and never reach the streamed browser service.
    const cookies = (req.headers.cookie || '').split(';').filter(part => !part.trim().startsWith(`${cookieName}=`)).join(';');
    if (cookies.trim()) req.headers.cookie = cookies;
    else delete req.headers.cookie;
    delete req.headers.authorization;
    delete req.headers['proxy-authorization'];
    delete req.headers['x-forwarded-host'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-for'];
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 300_000, headersTimeout: 10_000 }, async (req, res) => {
    const ctx = context(req);
    if (!ctx) return reply(res, 421, { error: 'Unrecognized browser host.' });
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, { error: 'Invalid request path.' });
    const pathname = routePath(req, ctx);
    if (pathname === null) return reply(res, 404, { error: 'Not found.' });
    const cors = corsHeaders(req);
    if (pathname.startsWith('/auth/') && req.method === 'OPTIONS') {
      if (!originAllowed(req, ctx)) return reply(res, 403, { error: 'Origin denied.' });
      return reply(res, 204, '', { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    }
    if (pathname === '/auth/health' && req.method === 'GET') {
      try {
        const response = await fetch(new URL(browserPath, target), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000) });
        if (!response.ok) return reply(res, 503, { status: 'starting' }, cors);
        return reply(res, 200, { status: 'ready' }, cors);
      } catch { return reply(res, 503, { status: 'offline' }, cors); }
    }
    if (pathname === '/auth/login' && req.method === 'GET') {
      if (getSession(req)) return reply(res, 303, '', { Location: browserPath });
      const nonce = randomBytes(18).toString('base64url');
      const html = LOGIN_HTML.replaceAll('{{NONCE}}', nonce)
        .replaceAll('{{BASE_PATH_JSON}}', JSON.stringify(basePath).replaceAll('<', '\\u003c'));
      return reply(res, 200, html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; ${FRAME_POLICY}`,
      });
    }
    if (pathname === '/auth/login' && req.method === 'POST') {
      if (!originAllowed(req, ctx)) return reply(res, 403, { error: 'Origin denied.' }, cors);
      const retryAfter = checkRate(req, ctx);
      if (retryAfter) return reply(res, 429, { error: 'Too many attempts. Try again later.' }, { ...cors, 'Retry-After': String(retryAfter) });
      pendingHashes += 1;
      try {
        const password = await readPassword(req, loginBodyTimeoutMs);
        const key = await deriveKey(password, passwordHash.salt, 64, SCRYPT_OPTIONS);
        if (!timingSafeEqual(key, passwordHash.key)) return reply(res, 401, { error: 'Incorrect password.' }, cors);
        if (closing) return reply(res, 503, { error: 'Browser is restarting.' }, cors);
        const previous = getSession(req);
        if (previous) destroySession(previous.id);
        if (sessions.size >= 128) return reply(res, 503, { error: 'Too many active sessions.' }, cors);
        const id = randomBytes(32).toString('base64url');
        const timer = setTimeout(() => destroySession(id), sessionTtlMs);
        timer.unref();
        sessions.set(id, { expiresAt: now() + sessionTtlMs, sockets: new Set(), timer });
        return reply(res, 200, { authenticated: true }, { ...cors, 'Set-Cookie': cookie(signedToken(id), Math.ceil(sessionTtlMs / 1000)) });
      } catch (error) {
        return reply(res, error.status || 400, { error: 'Invalid login request.' }, { ...cors, Connection: 'close' });
      } finally { pendingHashes -= 1; }
    }
    if (pathname === '/auth/logout' && req.method === 'POST') {
      if (!originAllowed(req, ctx)) return reply(res, 403, { error: 'Origin denied.' }, cors);
      const session = getSession(req);
      if (session) destroySession(session.id);
      return reply(res, 200, { authenticated: false }, { ...cors, 'Set-Cookie': cookie('', 0) });
    }
    const session = getSession(req);
    if (!session) {
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return reply(res, 303, '', { Location: loginPath });
      return reply(res, 401, { error: 'Unlock your home browser to continue.' }, cors);
    }
    if (pathname === '/auth/session' && req.method === 'GET') return reply(res, 200, { authenticated: true, expiresAt: session.expiresAt }, cors);
    if (pathname.startsWith('/auth/')) return reply(res, 404, { error: 'Not found.' }, cors);
    if (/^\/(?:json|devtools)(?:\/|$)/i.test(pathname)) return reply(res, 404, { error: 'Not found.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== ctx.origin) return reply(res, 403, { error: 'Origin denied.' });
    prepareProxy(req);
    // A closing downstream HTTP connection can still reuse the upstream pool.
    // Leave the original request/Upgrade headers untouched for WebSockets.
    proxy.web(req, res, { headers: { connection: 'keep-alive' } });
  });

  server.on('connection', socket => {
    clientSockets.add(socket);
    socket.on('close', () => clientSockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('upgrade', (req, socket, head) => {
    const deny = code => { socket.end(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const ctx = context(req);
    if (!ctx || req.headers.origin !== ctx.origin || !req.url?.startsWith('/') || req.url.startsWith('//')) return deny(403);
    const pathname = routePath(req, ctx);
    if (pathname === null) return deny(403);
    if (/^\/(?:auth|json|devtools)(?:\/|$)/i.test(pathname)) return deny(403);
    const session = getSession(req);
    if (!session) return deny(401);
    session.sockets.add(socket);
    socket.on('close', () => session.sockets.delete(socket));
    prepareProxy(req);
    proxy.ws(req, socket, head);
  });
  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('connect', (req, socket) => socket.destroy());

  return {
    server,
    port: Number(options.port ?? env.HOME_BROWSER_PORT ?? config.port ?? 3081),
    async close() {
      closing = true;
      for (const id of sessions.keys()) destroySession(id);
      for (const socket of clientSockets) socket.destroy();
      upstreamAgent.destroy();
      proxy.close();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const gateway = createGateway();
    gateway.server.listen(gateway.port, '127.0.0.1', () => {
      console.log(`Home browser gateway listening on 127.0.0.1:${gateway.port}`);
    });
    gateway.server.on('error', () => { console.error('Home browser gateway could not listen. Check the configured port.'); process.exitCode = 1; });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
      await gateway.close();
      process.exit(0);
    });
  } catch (error) {
    console.error(`Home browser gateway configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}
