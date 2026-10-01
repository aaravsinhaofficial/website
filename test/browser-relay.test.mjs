import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createBrowserRelay, createTargetResolver } from '../lib/browser-relay.mjs';

const ORIGIN = 'https://aaravsinha.dev';
const DISCOVERY = 'https://gist.githubusercontent.com/aaravsinhaofficial/cb2150b8e06a3f800b4a050874ba063b/raw/connection.json';
const COOKIE = '__Host-home_browser=test-session.signature';
const BASE = '/browser/session';

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
}

async function fixture(t, { handle, targetResolver, upgradeTimeoutMs, relayOptions = {} } = {}) {
  const received = [];
  const base = relayOptions.basePath || BASE;
  const cookie = `${relayOptions.sessionCookie || '__Host-home_browser'}=test-session.signature`;
  let invalidations = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { url: req.url, method: req.method, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() };
    received.push(entry);
    if (handle) return handle(req, res, entry);
    if (req.url === `${base}/auth/login` && req.method === 'POST') {
      const authorized = entry.body === JSON.stringify({ password: 'test-password' });
      res.writeHead(authorized ? 200 : 401, authorized ? { 'Set-Cookie': `${cookie}; Domain=home.trycloudflare.com; Path=/; Secure; HttpOnly; SameSite=None; Partitioned` } : {});
      res.end(JSON.stringify({ authenticated: authorized }));
    } else if (req.url === `${base}/auth/session`) {
      res.writeHead(req.headers.cookie === cookie ? 200 : 401);
      res.end('session');
    } else if (req.url === `${base}/redirect`) {
      res.writeHead(303, { Location: `${target}${base}/auth/login` });
      res.end();
    } else if (req.url === `${base}/root-redirect`) {
      res.writeHead(302, { Location: '/auth/login' });
      res.end();
    } else if (req.url === `${base}/external-redirect`) {
      res.writeHead(302, { Location: 'https://example.com/' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify(entry));
    }
  });
  const upstreamSockets = new Set();
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    received.push({ url: req.url, headers: { ...req.headers }, websocket: true });
    if (req.url.endsWith('/hang')) return;
    if (req.headers.cookie !== cookie) return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', (data, binary) => ws.send(data, { binary }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const resolver = targetResolver || (async () => target);
  resolver.invalidate = () => { invalidations += 1; };
  const relay = createBrowserRelay({ resolveTarget: resolver, allowLoopbackForTests: true, upgradeTimeoutMs, ...relayOptions });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const port = relay.server.address().port;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await relay.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => wss.close(resolve));
  });
  function request(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'aaravsinha.dev', ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  function websocket(path = `${base}/api/websockets`, headers = {}) {
    return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Host: 'aaravsinha.dev', Origin: ORIGIN, Cookie: cookie, ...headers } });
  }
  return { relay, request, websocket, received, upstream, target, invalidations: () => invalidations };
}

function rejectedWebsocket(ws) {
  return new Promise((resolve, reject) => {
    ws.on('error', () => {});
    ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected WebSocket upgrade.')); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
  });
}

test('discovery is restricted to the checked-in Gist, HTTPS origin, and exact tunnel host shape', async () => {
  for (const value of ['https://example.com/connection.json', `${DISCOVERY}?target=x`, DISCOVERY.replace('connection.json', 'passwords.json')]) {
    assert.throws(() => createTargetResolver({ discoveryUrl: value }), /Invalid browser discovery/);
  }
  for (const value of ['', 'http://foo.trycloudflare.com', 'https://foo.trycloudflare.com:444', 'https://foo.trycloudflare.com/path', 'https://foo.bar.trycloudflare.com', 'https://foo.trycloudflare.com@127.0.0.1', 'http://169.254.169.254']) {
    const resolve = createTargetResolver({ discoveryUrl: DISCOVERY, fetchImpl: async () => jsonResponse({ url: value }) });
    await assert.rejects(resolve());
  }
});

