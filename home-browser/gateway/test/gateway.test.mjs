import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createGateway, hashPassword } from '../server.mjs';

const password = 'test-home-browser-secret';
const passwordHash = await hashPassword(password);
const sessionSecret = randomBytes(32).toString('base64url');

async function fixture(t, options = {}) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "script-src 'self'; frame-ancestors 'none'");
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('real browser application');
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', ws => ws.on('message', message => ws.send(message)));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const gateway = createGateway({
    env: {}, passwordHash, sessionSecret,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    secureCookie: false, ...options,
  });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async () => {
    await gateway.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
  });
  async function request(url, init = {}) {
    // http.request preserves a supplied Host header; fetch intentionally rewrites it.
    return new Promise((resolve, reject) => {
      const req = http.request(origin + url, { method: init.method || 'GET', headers: init.headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: Object.entries(res.headers).flatMap(([key, value]) =>
            Array.isArray(value) ? value.map(item => [key, item]) : [[key, value]]),
        })));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  }
  async function login(value = password, headers = {}) {
    return request((options.env?.HOME_BROWSER_BASE_PATH || '') + '/auth/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ password: value }),
    });
  }
  return { gateway, upstream, received, origin, request, login, wss };
}

function websocket(origin, headers, pathname = '/api/stream') {
  return new WebSocket(origin.replace('http:', 'ws:') + pathname, { headers });
}

async function websocketDenied(origin, headers, pathname = '/api/stream') {
  return new Promise((resolve, reject) => {
    const ws = websocket(origin, headers, pathname);
    ws.on('unexpected-response', (req, res) => { const code = res.statusCode; res.resume(); ws.terminate(); resolve(code); });
    ws.on('open', () => { ws.terminate(); reject(new Error('WebSocket unexpectedly authenticated')); });
    ws.on('error', () => {});
  });
}

test('all browser paths require authentication; HTML gets login and no CDP exposed', async t => {
  const { request, received, login } = await fixture(t);
  for (const url of ['/', '/index.html', '/api/stream', '/assets/main.js', '/json/version']) {
    assert.equal((await request(url)).status, 401);
  }
  assert.equal(received.length, 0);
  const navigation = await request('/', { headers: { Accept: 'text/html' } });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get('location'), '/auth/login');
  const page = await request('/auth/login');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Unlock home browser/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/aaravsinha.dev/);
  const signedIn = await login();
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/json/version', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await request('/devtools/browser/123', { headers: { Cookie: cookie } })).status, 404);
});

test('wrong password fails; right password authenticates and never reaches upstream', async t => {
  const { login, request, received } = await fixture(t);
  const wrong = await login('incorrect-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const good = await login();
  assert.equal(good.status, 200);
  const setCookie = good.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(';')[0];
  const browser = await request('/?quality=high', { headers: { Cookie: cookie, Authorization: 'Bearer private-token' } });
  assert.equal(browser.status, 200);
  assert.equal(await browser.text(), 'real browser application');
  assert.equal(received.at(-1).url, '/?quality=high');
  assert.equal(received.at(-1).headers.cookie, undefined);
  assert.equal(received.at(-1).headers.authorization, undefined);
  assert.equal(browser.headers.get('x-frame-options'), null);
  assert.match(browser.headers.get('content-security-policy'), /script-src 'self'; frame-ancestors 'self'/);
  assert.equal(browser.headers.get('access-control-allow-origin'), null);
  assert.equal(browser.headers.get('cache-control'), 'no-store');
  const tampered = cookie.slice(0, -2) + 'xx';
  assert.equal((await request('/', { headers: { Cookie: tampered } })).status, 401);
});

test('public HTTPS cookies are secure and partitioned; unexpected host is rejected', async t => {
  const { login, request } = await fixture(t, { secureCookie: true, publicUrl: 'https://browser.aaravsinha.dev' });
  const good = await login(password, { Host: 'browser.aaravsinha.dev', Origin: 'https://browser.aaravsinha.dev' });
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie'), /^__Host-home_browser=/);
  assert.match(good.headers.get('set-cookie'), /Secure; SameSite=None; Partitioned/);
  assert.equal((await request('/', { headers: { Host: 'attacker.example' } })).status, 421);
  assert.equal((await request('/', { headers: { 'X-Forwarded-Host': 'attacker.example' } })).status, 421);
});

test('auth changes enforce Origin and the parent site has credentialed CORS', async t => {
  const { request, login } = await fixture(t);
  assert.equal((await login(password, { Origin: 'https://attacker.example' })).status, 403);
  const noOrigin = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(noOrigin.status, 403);
  const options = await request('/auth/logout', { method: 'OPTIONS', headers: { Origin: 'https://aaravsinha.dev', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), 'https://aaravsinha.dev');
  assert.equal(options.headers.get('access-control-allow-credentials'), 'true');
  const signedIn = await login();
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/auth/session', { headers: { Cookie: cookie } })).status, 200);
  const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://aaravsinha.dev' } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/', { headers: { Cookie: cookie } })).status, 401);
});

test('websockets authenticate, reject foreign/missing origins, and logout disconnects them', async t => {
  const { origin, login, request } = await fixture(t);
  assert.equal(await websocketDenied(origin, { Origin: origin }), 401);
  const good = await login();
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: 'https://attacker.example' }), 403);
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: 'https://aaravsinha.dev' }), 403);
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: 'https://www.aaravsinha.dev' }), 403);
  assert.equal(await websocketDenied(origin, { Cookie: cookie }), 403);
  const ws = websocket(origin, { Cookie: cookie, Origin: origin });
  await once(ws, 'open');
  const message = once(ws, 'message');
  ws.send('stream-frame');
  assert.equal((await message)[0].toString(), 'stream-frame');
  const closed = once(ws, 'close');
  await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
  await closed;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('browser mutations require the iframe origin even though parent-origin logout is allowed', async t => {
  const { origin, login, request } = await fixture(t);
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/action', {
    method: 'POST', headers: { Cookie: cookie, Origin: 'https://aaravsinha.dev' }, body: 'action',
  })).status, 403);
  assert.equal((await request('/api/action', {
    method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: 'action',
  })).status, 200);
});

