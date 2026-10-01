import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createDesktopGateway, DESKTOP_BASE_PATH as BASE } from '../server.mjs';
import { createDesktopAuth, hashPassword, readDesktopConfig, writeDesktopConfig } from '../auth.mjs';

const PASSWORD = 'desktop-test-password';
const HASH = await hashPassword(PASSWORD);
const ORIGIN = 'https://desktop-fixture.trycloudflare.com';
const COOKIE = '__Host-home_desktop';
const TIME = 1_790_851_500_000;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-gateway-test-'));
  const configPath = join(directory, 'config.json');
  const browserConfigPath = join(directory, 'browser.json');
  await writeDesktopConfig(configPath, {
    passwordHash: HASH, sessionSecret: randomBytes(48).toString('base64url'),
  });
  await writeFile(browserConfigPath, JSON.stringify({ publicUrl: ORIGIN }), { mode: 0o600 });
  const tcpSockets = new Set();
  const received = [];
  const vnc = net.createServer(socket => {
    tcpSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => tcpSockets.delete(socket));
    socket.write('RFB 003.008\n');
    socket.on('data', data => { received.push(data); socket.write(data); });
  });
  vnc.listen(0, '127.0.0.1');
  await once(vnc, 'listening');
  let time = TIME;
  const gateway = createDesktopGateway({
    configPath, browserConfigPath, now: () => time,
    allowTestOverrides: true, testVncPort: vnc.address().port,
    ...options,
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const port = gateway.address().port;
  const websockets = new Set();
  t.after(async () => {
    for (const socket of websockets) socket.terminate();
    await gateway.closeGateway();
    for (const socket of tcpSockets) socket.destroy();
    await new Promise(resolve => vnc.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  function request(path = '/auth/status', { method = 'GET', headers = {}, body, rawPath = false } = {}) {
    return new Promise((resolve, reject) => {
      const allHeaders = { Host: new URL(ORIGIN).host, Origin: ORIGIN, ...headers };
      if (body !== undefined && !allHeaders['Content-Type']) allHeaders['Content-Type'] = 'application/json';
      for (const name of Object.keys(allHeaders)) if (allHeaders[name] === undefined) delete allHeaders[name];
      const req = http.request({ host: '127.0.0.1', port, path: rawPath ? path : `${BASE}${path}`, method, headers: allHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.once('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let data;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          resolve({ status: res.statusCode, headers: res.headers, data, raw });
        });
      });
      req.on('error', reject);
      req.end(typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function login({ password = PASSWORD, headers } = {}) {
    const response = await request('/auth/login', { method: 'POST', body: { password }, headers });
    return { ...response, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] };
  }

  function websocket(cookie, { path = '/websockify', origin = ORIGIN, host = new URL(ORIGIN).host } = {}) {
    const headers = { Host: host };
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BASE}${path}`, { headers, origin });
    websockets.add(ws);
    ws.on('error', () => {});
    ws.once('close', () => websockets.delete(ws));
    return ws;
  }
  return { directory, configPath, browserConfigPath, gateway, vnc, tcpSockets, port, received, request, login, websocket, advance: ms => { time += ms; }, now: () => time };
}

async function rejectedWebsocket(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', () => reject(new Error('WebSocket unexpectedly opened')));
    ws.once('unexpected-response', (_request, response) => { const status = response.statusCode; response.resume(); ws.terminate(); resolve(status); });
  });
}

test('status exposes only authentication and desktop availability without granting access', async t => {
  const f = await fixture(t);
  const status = await f.request();
  assert.deepEqual(status.data, { authenticated: false, desktopAvailable: true });
  assert.equal(status.headers['set-cookie'], undefined);
  assert.equal(await rejectedWebsocket(f.websocket()), 401);
});

test('password alone authenticates; incorrect, empty, and missing passwords fail', async t => {
  const f = await fixture(t);
  const before = await readFile(f.configPath, 'utf8');
  const badPassword = await f.login({ password: 'incorrect' });
  assert.equal(badPassword.status, 401);
  assert.equal(badPassword.data.error.code, 'invalid_credentials');
  assert.equal(badPassword.cookie, undefined);
  assert.equal((await f.login({ password: '' })).status, 400);
  assert.equal((await f.request('/auth/login', { method: 'POST', body: {} })).status, 400);
  const login = await f.login();
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /^__Host-home_desktop=[A-Za-z0-9_.-]+; Path=\/; Max-Age=14400; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(await readFile(f.configPath, 'utf8'), before, 'Logging in does not mutate private configuration');
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
  assert.equal((await f.request('/auth/status', { headers: { Cookie: login.cookie } })).data.authenticated, true);
});

test('credential rotation during password verification prevents a stale session', async t => {
  const f = await fixture(t);
  const auth = createDesktopAuth({ configPath: f.configPath });
  const verifying = auth.authenticate(PASSWORD);
  const current = readDesktopConfig(f.configPath);
  await writeDesktopConfig(f.configPath, { ...current, sessionSecret: randomBytes(48).toString('base64url') });
  assert.equal(await verifying, null);
  assert.equal((await f.login()).status, 200);
});

test('untrusted hosts, origins, cookie ambiguity, and paths are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/status', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.request('/auth/status', { headers: { Origin: 'https://aaravsinha.dev.evil.example' } })).status, 403);
  assert.equal((await f.request('/auth/status', { headers: { 'X-Forwarded-Host': 'evil.example' } })).status, 403);
  assert.equal((await f.login({ headers: { Origin: undefined } })).status, 403);
  for (const path of ['/auth/status', '/desktop/session-other/auth/status', '/desktop/session/../auth/status', '/desktop/session/%2e%2e/auth/status', '/desktop/session//auth/status']) {
    assert.equal((await f.request(path, { rawPath: true })).status, 404, path);
  }
  assert.equal((await f.request('/auth/status?harmless=1')).status, 200);
  assert.equal(await rejectedWebsocket(f.websocket(undefined, { path: '/websockify?target=external.example:5900' })), 401);
  const login = await f.login({ headers: { Origin: 'https://aaravsinha.dev' } });
  assert.equal(login.status, 200);
  assert.equal((await f.request('/auth/status', { headers: { Cookie: `${login.cookie}; ${login.cookie}` } })).data.authenticated, false);
  assert.equal(await rejectedWebsocket(f.websocket(login.cookie, { origin: 'https://evil.example' })), 403);
  assert.equal(await rejectedWebsocket(f.websocket(login.cookie, { path: '/auth/status' })), 403);
  const local = await f.request('/auth/status', { headers: { Host: `127.0.0.1:${f.port}`, Origin: undefined } });
  assert.equal(local.status, 200);
});

test('binary traffic ignores query targets, reaches only local VNC, and logout closes it', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const ws = f.websocket(login.cookie, { path: '/websockify?target=external.example:5900&token=untrusted' });
  const banner = once(ws, 'message');
  await once(ws, 'open');
  const [hello, binary] = await banner;
  assert.equal(hello.toString(), 'RFB 003.008\n');
  assert.equal(binary, true);
  const echo = once(ws, 'message');
  ws.send(Buffer.from([0, 1, 2, 127, 255]));
  assert.deepEqual((await echo)[0], Buffer.from([0, 1, 2, 127, 255]));
  assert.deepEqual(Buffer.concat(f.received), Buffer.from([0, 1, 2, 127, 255]));
  const closed = once(ws, 'close');
  const logout = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: login.cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.request('/auth/status', { headers: { Cookie: login.cookie } })).data.authenticated, false);
  assert.equal(await rejectedWebsocket(f.websocket(login.cookie)), 401);
});

test('expiry closes an already connected desktop and invalidates its cookie', async t => {
  const f = await fixture(t, { sessionTtlMs: 300 });
  const login = await f.login();
  const ws = f.websocket(login.cookie);
  await once(ws, 'open');
  const closed = once(ws, 'close');
  assert.equal((await closed)[0], 1008);
  assert.equal((await f.request('/auth/status', { headers: { Cookie: login.cookie } })).data.authenticated, false);
});

test('text and oversized WebSocket frames cannot be forwarded as VNC commands', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const text = f.websocket(login.cookie);
  await once(text, 'open');
  let closed = once(text, 'close');
  text.send('not binary');
  assert.equal((await closed)[0], 1003);
  const large = f.websocket(login.cookie);
  await once(large, 'open');
  closed = once(large, 'close');
  large.send(Buffer.alloc(1024 * 1024 + 1));
  assert.ok([1006, 1009].includes((await closed)[0]));
  assert.equal(f.received.length, 0);
});

test('login is rate-limited before expensive credential work', async t => {
  const f = await fixture(t, { ipLoginLimit: 2 });
  assert.equal((await f.login({ password: 'wrong' })).status, 401);
  assert.equal((await f.login({ password: 'wrong' })).status, 401);
  const blocked = await f.login();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('login rejects oversized and non-JSON bodies', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/login', { method: 'POST', body: 'x'.repeat(3000) })).status, 413);
  assert.equal((await f.request('/auth/login', { method: 'POST', body: 'password=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await f.request('/auth/login', { method: 'POST', body: '{bad json' })).status, 400);
});

test('slow login bodies have a bounded deadline', async t => {
  const f = await fixture(t, { loginBodyTimeoutMs: 35 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: `${BASE}/auth/login`, method: 'POST', headers: {
      Host: new URL(ORIGIN).host, Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '100',
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write('{');
    t.after(() => req.destroy());
  });
  assert.equal(response, 408);
});

test('private configuration permissions and credential rotation fail closed', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const current = readDesktopConfig(f.configPath);
  await writeDesktopConfig(f.configPath, { ...current, sessionSecret: randomBytes(48).toString('base64url') });
  assert.equal((await f.request('/auth/status', { headers: { Cookie: login.cookie } })).data.authenticated, false);
  await chmod(f.configPath, 0o644);
  assert.throws(() => createDesktopAuth({ configPath: f.configPath }), /not private/);
  const status = await f.request();
  assert.equal(status.status, 503);
  assert.ok(!status.raw.includes(current.sessionSecret));
  assert.ok(!status.raw.includes(HASH));
});

test('an invalid WebSocket handshake does not leak its local VNC connection', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: `${BASE}/websockify`, headers: {
      Host: new URL(ORIGIN).host, Origin: ORIGIN, Cookie: login.cookie,
      Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid',
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.tcpSockets.size, 0);
});

test('parallel WebSocket handshakes cannot exceed the per-session connection limit', async t => {
  const f = await fixture(t);
  const login = await f.login();
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise(resolve => {
    const ws = f.websocket(login.cookie);
    ws.once('open', () => resolve(101));
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
  })));
  assert.equal(results.filter(status => status === 101).length, 2);
  assert.equal(results.filter(status => status === 429).length, 2);
});
