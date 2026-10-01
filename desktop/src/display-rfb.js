import RFB from '@novnc/novnc';

// This adapter uses the viewport hooks in the pinned noVNC 1.7.0 dependency.
// The full framebuffer stays intact; Display also translates pointer positions
// from the cropped, scaled canvas back into framebuffer coordinates.
function normalizeLayout(layout) {
  const dimension = value => Number.isFinite(value) && value > 0 && value <= 65535;
  if (!layout || !dimension(layout.width) || !dimension(layout.height) ||
      !Array.isArray(layout.displays) || !layout.displays.length || layout.displays.length > 32) return null;
  const ids = new Set();
  const displays = [];
  for (const display of layout.displays) {
    if (!display || typeof display.id !== 'string' || !display.id || display.id.length > 128 || ids.has(display.id) ||
        typeof display.name !== 'string' || display.name.length > 256 ||
        !Number.isFinite(display.x) || !Number.isFinite(display.y) || display.x < 0 || display.y < 0 ||
        !dimension(display.width) || !dimension(display.height) ||
        display.x + display.width > layout.width || display.y + display.height > layout.height) return null;
    ids.add(display.id);
    displays.push({id: display.id, name: display.name, isMain: display.isMain === true,
      x: display.x, y: display.y, width: display.width, height: display.height});
  }
  return {width: layout.width, height: layout.height, displays};
}

// One uniform scale is essential: stretching each axis independently can make
// an unrelated (for example single-monitor) framebuffer appear to match.
export function mapDisplayLayout(layout, framebufferWidth, framebufferHeight) {
  const valid = normalizeLayout(layout);
  if (!valid || !Number.isInteger(framebufferWidth) || !Number.isInteger(framebufferHeight) ||
      framebufferWidth <= 0 || framebufferHeight <= 0 || framebufferWidth > 65535 || framebufferHeight > 65535) return null;
  const scale = (framebufferWidth * valid.width + framebufferHeight * valid.height) /
    (valid.width ** 2 + valid.height ** 2);
  // Allow only the rounding error of one framebuffer pixel on either edge.
  if (Math.abs(valid.width * scale - framebufferWidth) > 1 ||
      Math.abs(valid.height * scale - framebufferHeight) > 1) return null;
  const mapped = valid.displays.map(display => {
    const x = Math.min(framebufferWidth, Math.round(display.x * scale));
    const y = Math.min(framebufferHeight, Math.round(display.y * scale));
    const right = Math.min(framebufferWidth, Math.round((display.x + display.width) * scale));
    const bottom = Math.min(framebufferHeight, Math.round((display.y + display.height) * scale));
    return {...display, x, y, width: right - x, height: bottom - y};
  });
  return mapped.every(display => display.width > 0 && display.height > 0) ? mapped : null;
}

export default class DisplayRFB extends RFB {
  constructor(...args) {
    super(...args);
    this._displayLayout = null;
    this._selectedDisplayId = null;
    this._displayStateKey = null;
    this._displayReady = false;
    this.resizeSession = false;
    this.dragViewport = false;
  }

  // Selecting a display must never change the physical Mac's resolution or
  // let touch-dragging move the viewport outside that display.
  get resizeSession() { return false; }
  set resizeSession(_) { this._resizeSession = false; }
  get dragViewport() { return false; }
  set dragViewport(_) {}
  _requestRemoteResize() {}

  get displayState() {
    const displays = (this._displayLayout?.displays || []).map(({id, name, isMain}) => ({id, name, isMain}));
    return {displays, selectedId: this._selectedDisplayId ?? null,
      index: displays.findIndex(display => display.id === this._selectedDisplayId), ready: this._displayReady === true};
  }

  setDisplayLayout(layout) {
    const next = normalizeLayout(layout);
    if (JSON.stringify(next) === JSON.stringify(this._displayLayout)) return;
    this._releaseDisplayPointer();
    this._displayLayout = next;
    if (!next?.displays.some(display => display.id === this._selectedDisplayId)) {
      this._selectedDisplayId = (next?.displays.find(display => display.isMain) || next?.displays[0])?.id ?? null;
    }
    this._updateScale();
    this._saveExpectedClientSize();
  }

  selectDisplay(id) {
    if (!this._displayLayout?.displays.some(display => display.id === id)) return false;
    if (id === this._selectedDisplayId) return true;
    this._releaseDisplayPointer();
    this._selectedDisplayId = id;
    this._updateScale();
    this._saveExpectedClientSize();
    return true;
  }

  _releaseDisplayPointer() {
    // Release at the old monitor coordinates before changing the crop. A
    // queued mouse move must not be replayed into the newly selected monitor.
    clearTimeout(this._mouseMoveTimer);
    this._mouseMoveTimer = null;
    if (this._mouseButtonMask && Number.isFinite(this._mousePos?.x) && Number.isFinite(this._mousePos?.y)) {
      this._sendMouse(this._mousePos.x, this._mousePos.y, 0);
    }
    this._mouseButtonMask = 0;
  }

  _updateClip() {
    // RFB can call its hooks during super(), before adapter fields exist.
    if (!this._display) return;
    const mapped = mapDisplayLayout(this._displayLayout, this._display.width, this._display.height);
    const selected = mapped?.find(display => display.id === this._selectedDisplayId);
    this._displayReady = Boolean(selected);
    const clip = Boolean(selected);
    if (this._display.clipViewport !== clip) this._display.clipViewport = clip;
    if (selected) {
      this._display.viewportChangeSize(selected.width, selected.height);
      const viewport = this._display._viewportLoc;
      this._display.viewportChangePos(selected.x - viewport.x, selected.y - viewport.y);
    }
    this._setClippingViewport(clip && (selected.width < this._display.width || selected.height < this._display.height));
    const key = JSON.stringify([this._displayLayout ?? null, this.displayState, selected ?? null]);
    if (key !== this._displayStateKey) {
      this._displayStateKey = key;
      this.dispatchEvent(new CustomEvent('displaychange', {detail: this.displayState}));
    }
  }

  _updateScale() {
    // Stock noVNC disables clipping when scaleViewport is true. Apply our
    // physical-display crop first, then let its normal scaling use that crop.
    this._updateClip();
    if (this._display) super._updateScale();
  }
}