test('discovery shares an in-flight request, caches briefly, invalidates, and never uses stale data', async () => {
  let now = 0;
  let calls = 0;
  let available = true;
  const resolve = createTargetResolver({ discoveryUrl: DISCOVERY, now: () => now, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url.hostname, 'gist.githubusercontent.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (!available) throw new Error('offline');
    return jsonResponse({ url: 'https://one-two.trycloudflare.com', updatedAt: new Date().toISOString() });
  } });
  assert.deepEqual(await Promise.all([resolve(), resolve()]), ['https://one-two.trycloudflare.com', 'https://one-two.trycloudflare.com']);
  assert.equal(calls, 1);
  now = 14_999;
  await resolve();
  assert.equal(calls, 1);
  resolve.invalidate();
  await resolve();
  assert.equal(calls, 2);
  now = 30_000;
  available = false;
  await assert.rejects(resolve(), /offline/);
  assert.equal(calls, 3);
});

test('discovery rejects oversized, malformed, missing, and unavailable records', async () => {
  for (const response of [new Response('x'.repeat(4097)), new Response('{bad'), jsonResponse({}), jsonResponse({ url: '' }), new Response('offline', { status: 503 })]) {
    const resolve = createTargetResolver({ discoveryUrl: DISCOVERY, fetchImpl: async () => response });
    await assert.rejects(resolve());
  }
});

test('HTTP preserves browser path/query and supports the Vercel rewrite contract', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/browser-relay?__browser_relay_path=assets%2Fmain.js&v=123');
  assert.equal(response.status, 200);
  assert.equal(f.received[0].url, `${BASE}/assets/main.js?v=123`);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  assert.equal((await f.request('/api/browser-relay?__browser_relay_path=')).status, 200);
  assert.equal(f.received[1].url, `${BASE}/`);
  await f.request(`${BASE}/api/files?path=Desktop`);
  assert.equal(f.received[2].url, `${BASE}/api/files?path=Desktop`);
  await f.request('/api/browser-relay?__browser_relay_path=api%2Ffiles&path=Desktop%2Fschool');
  assert.equal(f.received[3].url, `${BASE}/api/files?path=Desktop%2Fschool`);
});

test('relay reuses upstream TCP connections even when downstream HTTP connections close', async t => {
  const f = await fixture(t);
  const connections = [];
  f.upstream.on('connection', socket => connections.push(socket));
  for (let index = 0; index < 6; index += 1) {
    const response = await f.request(`${BASE}/assets/client-${index}.js`, { headers: { Connection: 'close' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.connection, 'close');
    assert.equal(f.received.at(-1).headers.connection, 'keep-alive');
  }
  assert.equal(connections.length, 1, 'separate viewer requests should share one upstream TCP connection');
  const upstreamClosed = once(connections[0], 'close');
  await f.relay.close();
  await upstreamClosed;
});

test('only authenticated versioned JS and CSS can be cached privately; CDN caching stays disabled', async t => {
  const f = await fixture(t, { handle: (req, res) => {
    const pathname = req.url.split('?')[0];
    const authorized = req.headers.cookie === COOKIE;
    const headers = {
      'Content-Type': pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript',
      'Cache-Control': 'public, max-age=31536000',
      'CDN-Cache-Control': 'public, max-age=31536000',
      'Vercel-CDN-Cache-Control': 'public, max-age=31536000',
    };
    let status = authorized ? 200 : 401;
    if (pathname.includes('html-')) headers['Content-Type'] = 'text/html';
    if (pathname.includes('cookie-')) headers['Set-Cookie'] = `${COOKIE}; Path=/`;
    if (pathname.includes('download-')) headers['Content-Disposition'] = 'attachment; filename=download.js';
    if (pathname.includes('redirect-')) { status = 302; headers.Location = `${BASE}/auth/login`; }
    res.writeHead(status, headers);
    res.end(status === 401 ? 'authentication required' : 'static code');
  } });
  for (const pathname of [`${BASE}/assets/index-CPWh3fQ6.js`, `${BASE}/assets/index-D97fjY6g.css?version=1`]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await f.request(pathname, { method, headers: { Cookie: COOKIE } });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'private, max-age=86400, immutable');
      assert.equal(response.headers['cdn-cache-control'], 'no-store');
      assert.equal(response.headers['vercel-cdn-cache-control'], 'no-store');
    }
  }
  const unauthorized = await f.request(`${BASE}/assets/index-CPWh3fQ6.js`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers['cache-control'], 'no-store');
  for (const pathname of [
    `${BASE}/auth/login`, `${BASE}/api/state`, `${BASE}/api/files/download/index-CPWh3fQ6.js`,
    `${BASE}/`, `${BASE}/assets/index.js`, `${BASE}/assets/index-short.js`,
    `${BASE}/assets/html-CPWh3fQ6.js`, `${BASE}/assets/cookie-CPWh3fQ6.js`,
    `${BASE}/assets/download-CPWh3fQ6.js`, `${BASE}/assets/redirect-CPWh3fQ6.js`,
  ]) {
    const response = await f.request(pathname, { headers: { Cookie: COOKIE } });
    assert.equal(response.headers['cache-control'], 'no-store', pathname);
    assert.equal(response.headers['cdn-cache-control'], 'no-store', pathname);
    assert.equal(response.headers['vercel-cdn-cache-control'], 'no-store', pathname);
  }
  const mutation = await f.request(`${BASE}/assets/index-CPWh3fQ6.js`, {
    method: 'POST', headers: { Cookie: COOKIE, Origin: ORIGIN },
  });
  assert.equal(mutation.headers['cache-control'], 'no-store');
});

