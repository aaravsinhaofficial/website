#!/usr/bin/env node
// Local-only visual QA: no Mac services, credentials, or real VNC connections.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const layout = {
  width: 3840, height: 2062,
  displays: [
    { id: '3', name: 'Display 1', isMain: false, x: 0, y: 0, width: 1920, height: 1080 },
    { id: '1', name: 'Built-in display', isMain: true, x: 1141, y: 1080, width: 1512, height: 982 },
    { id: '2', name: 'Display 2', isMain: false, x: 1920, y: 0, width: 1920, height: 1080 },
  ],
};
const files = new Map([
  ['/desktop', ['desktop/index.html', 'text/html; charset=utf-8']],
  ['/desktop/', ['desktop/index.html', 'text/html; charset=utf-8']],
  ['/desktop/desktop.css', ['desktop/desktop.css', 'text/css; charset=utf-8']],
  ['/desktop/desktop.js', ['desktop/desktop.js', 'text/javascript; charset=utf-8']],
]);
const glyphs = {
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
};
const pixel = color => Buffer.from([...color, 0]);

function rre(rect, color, marks = []) {
  const result = Buffer.alloc(20 + marks.length * 12);
  result.writeUInt16BE(rect.x, 0); result.writeUInt16BE(rect.y, 2);
  result.writeUInt16BE(rect.width, 4); result.writeUInt16BE(rect.height, 6);
  result.writeInt32BE(2, 8); // RRE, supported by the pinned noVNC client.
  result.writeUInt32BE(marks.length, 12);
  pixel(color).copy(result, 16);
  marks.forEach((mark, index) => {
    const offset = 20 + index * 12;
    pixel(mark.color || [255, 255, 255]).copy(result, offset);
    result.writeUInt16BE(mark.x, offset + 4); result.writeUInt16BE(mark.y, offset + 6);
    result.writeUInt16BE(mark.width, offset + 8); result.writeUInt16BE(mark.height, offset + 10);
  });
  return result;
}

function frame() {
  const rectangles = [rre({ x: 0, y: 0, width: layout.width, height: layout.height }, [17, 24, 39])];
  // Red 1 = left; green 2 = built-in; blue 3 = right. Each display has
  // a white center crosshair so a click has a predictable framebuffer position.
  const colors = [[190, 18, 60], [21, 128, 61], [3, 105, 161]];
  layout.displays.forEach((display, index) => {
    const marks = [];
    glyphs[index + 1].forEach((line, row) => [...line].forEach((cell, column) => {
      if (cell === '1') marks.push({ x: 72 + column * 24, y: 72 + row * 24, width: 24, height: 24 });
    }));
    const cx = Math.floor(display.width / 2), cy = Math.floor(display.height / 2);
    marks.push({ x: cx - 36, y: cy - 3, width: 72, height: 6 });
    marks.push({ x: cx - 3, y: cy - 36, width: 6, height: 72 });
    marks.push({ x: display.width - 80, y: 40, width: 40, height: 40 });
    rectangles.push(rre(display, colors[index], marks));
  });
  const header = Buffer.from([0, 0, 0, rectangles.length]);
  return Buffer.concat([header, ...rectangles]);
}

function serverInit() {
  const name = Buffer.from('Local three-display QA fixture');
  const header = Buffer.alloc(24);
  header.writeUInt16BE(layout.width, 0); header.writeUInt16BE(layout.height, 2);
  header[4] = 32; header[5] = 24; header[6] = 0; header[7] = 1;
  header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12);
  header[14] = 0; header[15] = 8; header[16] = 16;
  header.writeUInt32BE(name.length, 20);
  return Buffer.concat([header, name]);
}