test('incomplete login bodies hit their own deadline while uploads retain five minutes', async t => {
  const { origin, gateway, login } = await fixture(t, { loginBodyTimeoutMs: 60 });
  assert.equal(gateway.server.requestTimeout, 300_000);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(origin + '/auth/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '100' },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
    });
    req.on('error', reject);
    req.write('{"password":"');
    // Deliberately never complete the body. The gateway must release the hashing slot.
  });
  assert.equal(result.status, 408);
  assert.equal(result.connection, 'close');
  assert.equal((await login()).status, 200);
});

test('chunked login requests cannot evade the body size limit', async t => {
  const { origin, request } = await fixture(t);
  const response = await request('/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    body: JSON.stringify({ password: 'x'.repeat(3000) }),
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('connection'), 'close');
});

test('session expiry closes an active websocket and rejects stale HTTP cookies', async t => {
  const { origin, login, request } = await fixture(t, { sessionTtlMs: 500 });
  const good = await login();
  const cookie = good.headers.get('set-cookie').split(';')[0];
  const ws = websocket(origin, { Cookie: cookie, Origin: origin });
  await once(ws, 'open');
  await once(ws, 'close');
  assert.equal((await request('/', { headers: { Cookie: cookie } })).status, 401);
});

test('login rate limits and bounded request size protect password verification', async t => {
  const { origin, login, request } = await fixture(t, { ipLoginLimit: 2 });
  const oversized = await request('/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(3000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await login('incorrect-password')).status, 401);
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('global login limit applies across client addresses', async t => {
  const { login } = await fixture(t, { secureCookie: true, publicUrl: 'https://browser.aaravsinha.dev', globalLoginLimit: 2 });
  const headers = { Host: 'browser.aaravsinha.dev', Origin: 'https://browser.aaravsinha.dev' };
  assert.equal((await login('wrong', { ...headers, 'CF-Connecting-IP': '192.0.2.1' })).status, 401);
  assert.equal((await login('wrong', { ...headers, 'CF-Connecting-IP': '192.0.2.2' })).status, 401);
  assert.equal((await login(password, { ...headers, 'CF-Connecting-IP': '192.0.2.3' })).status, 429);
});

test('health reports upstream state and a failed proxy returns 502', async t => {
  const { upstream, request, login } = await fixture(t);
  const health = await request('/auth/health', { headers: { Origin: 'https://aaravsinha.dev' } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ready' });
  assert.equal(health.headers.get('access-control-allow-origin'), 'https://aaravsinha.dev');
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  assert.equal((await request('/auth/health')).status, 503);
  const response = await request('/', { headers: { Cookie: cookie } });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /unavailable/);
});

test('public tunnel URL reloads from the external config without restarting', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'home-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ publicUrl: 'https://old-tunnel.trycloudflare.com' }));
  const { request } = await fixture(t, { secureCookie: true, configPath });
  assert.equal((await request('/auth/login', { headers: { Host: 'old-tunnel.trycloudflare.com' } })).status, 200);
  await writeFile(configPath, JSON.stringify({ publicUrl: 'https://new-tunnel.trycloudflare.com' }));
  assert.equal((await request('/auth/login', { headers: { Host: 'old-tunnel.trycloudflare.com' } })).status, 421);
  assert.equal((await request('/auth/login', { headers: { Host: 'new-tunnel.trycloudflare.com' } })).status, 200);
});

test('base path contains every auth route, redirect, and login script URL', async t => {
  const base = '/browser/session';
  const { request, login, origin, received } = await fixture(t, { env: { HOME_BROWSER_BASE_PATH: base } });
  for (const url of ['/', '/auth/login', '/auth/health', '/api/stream', '/browser/session-extra/auth/login']) {
    assert.equal((await request(url, { headers: { Accept: 'text/html' } })).status, 404);
  }
  assert.equal(received.length, 0);
  const navigation = await request(base + '/', { headers: { Accept: 'text/html' } });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get('location'), base + '/auth/login');
  const page = await request(base + '/auth/login');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /const basePath = "\/browser\/session";/);
  assert.ok(!html.includes('{{BASE_PATH_JSON}}'));
  assert.ok(!html.includes('{{NONCE}}'));
  assert.ok(!html.includes("fetch('/auth/"));
  assert.ok(html.includes("location.replace(basePath + '/')"));
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
  const health = await request(base + '/auth/health');
  assert.equal(health.status, 200);
  assert.equal(received.at(-1).url, base + '/');
  assert.equal((await login('incorrect')).status, 401);
  const good = await login();
  assert.equal(good.status, 200);
  assert.match(good.headers.get('set-cookie'), /; Path=\//);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie };
  assert.equal((await request(base + '/auth/session', { headers })).status, 200);
  const signedInPage = await request(base + '/auth/login', { headers });
  assert.equal(signedInPage.headers.get('location'), base + '/');
  assert.equal((await request(base + '/assets/app.js?quality=high', { headers })).status, 200);
  assert.equal(received.at(-1).url, base + '/assets/app.js?quality=high');
  assert.equal((await request('/', { headers })).status, 404);
  assert.equal((await request('/auth/session', { headers })).status, 404);
  assert.equal((await request(base + '/json/version', { headers })).status, 404);
  const logout = await request(base + '/auth/logout', { method: 'POST', headers: { ...headers, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.equal((await request(base + '/', { headers })).status, 401);
});

test('base path websocket requires authentication and retains its complete upstream path', async t => {
  const base = '/browser/session';
  const { origin, login, request, wss } = await fixture(t, { env: { HOME_BROWSER_BASE_PATH: base } });
  assert.equal(await websocketDenied(origin, { Origin: origin }, base + '/api/stream'), 401);
  const cookie = (await login()).headers.get('set-cookie').split(';')[0];
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: origin }), 403);
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: origin }, base + '-extra/api/stream'), 403);
  assert.equal(await websocketDenied(origin, { Cookie: cookie, Origin: 'https://aaravsinha.dev' }, base + '/api/stream'), 403);
  const connected = once(wss, 'connection');
  const ws = websocket(origin, { Cookie: cookie, Origin: origin }, base + '/api/stream?resolution=720');
  await once(ws, 'open');
  assert.equal((await connected)[1].url, base + '/api/stream?resolution=720');
  const echo = once(ws, 'message');
  ws.send('prefixed-stream');
  assert.equal((await echo)[0].toString(), 'prefixed-stream');
  const closed = once(ws, 'close');
  await request(base + '/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
  await closed;
});

