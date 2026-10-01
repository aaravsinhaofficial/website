import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHomeGateway } from '../home-browser/entry.mjs';
import { generateTotpSecret, hashPassword } from '../home-desktop/auth.mjs';

test('combined gateway dispatches an unbound desktop safely and preserves browser upload timeouts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'home-gateway-test-'));
  const desktopConfigPath = join(directory, 'desktop.json');
  const browserConfigPath = join(directory, 'browser.json');
  await writeFile(desktopConfigPath, JSON.stringify({
    passwordHash: await hashPassword('integration-test-password'),
    sessionSecret: randomBytes(32).toString('base64url'),
    totpSecret: generateTotpSecret(), enrolled: false, lastTotpCounter: -1,
  }), { mode: 0o600 });
  await writeFile(browserConfigPath, JSON.stringify({ publicUrl: '' }), { mode: 0o600 });
  const fakeVnc = net.createServer(socket => socket.end());
  fakeVnc.listen(0, '127.0.0.1');
  await once(fakeVnc, 'listening');
  const browserRequests = [];
  let browserClosed = false;
  const gateway = createHomeGateway(() => ({
    port: 0,
    server: http.createServer((req, res) => {
      browserRequests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'browser' }));
    }),
    async close() { browserClosed = true; },
  }), {
    desktopConfigPath,
    desktop: { browserConfigPath, allowTestOverrides: true, testVncPort: fakeVnc.address().port },
  });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async () => {
    if (gateway.server.listening) await gateway.close();
    await new Promise(resolve => fakeVnc.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(gateway.server.requestTimeout, 300_000);
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
  assert.deepEqual(await (await request('/browser/session/auth/health')).json(), { service: 'browser' });
  const state = await request('/desktop/session/auth/status');
  assert.equal(state.status, 200, 'desktop must validate the outer listener port, not its unbound server address');
  assert.deepEqual(await state.json(), { authenticated: false, enrollmentRequired: true, desktopAvailable: true });
  assert.deepEqual(browserRequests, ['/browser/session/auth/health']);
  assert.equal((await request('/desktop/session/auth/logout', { method: 'POST' })).status, 403);
  assert.equal((await request('/desktop/session/auth/logout', {
    method: 'POST', headers: { Origin: 'https://attacker.example' },
  })).status, 403);
  assert.equal((await request('/desktop/session/auth/login', { method: 'PUT' })).status, 405);
  assert.equal((await request('/desktop/session/auth/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'integration-test-password', code: '000000' }),
  })).status, 403, 'unenrolled desktop cannot issue a session');
  const logout = await request('/desktop/session/auth/logout', { method: 'POST', headers: { Origin: origin } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /^__Host-home_desktop=;.*Max-Age=0/);
  assert.equal((await request('/desktop/session/unknown')).status, 404);
  assert.deepEqual(browserRequests, ['/browser/session/auth/health']);
  await gateway.close();
  assert.equal(gateway.server.listening, false);
  assert.equal(browserClosed, true);
});