function fakeRfb(socket, logPointer) {
  let pending = Buffer.alloc(0), state = 'version', sentFrame = false, rreSupported = false;
  const send = data => { if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: true }); };
  const consume = size => { const value = pending.subarray(0, size); pending = pending.subarray(size); return value; };
  send(Buffer.from('RFB 003.008\n'));
  socket.on('message', (data, binary) => {
    if (!binary || pending.length + data.length > 1024 * 1024) { socket.close(1003); return; }
    pending = Buffer.concat([pending, data]);
    try {
      while (pending.length) {
        if (state === 'version') {
          if (pending.length < 12) return;
          if (consume(12).toString() !== 'RFB 003.008\n') throw new Error();
          send(Buffer.from([1, 1])); state = 'security'; continue;
        }
        if (state === 'security') {
          if (consume(1)[0] !== 1) throw new Error();
          send(Buffer.alloc(4)); state = 'client-init'; continue;
        }
        if (state === 'client-init') {
          consume(1); send(serverInit()); state = 'normal'; continue;
        }
        const type = pending[0];
        let size;
        if (type === 0) size = 20; // SetPixelFormat
        else if (type === 2) {
          if (pending.length < 4) return;
          size = 4 + pending.readUInt16BE(2) * 4;
          if (size > 16_384) throw new Error();
        } else if (type === 3 || type === 150) size = 10; // Update request / continuous updates
        else if (type === 4) size = 8; // KeyEvent; intentionally never logged.
        else if (type === 5) size = 6; // PointerEvent
        else if (type === 6) {
          if (pending.length < 8) return;
          size = 8 + Math.abs(pending.readInt32BE(4)); // Clipboard; intentionally never logged.
          if (size > 1024 * 1024) throw new Error();
        } else if (type === 248) {
          if (pending.length < 9) return;
          size = 9 + pending[8]; // Fence
        } else if (type === 251) {
          if (pending.length < 8) return;
          size = 8 + pending[6] * 16; // SetDesktopSize; fixture geometry stays fixed.
        } else throw new Error();
        if (pending.length < size) return;
        const message = consume(size);
        if (type === 0 && (message[4] !== 32 || message[5] !== 24 || message[6] !== 0 ||
            message[14] !== 0 || message[15] !== 8 || message[16] !== 16)) throw new Error();
        if (type === 2) {
          rreSupported = false;
          for (let offset = 4; offset < message.length; offset += 4) {
            if (message.readInt32BE(offset) === 2) rreSupported = true;
          }
        }
        if (type === 3 && (!sentFrame || !message[1])) {
          if (!rreSupported) throw new Error();
          send(frame()); sentFrame = true;
        }
        // Incremental requests remain pending while the static image is unchanged.
        // Replying immediately with empty updates would create a busy polling loop.
        if (type === 5) logPointer({ type: 'pointer', buttons: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
      }
    } catch { socket.close(1003, 'Unsupported fixture protocol'); }
  });
  socket.on('error', () => {});
}

export function createDesktopDisplayPreview({ logPointer = value => console.log(JSON.stringify(value)) } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const validHost = request => request.headers.host === `127.0.0.1:${request.socket.localPort}`;
  const server = createServer(async (request, response) => {
    const reply = (status, content, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
    };
    if (!validHost(request)) { reply(403, '{}'); return; }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'GET') { reply(405, '{}'); return; }
    if (path === '/desktop/session/auth/status') {
      reply(200, JSON.stringify({ authenticated: true, desktopAvailable: true })); return;
    }
    if (path === '/desktop/session/displays') { reply(200, JSON.stringify(layout)); return; }
    if (path === '/desktop/session/health') { reply(200, JSON.stringify({ status: 'ready', desktopAvailable: true })); return; }
    if (path === '/') { response.writeHead(302, { Location: '/desktop' }); response.end(); return; }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const file = files.get(path);
    if (!file) { reply(404, '{}'); return; }
    try { reply(200, await readFile(join(root, file[0])), file[1]); }
    catch { reply(500, JSON.stringify({ error: 'Build the desktop frontend before opening this fixture.' })); }
  });
  server.on('upgrade', (request, socket, head) => {
    if (!validHost(request) || request.url !== '/desktop/session/websockify' ||
        request.headers.origin !== `http://127.0.0.1:${request.socket.localPort}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, client => fakeRfb(client, logPointer));
  });
  const close = () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.close();
    server.closeAllConnections();
  };
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = createDesktopDisplayPreview();
  fixture.server.listen(4173, '127.0.0.1', () => console.error('Desktop display QA: http://127.0.0.1:4173/desktop'));
  process.once('SIGINT', fixture.close);
  process.once('SIGTERM', fixture.close);
}