test('base path configuration rejects markup, encoded separators, and ambiguous paths', async t => {
  for (const base of ['/', 'browser/session', '/browser/session/', '//browser/session', '/browser/../session',
    '/browser%2fsession', '/browser?session', '/browser#session', '/browser\\session', '/<script>', '/"quoted"', '/x'.repeat(65)]) {
    assert.throws(() => createGateway({
      env: { HOME_BROWSER_BASE_PATH: base }, passwordHash, sessionSecret,
    }), /HOME_BROWSER_BASE_PATH/);
  }
  const { origin, request } = await fixture(t, { env: { HOME_BROWSER_BASE_PATH: '/browser/session' } });
  // Raw requests preserve dot segments, unlike URL-based client helpers.
  async function rawRequest(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: new URL(origin).port, path: pathname }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  }
  assert.equal(await rawRequest('/browser/session/../../auth/health'), 404);
  assert.equal(await rawRequest('/outside/../browser/session/auth/health'), 404);
  assert.equal(await rawRequest('/browser/session/%2e%2e/auth/health'), 404);
  assert.equal((await request('/browser/session%2fauth/health')).status, 404);
});

test('health does not report ready when the upstream browser subfolder is missing', async t => {
  const { upstream, request } = await fixture(t, { env: { HOME_BROWSER_BASE_PATH: '/browser/session' } });
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404);
    res.end();
  });
  const health = await request('/browser/session/auth/health');
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { status: 'starting' });
});