test('root endpoint, foreign hosts, traversal, and attempted open-proxy requests are rejected before discovery', async t => {
  let resolutions = 0;
  const f = await fixture(t, { targetResolver: async () => { resolutions += 1; return 'https://some.trycloudflare.com'; } });
  for (const path of ['/api/browser-relay', '/api/browser-relay?url=https://example.com', '/api/browser-relay?__browser_relay_path=..%2Fauth', '/api/browser-relay?__browser_relay_path=%252e%252e%252fauth', '/api/browser-relay?__browser_relay_path=one&__browser_relay_path=two', `${BASE}/../auth`, `${BASE}/%2e%2e/auth`, `${BASE}/a%2fb`, '//example.com/path', '/']) {
    assert.equal((await f.request(path)).status, 403, path);
  }
  assert.equal((await f.request(`${BASE}/`, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal(resolutions, 0);
  assert.equal(f.received.length, 0);
});

test('mutating HTTP requests require the exact site origin', async t => {
  const f = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await f.request(`${BASE}/auth/login`, { method })).status, 403);
    assert.equal((await f.request(`${BASE}/auth/login`, { method, headers: { Origin: 'https://attacker.example' } })).status, 403);
  }
  assert.equal(f.received.length, 0);
});

test('login/authentication streams through and only the browser cookie crosses the relay', async t => {
  const f = await fixture(t);
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: 'site_private=secret', Authorization: 'Bearer private', 'X-Forwarded-Host': 'evil.example', 'X-Real-IP': '1.2.3.4' };
  const login = await f.request(`${BASE}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(login.status, 200);
  assert.equal(login.headers['set-cookie'][0], `${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  assert.equal(f.received[0].headers.origin, f.target);
  for (const key of ['cookie', 'authorization', 'x-forwarded-host', 'x-real-ip']) assert.equal(f.received[0].headers[key], undefined, key);
  assert.equal((await f.request(`${BASE}/auth/session`)).status, 401);
  assert.equal((await f.request(`${BASE}/auth/session`, { headers: { Cookie: `site_private=secret; ${COOKIE}; analytics=tracking` } })).status, 200);
  assert.equal(f.received.at(-1).headers.cookie, COOKIE);
  assert.equal((await f.request(`${BASE}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
});

test('only the authentication response cookie is permitted to affect the website', async t => {
  const f = await fixture(t, { handle: (_req, res) => {
    res.writeHead(200, { 'Set-Cookie': ['unrelated=attack; Path=/', '__Host-home_browser=; Domain=.aaravsinha.dev; Max-Age=0; Path=/other'] });
    res.end('ok');
  } });
  const response = await f.request(`${BASE}/`);
  assert.deepEqual(response.headers['set-cookie'], ['__Host-home_browser=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']);
});

test('relay CSP restricts connections to the website while preserving login nonces and framing', async t => {
  const f = await fixture(t, { handle: (_req, res) => {
    res.writeHead(200, { 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-login123'; style-src 'nonce-login123'; connect-src https://home.trycloudflare.com; frame-ancestors 'self' https://aaravsinha.dev; form-action 'self'" });
    res.end('login');
  } });
  const response = await f.request(`${BASE}/auth/login`);
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; script-src 'nonce-login123'; style-src 'nonce-login123'; frame-ancestors 'self' https://aaravsinha.dev; form-action 'self'; connect-src 'self'");
});

test('relay adds only a connection directive when the upstream has no CSP', async t => {
  const f = await fixture(t);
  const response = await f.request(`${BASE}/assets/client.js`);
  assert.equal(response.headers['content-security-policy'], "connect-src 'self'");
});

test('redirects stay on the website under the session prefix', async t => {
  const f = await fixture(t);
  for (const path of ['redirect', 'root-redirect']) {
    const response = await f.request(`${BASE}/${path}`);
    assert.equal(response.headers.location, `${BASE}/auth/login`);
    assert.equal(response.headers.location.includes('trycloudflare'), false);
  }
  assert.equal((await f.request(`${BASE}/external-redirect`)).status, 502);
});

test('WebSocket video/input frames proxy both directions with auth and rewritten Origin', async t => {
  const f = await fixture(t);
  const ws = f.websocket('/api/browser-relay?__browser_relay_path=api%2Fwebsockets');
  await once(ws, 'open');
  assert.equal(f.received[0].url, `${BASE}/api/websockets`);
  assert.equal(f.received[0].headers.origin, f.target);
  assert.equal(f.received[0].headers.cookie, COOKIE);
  const input = once(ws, 'message');
  ws.send('mouse,123,456');
  assert.equal((await input)[0].toString(), 'mouse,123,456');
  const frame = Buffer.alloc(1024 * 1024, 0x5a);
  const output = once(ws, 'message');
  ws.send(frame);
  assert.deepEqual((await output)[0], frame);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
});

test('WebSockets reject foreign origins and unauthenticated upstream upgrades', async t => {
  const f = await fixture(t);
  assert.equal(await rejectedWebsocket(f.websocket(undefined, { Origin: 'https://evil.example' })), 403);
  assert.equal(f.received.length, 0);
  assert.equal(await rejectedWebsocket(f.websocket(undefined, { Cookie: '' })), 401);
  assert.equal(f.received.length, 1);
});

test('unavailable discovery fails closed without attempting an upstream request', async t => {
  const f = await fixture(t, { targetResolver: async () => { throw new Error('discovery offline'); } });
  assert.equal((await f.request(`${BASE}/auth/health`)).status, 503);
  assert.equal(await rejectedWebsocket(f.websocket()), 503);
  assert.equal(f.received.length, 0);
});

test('upstream server failures invalidate discovery and replace private tunnel HTML with generic JSON', async t => {
  let failureStatus = 500;
  const f = await fixture(t, { handle: (_req, res) => {
    res.writeHead(failureStatus, {
      'Content-Type': 'text/html',
      Location: 'https://private-tunnel.trycloudflare.com/',
      'Set-Cookie': '__Host-home_browser=untrusted; Path=/',
    });
    res.end('<html>Cloudflare error 1033 at https://private-tunnel.trycloudflare.com/<script src="https://third-party.example/error.js"></script></html>');
  } });
  for (const status of [500, 502, 503, 530]) {
    failureStatus = status;
    const response = await f.request(`${BASE}/auth/health`);
    assert.equal(response.status, 502);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(JSON.parse(response.body), { error: 'Home browser connection unavailable.' });
    assert.equal(/trycloudflare|third-party|<html>|1033/.test(response.body), false);
  }
  assert.equal(f.invalidations(), 4);
});

test('WebSocket handshake timeout closes the stalled upstream and invalidates discovery', async t => {
  const f = await fixture(t, { upgradeTimeoutMs: 30 });
  assert.equal(await rejectedWebsocket(f.websocket(`${BASE}/hang`)), 502);
  assert.equal(f.invalidations(), 1);
});

const DESKTOP_BASE = '/desktop/session';
const DESKTOP_COOKIE = '__Host-home_desktop=test-session.signature';
const DESKTOP_OPTIONS = {
  basePath: DESKTOP_BASE,
  sessionCookie: '__Host-home_desktop',
  relayEndpoint: '/api/desktop-relay',
  relayPathQuery: '__desktop_relay_path',
};

test('relay service configuration rejects unsafe paths, cookie names, and rewrite parameters', () => {
  const resolveTarget = async () => 'https://home.trycloudflare.com';
  for (const basePath of ['', '/', '/desktop/session/', '/desktop/../session', '/desktop%2fsession', '/desktop?session', '/desktop\\session']) {
    assert.throws(() => createBrowserRelay({ resolveTarget, basePath }), /Invalid relay base path/);
  }
  for (const sessionCookie of ['home_desktop', '__Host-home.desktop', '__Host-home_desktop;evil', '__Host-.*', '__Host-']) {
    assert.throws(() => createBrowserRelay({ resolveTarget, sessionCookie }), /Invalid relay session cookie/);
  }
  for (const relayEndpoint of ['/api/desktop-relay/extra', 'https://evil.example', '/api/../session']) {
    assert.throws(() => createBrowserRelay({ resolveTarget, relayEndpoint }), /Invalid relay rewrite/);
  }
  for (const relayPathQuery of ['', 'query=value', '__desktop&other', '__desktop?query']) {
    assert.throws(() => createBrowserRelay({ resolveTarget, relayPathQuery }), /Invalid relay rewrite/);
  }
});

test('desktop and browser authentication cookies stay isolated in both directions', async t => {
  const desktop = await fixture(t, { relayOptions: DESKTOP_OPTIONS });
  const browser = await fixture(t);
  const login = await desktop.request(`${DESKTOP_BASE}/auth/login`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: COOKIE },
    body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.headers['set-cookie'], [`${DESKTOP_COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`]);
  assert.equal(desktop.received.at(-1).headers.cookie, undefined);
  assert.equal((await desktop.request(`${DESKTOP_BASE}/auth/session`, { headers: { Cookie: COOKIE } })).status, 401);
  assert.equal((await browser.request(`${BASE}/auth/session`, { headers: { Cookie: DESKTOP_COOKIE } })).status, 401);
  const combined = `${COOKIE}; ${DESKTOP_COOKIE}; unrelated=private`;
  assert.equal((await desktop.request(`${DESKTOP_BASE}/auth/session`, { headers: { Cookie: combined } })).status, 200);
  assert.equal(desktop.received.at(-1).headers.cookie, DESKTOP_COOKIE);
  assert.equal((await browser.request(`${BASE}/auth/session`, { headers: { Cookie: combined } })).status, 200);
  assert.equal(browser.received.at(-1).headers.cookie, COOKIE);
  assert.equal((await desktop.request(`${DESKTOP_BASE}/auth/session`, {
    headers: { Cookie: `${DESKTOP_COOKIE}; ${DESKTOP_COOKIE}` },
  })).status, 401);
});

test('desktop rewrite marker preserves application queries and rejects other service routes', async t => {
  const desktop = await fixture(t, { relayOptions: DESKTOP_OPTIONS });
  assert.equal((await desktop.request('/api/desktop-relay?__desktop_relay_path=api%2Ffiles&path=Documents%2Fnotes')).status, 200);
  assert.equal(desktop.received.at(-1).url, `${DESKTOP_BASE}/api/files?path=Documents%2Fnotes`);
  assert.equal((await desktop.request('/api/desktop-relay?__desktop_relay_path=')).status, 200);
  assert.equal(desktop.received.at(-1).url, `${DESKTOP_BASE}/`);
  const before = desktop.received.length;
  for (const pathname of [
    '/', `${BASE}/auth/health`, '/api/browser-relay?__browser_relay_path=auth%2Fhealth',
    '/api/desktop-relay?__browser_relay_path=auth%2Fhealth',
    '/api/browser-relay?__desktop_relay_path=auth%2Fhealth',
    '/api/desktop-relay?__desktop_relay_path=a&__desktop_relay_path=b',
    `${DESKTOP_BASE}-other/auth/health`, `${DESKTOP_BASE}/%2e%2e/auth/health`,
    '/api/desktop-relay?__desktop_relay_path=%252e%252e%252fprivate',
  ]) assert.equal((await desktop.request(pathname)).status, 403, pathname);
  assert.equal(desktop.received.length, before);
});

test('desktop response cookies and redirects cannot affect the browser session', async t => {
  const desktop = await fixture(t, { relayOptions: DESKTOP_OPTIONS });
  for (const pathname of ['redirect', 'root-redirect']) {
    const response = await desktop.request(`${DESKTOP_BASE}/${pathname}`);
    assert.equal(response.headers.location, `${DESKTOP_BASE}/auth/login`);
  }
  assert.equal((await desktop.request(`${DESKTOP_BASE}/external-redirect`)).status, 502);
  const setter = await fixture(t, { relayOptions: DESKTOP_OPTIONS, handle: (_req, res) => {
    res.writeHead(200, { 'Set-Cookie': [
      `${COOKIE}; Path=/; Max-Age=0`,
      '__Host-home_desktop=; Domain=.aaravsinha.dev; Path=/other; Max-Age=0',
      'unrelated=attack; Path=/',
    ] });
    res.end('logout');
  } });
  const response = await setter.request(`${DESKTOP_BASE}/auth/logout`);
  assert.deepEqual(response.headers['set-cookie'], ['__Host-home_desktop=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0']);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('desktop WebSocket frames preserve prefix and use only the desktop cookie', async t => {
  const desktop = await fixture(t, { relayOptions: DESKTOP_OPTIONS });
  assert.equal(await rejectedWebsocket(desktop.websocket(undefined, { Origin: 'https://evil.example' })), 403);
  assert.equal(await rejectedWebsocket(desktop.websocket(undefined, { Cookie: COOKIE })), 401);
  assert.equal(await rejectedWebsocket(desktop.websocket(`${BASE}/api/websockets`)), 403);
  const ws = desktop.websocket('/api/desktop-relay?__desktop_relay_path=api%2Fwebsockets', { Cookie: `${COOKIE}; ${DESKTOP_COOKIE}` });
  await once(ws, 'open');
  assert.equal(desktop.received.at(-1).url, `${DESKTOP_BASE}/api/websockets`);
  assert.equal(desktop.received.at(-1).headers.cookie, DESKTOP_COOKIE);
  assert.equal(desktop.received.at(-1).headers.origin, desktop.target);
  const output = once(ws, 'message');
  const pixels = Buffer.alloc(32 * 1024, 0x3a);
  ws.send(pixels);
  assert.deepEqual((await output)[0], pixels);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
});

test('desktop private asset caching requires its own successful authenticated static response', async t => {
  const desktop = await fixture(t, { relayOptions: DESKTOP_OPTIONS, handle: (req, res) => {
    const authorized = req.headers.cookie === DESKTOP_COOKIE;
    const headers = { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'application/javascript' };
    if (req.url.includes('html-')) headers['Content-Type'] = 'text/html';
    if (req.url.includes('download-')) headers['Content-Disposition'] = 'attachment';
    res.writeHead(authorized ? 200 : 401, headers);
    res.end('desktop static code');
  } });
  for (const extension of ['js', 'css']) {
    const pathname = `${DESKTOP_BASE}/assets/index-AbCd1234.${extension}`;
    const good = await desktop.request(pathname, { headers: { Cookie: `${COOKIE}; ${DESKTOP_COOKIE}` } });
    assert.equal(good.headers['cache-control'], 'private, max-age=86400, immutable');
    assert.equal(good.headers['cdn-cache-control'], 'no-store');
    assert.equal(good.headers['vercel-cdn-cache-control'], 'no-store');
    const otherSession = await desktop.request(pathname, { headers: { Cookie: COOKIE } });
    assert.equal(otherSession.status, 401);
    assert.equal(otherSession.headers['cache-control'], 'no-store');
  }
  for (const pathname of [
    `${DESKTOP_BASE}/auth/login`, `${DESKTOP_BASE}/api/files`, `${DESKTOP_BASE}/assets/unversioned.js`,
    `${DESKTOP_BASE}/assets/html-AbCd1234.js`, `${DESKTOP_BASE}/assets/download-AbCd1234.js`,
  ]) assert.equal((await desktop.request(pathname, { headers: { Cookie: DESKTOP_COOKIE } })).headers['cache-control'], 'no-store');
});
