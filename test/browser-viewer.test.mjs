import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../browser/browser.js', import.meta.url), 'utf8');
const BASE = '/browser/session';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function viewer({ logoutSucceeds = true } = {}) {
  const elements = new Map();
  const requests = [];
  const navigations = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 0;

  function eventTarget() {
    return {
      events: new Map(),
      addEventListener(name, callback) { this.events.set(name, callback); },
      async dispatch(name) { await this.events.get(name)?.(); await settle(); },
    };
  }

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        ...eventTarget(), hidden: false, disabled: false, dataset: {},
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
      });
    }
    return elements.get(id);
  }

  const frame = element('remote-browser');
  Object.defineProperty(frame, 'src', {
    get() { return navigations.at(-1); },
    set(value) { navigations.push(value); },
  });
  const document = {
    ...eventTarget(), hidden: false, fullscreenEnabled: false,
    getElementById: element,
  };
  const context = {
    document, window: eventTarget(), AbortController,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      requests.push({ url, options });
      assert.ok([`${BASE}/auth/health`, `${BASE}/auth/logout`].includes(url), `Unexpected viewer request: ${url}`);
      return {
        ok: url.endsWith('/auth/health') || logoutSucceeds,
        async json() { return { status: 'ready' }; },
      };
    },
  };
  vm.runInNewContext(source, context, { filename: 'browser/browser.js' });
  await settle();

  return {
    element, requests, navigations,
    load(contentType = 'text/html') {
      frame.contentDocument = { contentType };
      frame.onload();
    },
    async advance(milliseconds) {
      const target = clock + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        const [id, timer] = next;
        timers.delete(id);
        clock = timer.at;
        await timer.callback();
        await settle();
      }
      clock = target;
    },
  };
}

test('a JSON relay error retries the iframe even when health has already recovered', async () => {
  const page = await viewer();
  assert.equal(page.navigations.length, 1);

  // Health was ready, but the separately loaded session page hit a tunnel error.
  page.load('application/json');
  assert.equal(page.element('connection-status').dataset.state, 'offline');
  assert.equal(page.element('remote-browser').hidden, true);
  assert.equal(page.element('connection-screen').hidden, false);
  assert.equal(page.element('retry').hidden, false);
  assert.equal(page.element('reconnect').disabled, false);

  await page.advance(29_999);
  assert.equal(page.navigations.length, 1);
  await page.advance(1);
  assert.equal(page.requests.filter(request => request.url.endsWith('/auth/health')).length, 2);
  assert.equal(page.navigations.length, 2, 'Healthy polling must reload the failed session page');
  assert.ok(page.navigations.every(url => url === `${BASE}/`));

  page.load();
  assert.equal(page.element('connection-status').dataset.state, 'online');
  assert.equal(page.element('remote-browser').hidden, false);
  assert.equal(page.element('connection-screen').hidden, true);
  assert.equal(page.element('workspace')['aria-busy'], 'false');

  // Subsequent healthy polls must not refresh a working browser session.
  await page.advance(30_000);
  assert.equal(page.navigations.length, 2);
});

test('manual reconnect remains available after an error and ignores a stale load event', async () => {
  const page = await viewer();
  const staleLoad = page.element('remote-browser').onload;
  page.load('application/json');
  await page.element('reconnect').dispatch('click');
  assert.equal(page.navigations.length, 2);
  assert.equal(page.element('reconnect').disabled, true);

  page.element('remote-browser').contentDocument = { contentType: 'text/html' };
  staleLoad();
  assert.equal(page.element('connection-status').dataset.state, 'loading');
  page.load();
  assert.equal(page.element('connection-status').dataset.state, 'online');
  assert.equal(page.element('reconnect').disabled, false);
  assert.equal(page.element('open-directly').href, `${BASE}/`);
});

test('lock still posts to the same-origin session after automatic recovery', async () => {
  const page = await viewer();
  page.load('application/json');
  await page.advance(30_000);
  page.load();

  await page.element('lock').dispatch('click');
  const logout = page.requests.at(-1);
  assert.equal(logout.url, `${BASE}/auth/logout`);
  assert.equal(logout.options.method, 'POST');
  assert.equal(logout.options.credentials, 'same-origin');
  assert.equal(page.navigations.length, 3);
  assert.equal(page.navigations.at(-1), `${BASE}/`);
  assert.equal(page.element('status-label').textContent, 'Browser locked');
  assert.equal(page.element('lock').disabled, false);
});

test('failed logout does not report a successful lock or reload the viewer', async () => {
  const page = await viewer({ logoutSucceeds: false });
  page.load();
  await page.element('lock').dispatch('click');

  assert.equal(page.navigations.length, 1);
  assert.equal(page.element('status-label').textContent, 'Home server online');
  assert.match(page.element('connection-notice').textContent, /Could not confirm.*locked/);
  assert.equal(page.element('lock').disabled, false);
});
