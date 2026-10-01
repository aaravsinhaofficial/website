import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM drawing surface: use the actual pinned RFB and Display classes,
// replacing only browser rendering/observers and connection startup.
function element(tag = 'div') {
  const context = {draws: [], drawImage(...args) { this.draws.push(args); },
    getImageData() { return {}; }, putImageData() {}, clearRect() {}};
  return {tagName: tag.toUpperCase(), style: {}, width: 0, height: 0, clientWidth: 960, clientHeight: 540,
    offsetWidth: 960, children: [], getContext() { return context; },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); },
    getBoundingClientRect() { return {x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight}; },
    addEventListener() {}, removeEventListener() {}, focus() {}};
}
globalThis.document = {documentElement: {}, body: element(), createElement: element};
globalThis.window = {isSecureContext: true, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {},
  requestAnimationFrame(callback) { callback(); }};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const {default: DisplayRFB, mapDisplayLayout} = await import('../desktop/src/display-rfb.js');

class TestRFB extends DisplayRFB {
  _updateConnectionState(state) { this._rfbConnectionState = state; }
}
function client(width = 3840, height = 2062) {
  const rfb = new TestRFB(element(), 'wss://example.invalid/test');
  rfb.scaleViewport = true;
  if (width && height) rfb._resize(width, height);
  return rfb;
}
const layout = {width: 3840, height: 2062, displays: [
  {id: 'left', name: 'Left external', isMain: false, x: 0, y: 0, width: 1920, height: 1080},
  {id: 'right', name: 'Right external', isMain: false, x: 1920, y: 0, width: 1920, height: 1080},
  {id: 'main', name: 'Built-in', isMain: true, x: 1141, y: 1080, width: 1512, height: 982},
]};
const viewport = rfb => ({...rfb._display._viewportLoc});
function capturePointer(rfb, x, y, mask = 0) {
  const bytes = [];
  rfb._sock = {sQpush8(value) {bytes.push(value);}, sQpush16(value) {bytes.push(value >> 8, value & 255);}, flush() {}};
  rfb._rfbConnectionState = 'connected';
  rfb._sendMouse(x, y, mask);
  return bytes;
}

test('maps normalized physical display bounds with a uniform framebuffer scale', () => {
  const mapped = mapDisplayLayout(layout, 7680, 4124);
  assert.deepEqual(mapped[2], {...layout.displays[2], x: 2282, y: 2160, width: 3024, height: 1964});
  assert.equal(mapDisplayLayout(layout, 1920, 1080), null);
  assert.equal(mapDisplayLayout(layout, 0, 0), null);
  assert.ok(mapDisplayLayout(layout, 1920, 1031));
  assert.ok(mapDisplayLayout(layout, 1920, 1032));
  assert.equal(mapDisplayLayout(layout, 1920, 1035), null);
});

test('rejects invalid, duplicate, or out-of-bounds geometry', () => {
  for (const bad of [null, {...layout, width: Infinity}, {...layout, displays: []},
    {...layout, displays: [layout.displays[0], layout.displays[0]]},
    {...layout, displays: [{...layout.displays[0], x: -1}]},
    {...layout, displays: [{...layout.displays[0], width: 4000}]},
    {...layout, displays: [{...layout.displays[0], height: NaN}]}]) {
    assert.equal(mapDisplayLayout(bad, 3840, 2062), null);
  }
});

test('selection before the framebuffer arrives is retained and becomes ready on resize', () => {
  const rfb = client(0, 0), states = [];
  rfb.addEventListener('displaychange', event => states.push(event.detail));
  rfb.setDisplayLayout(layout);
  assert.equal(rfb.displayState.selectedId, 'main');
  assert.equal(rfb.displayState.ready, false);
  assert.equal(rfb.displayState.displays.length, 3);
  assert.equal(rfb.selectDisplay('right'), true);
  assert.equal(rfb.selectDisplay('missing'), false);
  rfb._resize(3840, 2062);
  assert.deepEqual(viewport(rfb), {x: 1920, y: 0, w: 1920, h: 1080});
  assert.equal(rfb.displayState.ready, true);
  assert.equal(rfb.displayState.index, 1);
  assert.equal(states.at(-1).ready, true);
  const count = states.length;
  rfb._updateClip(); rfb._updateScale(); rfb._resize(3840, 2062);
  rfb.setDisplayLayout(structuredClone(layout)); rfb.selectDisplay('right');
  assert.equal(states.length, count, 'unchanged layout/resize cannot create an event loop');
});

