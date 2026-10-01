import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./read-displays.py', import.meta.url));
const MAX_SIZE = 65535;
const unavailable = () => new Error('Display information is unavailable.');

/** Keep only display geometry and generated labels, never hardware identifiers. */
export function normalizeDisplays(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw unavailable();
  const ids = new Set();
  const displays = raw.map(display => {
    if (!display || typeof display !== 'object' || typeof display.id !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(display.id) || Number(display.id) > 0xffffffff || ids.has(display.id) ||
        typeof display.isMain !== 'boolean' || typeof display.isBuiltin !== 'boolean') throw unavailable();
    ids.add(display.id);
    const { id, isMain, isBuiltin, x, y, width, height } = display;
    if (![x, y, width, height, x + width, y + height].every(Number.isSafeInteger) ||
        width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) throw unavailable();
    return { id, isMain, isBuiltin, x, y, width, height };
  });
  if (displays.filter(display => display.isMain).length !== 1) throw unavailable();
  const minX = Math.min(...displays.map(display => display.x));
  const minY = Math.min(...displays.map(display => display.y));
  const width = Math.max(...displays.map(display => display.x + display.width)) - minX;
  const height = Math.max(...displays.map(display => display.y + display.height)) - minY;
  if (![width, height].every(Number.isSafeInteger) || width > MAX_SIZE || height > MAX_SIZE) throw unavailable();
  displays.sort((a, b) => a.x - b.x || a.y - b.y || Number(a.id) - Number(b.id));
  let external = 0;
  return Object.freeze({ width, height, displays: Object.freeze(displays.map(display => Object.freeze({
    id: display.id,
    name: display.isBuiltin ? 'Built-in display' : `Display ${++external}`,
    isMain: display.isMain,
    x: display.x - minX,
    y: display.y - minY,
    width: display.width,
    height: display.height,
  }))) });
}

/** Fixed, read-only CoreGraphics query. No caller-controlled command or path. */
function readCoreGraphics() {
  if (process.platform !== 'darwin') return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/python3', ['-I', '-B', HELPER], {
      encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024,
    }, (error, stdout) => {
      if (error) return reject(unavailable());
      try { resolve(JSON.parse(stdout)); } catch { reject(unavailable()); }
    });
  });
}

/** Share one bounded native query between authenticated callers for five seconds. */
export function createDisplayReader({ readRaw = readCoreGraphics, now = Date.now } = {}) {
  let cached;
  let until = 0;
  let pending;
  return async function readDisplays() {
    if (cached && now() < until) return cached;
    if (!pending) {
      pending = Promise.resolve().then(readRaw).then(raw => {
        cached = normalizeDisplays(raw);
        until = now() + 5000;
        return cached;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}
