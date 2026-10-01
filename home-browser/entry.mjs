import http from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDesktopGateway } from '../home-desktop/server.mjs';

/** One tunnel, two independently authenticated services; desktop fails closed. */
export function createHomeGateway(createBrowserGateway, options = {}) {
  const browser = createBrowserGateway(options.browser);
  const desktopConfigPath = options.desktopConfigPath ?? process.env.HOME_DESKTOP_CONFIG ?? join(homedir(), 'Library', 'Application Support', 'aarav-home-desktop', 'config.json');
  let desktop;
  if (existsSync(desktopConfigPath)) {
    try { desktop = createDesktopGateway({configPath: desktopConfigPath, browserConfigPath: process.env.HOME_BROWSER_CONFIG, ...options.desktop}); }
    catch { console.error('Desktop gateway configuration unavailable; browser remains online.'); }
  }
  const sockets = new Set();
  const isDesktop = req => req.url === '/desktop/session' || req.url?.startsWith('/desktop/session/') || req.url?.startsWith('/desktop/session?');
  const server = http.createServer((req, res) => {
    if (!isDesktop(req)) return browser.server.emit('request', req, res);
    if (desktop) return desktop.emit('request', req, res);
    res.writeHead(503, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify({error:{code:'unavailable',message:'Desktop setup is not complete.'}}));
  });
  server.requestTimeout = 300000; // Preserve browser file transfers; login bodies have their own deadlines.
  server.headersTimeout = 15000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.on('upgrade', (req, socket, head) => {
    if (!isDesktop(req)) return browser.server.emit('upgrade', req, socket, head);
    if (desktop) return desktop.emit('upgrade', req, socket, head);
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    server, port: browser.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([browser.close(), desktop?.closeGateway()]);
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    },
  };
}