test('real noVNC Display crops the selected monitor and maps fit/native pointer packets', () => {
  const rfb = client();
  rfb.setDisplayLayout(layout); rfb.selectDisplay('right');
  assert.equal(rfb._display.clipViewport, true);
  assert.equal(rfb._display.scale, 0.5);
  assert.equal(rfb._canvas.style.width, '960px');
  assert.deepEqual(capturePointer(rfb, 100, 50, 1), [5, 1, 8, 72, 0, 100]); // (2120,100)
  const draw = rfb._canvas.getContext('2d').draws.at(-1);
  assert.deepEqual(draw.slice(1), [1920, 0, 1920, 1080, 0, 0, 1920, 1080]);
  rfb.scaleViewport = false;
  assert.equal(rfb._display.scale, 1);
  assert.deepEqual(viewport(rfb), {x: 1920, y: 0, w: 1920, h: 1080});
  assert.deepEqual(capturePointer(rfb, 100, 50, 1), [5, 1, 7, 228, 0, 50]); // (2020,50)
  rfb.selectDisplay('main');
  assert.deepEqual(capturePointer(rfb, 10, 20), [5, 0, 4, 127, 4, 76]); // (1151,1100)
});

test('viewport resizes change fit scaling without changing crop or remote resolution', () => {
  const rfb = client(); rfb.setDisplayLayout(layout); rfb.selectDisplay('right');
  rfb._screen.clientWidth = 480; rfb._screen.clientHeight = 270;
  rfb._handleResize();
  assert.equal(rfb._display.scale, 0.25);
  assert.deepEqual(viewport(rfb), {x: 1920, y: 0, w: 1920, h: 1080});
  rfb.resizeSession = true; rfb.dragViewport = true;
  assert.equal(rfb.resizeSession, false); assert.equal(rfb.dragViewport, false);
  rfb._supportsSetDesktopSize = true;
  rfb._sock = new Proxy({}, {get() { throw new Error('must not send a remote resize'); }});
  rfb._requestRemoteResize();
});

test('mismatched framebuffer falls back safely then recovers and preserves selection', () => {
  const rfb = client(); rfb.setDisplayLayout(layout); rfb.selectDisplay('right');
  rfb._resize(1920, 1080);
  assert.equal(rfb.displayState.ready, false);
  assert.equal(rfb._display.clipViewport, false);
  assert.deepEqual(viewport(rfb), {x: 0, y: 0, w: 1920, h: 1080});
  rfb._resize(7680, 4124);
  assert.equal(rfb.displayState.ready, true);
  assert.deepEqual(viewport(rfb), {x: 3840, y: 0, w: 3840, h: 2160});
  rfb.setDisplayLayout({...layout, displays: layout.displays.filter(display => display.id !== 'right')});
  assert.equal(rfb.displayState.selectedId, 'main');
  const snapshot = rfb.displayState; snapshot.displays[0].name = 'changed';
  assert.equal(rfb.displayState.displays[0].name, 'Left external');
  rfb.setDisplayLayout(null);
  assert.deepEqual(rfb.displayState, {displays: [], selectedId: null, index: -1, ready: false});
  assert.deepEqual(viewport(rfb), {x: 0, y: 0, w: 7680, h: 4124});
});

test('switching monitor cancels queued motion and releases mouse buttons at the old coordinates', () => {
  const rfb = client(); rfb.setDisplayLayout(layout); rfb.selectDisplay('right');
  const bytes = capturePointer(rfb, 100, 50, 1);
  bytes.length = 0;
  rfb._mouseButtonMask = 1; rfb._mousePos = {x: 100, y: 50};
  rfb._mouseMoveTimer = setTimeout(() => assert.fail('stale pointer move ran'), 100);
  rfb.selectDisplay('left');
  assert.deepEqual(bytes, [5, 0, 8, 72, 0, 100]);
  assert.equal(rfb._mouseButtonMask, 0); assert.equal(rfb._mouseMoveTimer, null);
});
