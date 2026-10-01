#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTotpSecret, matchTotpCounter, parsePasswordHash, readDesktopConfig, writeDesktopConfig } from './auth.mjs';

const defaultStateDir = () => process.env.HOME_DESKTOP_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'aarav-home-desktop');
const defaultBrowserConfig = () => join(process.env.HOME_BROWSER_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'aarav-home-browser'), 'config.json');
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('Desktop authentication directory must be private and owned by this user.');
  }
  await chmod(path, 0o700);
}

async function browserPasswordHash(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error();
    const { passwordHash } = JSON.parse(await file.readFile('utf8'));
    parsePasswordHash(passwordHash);
    return passwordHash;
  } catch {
    throw new Error('A valid, private Home Browser configuration is required before desktop setup.');
  } finally { await file?.close(); }
}

/** Create once: an existing configuration, including pending enrollment, is preserved. */
export async function setupDesktop({ stateDir = defaultStateDir(), browserConfigPath = defaultBrowserConfig() } = {}) {
  await privateDirectory(stateDir);
  const configPath = join(stateDir, 'config.json');
  try {
    await lstat(configPath);
    return { configPath, enrolled: readDesktopConfig(configPath).enrolled, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = {
    passwordHash: await browserPasswordHash(browserConfigPath),
    sessionSecret: randomBytes(48).toString('base64url'),
    totpSecret: generateTotpSecret(),
    enrolled: false,
    lastTotpCounter: -1,
  };
  const temporary = join(stateDir, `.config-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  let file;
  let created = false;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    // A hard link publishes the complete file atomically without overwriting a
    // configuration created concurrently by another setup process.
    try { await link(temporary, configPath); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = await open(stateDir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { configPath, enrolled: readDesktopConfig(configPath).enrolled, created };
}

function secureEquals(actual, expected) {
  if (typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readForm(request) {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    throw Object.assign(new Error(), { status: 415 });
  }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 2048)) {
    throw Object.assign(new Error(), { status: 413 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (fields.size !== 2 || fields.getAll('csrf').length !== 1 || fields.getAll('code').length !== 1) {
    throw Object.assign(new Error(), { status: 400 });
  }
  return { csrf: fields.get('csrf'), code: fields.get('code') };
}

async function enrollmentLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      // A terminated enrollment process must not block the next local setup.
      // Never take over a live process's lock, including a just-created lock.
      try {
        const info = await lstat(path);
        let owner;
        try { owner = JSON.parse(await readFile(path, 'utf8')).pid; } catch {}
        let stale = false;
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (failure) { stale = failure.code === 'ESRCH'; }
        } else stale = Date.now() - info.mtimeMs > 30_000;
        if (!stale) throw error;
        await unlink(path);
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
      }
    }
  }
}

function page({ nonce, csrf, qr, secret, message = '', complete = false }) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Home Desktop setup</title>
<style nonce="${nonce}">:root{color-scheme:dark;font:17px system-ui;background:#111827;color:#f9fafb}body{max-width:440px;margin:48px auto;padding:24px}h1{font-size:28px}p{line-height:1.5;color:#d1d5db}img{display:block;width:256px;height:256px;border-radius:12px;margin:24px auto}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:8px;border:1px solid #64748b;font:inherit}input{background:#1f2937;color:white;letter-spacing:5px}button{margin-top:12px;background:#a5b4fc;color:#111827;cursor:pointer;font-weight:600}code{display:block;overflow-wrap:anywhere;margin:12px 0;font-size:15px}.message{color:#fcd34d}summary{cursor:pointer}</style>
<h1>${complete ? 'Authenticator connected' : 'Connect your authenticator'}</h1>
${complete ? '<p>You can close this page and open <a href="https://aaravsinha.dev/desktop">aaravsinha.dev/desktop</a>.</p><p>Wait for the code in your authenticator app to change. Use a fresh code from your app when signing in.</p>' : `<p>Scan this code with your authenticator app, then enter its six-digit code to finish setup.</p><img src="${qr}" width="256" height="256" alt="Authenticator setup QR code"><details><summary>Enter the key manually</summary><code>${escapeHtml(secret)}</code><p>Account: aaravsinha.dev<br>Issuer: Home Desktop<br>Time-based, six digits, 30 seconds.</p></details>${message ? `<p class="message" role="alert">${escapeHtml(message)}</p>` : ''}<form action="/enroll" method="post"><input type="hidden" name="csrf" value="${csrf}"><label for="code">Authenticator code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus><button type="submit">Finish setup</button></form>`}
</html>`;
}

/** The secret is shown only on this short-lived, loopback-only enrollment page. */
export async function startEnrollment({ stateDir = defaultStateDir(), browserConfigPath = defaultBrowserConfig(), port = 3084, lifetimeMs = 15 * 60_000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 15 * 60_000) {
    throw new Error('Invalid local enrollment server options.');
  }
  const { configPath, enrolled } = await setupDesktop({ stateDir, browserConfigPath });
  if (enrolled) return { enrolled: true, url: null, server: null, closed: Promise.resolve('already-enrolled') };
  const initial = readDesktopConfig(configPath);
  const csrf = randomBytes(32).toString('base64url');
  const origin = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  const otpUri = `otpauth://totp/Home%20Desktop:aaravsinha.dev?secret=${initial.totpSecret}&issuer=Home%20Desktop`;
  let qr;
  try {
    const { default: QRCode } = await import('qrcode');
    qr = await QRCode.toDataURL(otpUri, { errorCorrectionLevel: 'M', margin: 3, width: 256 });
  } catch { throw new Error('Unable to generate the local enrollment page. Install the website dependencies first.'); }

  const deadline = Date.now() + lifetimeMs;
  let finished = false;
  let closing = false;
  let attempts = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const sockets = new Set();
  let timer;
  const send = (response, status, body, { html = false, nonce = '' } = {}) => {
    response.writeHead(status, {
      'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      Connection: 'close',
    });
    response.end(body);
  };
  const render = (response, status, options = {}) => {
    const nonce = randomBytes(18).toString('base64');
    send(response, status, page({ nonce, csrf, qr, secret: initial.totpSecret, ...options }), { html: true, nonce });
  };
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
      if (hostCount !== 1 || request.headers.host !== host ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
        send(response, 403, 'Local enrollment only.'); return;
      }
      if (Date.now() >= deadline || closing) { send(response, 410, 'Enrollment has expired.'); return; }
      if (request.method === 'GET' && request.url === '/') {
        const current = readDesktopConfig(configPath);
        if (current.enrolled || finished) { render(response, 200, { complete: true }); return; }
        if (current.totpSecret !== initial.totpSecret || current.sessionSecret !== initial.sessionSecret) {
          send(response, 409, 'Enrollment configuration changed. Restart local setup.'); return;
        }
        render(response, 200); return;
      }
      if (request.method !== 'POST' || request.url !== '/enroll') { send(response, 404, 'Not found.'); return; }
      if (request.headers.origin !== origin) { send(response, 403, 'Local enrollment only.'); return; }
      const form = await readForm(request);
      if (!secureEquals(form.csrf, csrf)) { send(response, 403, 'Invalid enrollment request.'); return; }
      attempts = attempts.filter(time => time > Date.now() - 60_000);
      if (attempts.length >= 6) { render(response, 429, { message: 'Wait one minute before trying again.' }); return; }
      attempts.push(Date.now());
      // Use the authentication module's lock filename so enrollment and login
      // cannot race a replay-counter update.
      let lock;
      try { lock = await enrollmentLock(`${configPath}.lock`); }
      catch (error) {
        if (error.code === 'EEXIST') { send(response, 409, 'Setup is busy. Try again.'); return; }
        throw error;
      }
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        const current = readDesktopConfig(configPath);
        if (Date.now() >= deadline) { send(response, 410, 'Enrollment has expired.'); return; }
        if (current.enrolled || finished) { render(response, 200, { complete: true }); return; }
        if (current.totpSecret !== initial.totpSecret || current.sessionSecret !== initial.sessionSecret || current.passwordHash !== initial.passwordHash) {
          send(response, 409, 'Enrollment configuration changed. Restart local setup.'); return;
        }
        const counter = matchTotpCounter(current.totpSecret, form.code, { now: Date.now(), lastCounter: current.lastTotpCounter });
        if (counter === null) { render(response, 400, { message: 'That code did not match. Enter the current six-digit code from your app.' }); return; }
        await writeDesktopConfig(configPath, { ...current, enrolled: true, lastTotpCounter: counter });
        finished = true;
        render(response, 200, { complete: true });
        clearTimeout(timer);
        timer = setTimeout(() => close('enrolled'), Math.min(5000, Math.max(1, deadline - Date.now())));
      } finally {
        await lock.close();
        await unlink(`${configPath}.lock`);
      }
    })().catch(error => {
      if (!response.headersSent) send(response, [400, 413, 415].includes(error.status) ? error.status : 500, 'Unable to complete enrollment.');
      else response.destroy();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const close = reason => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    server.close(() => resolveClosed(reason));
    for (const socket of sockets) socket.destroy();
  };
  await new Promise((resolveListen, reject) => {
    const failed = () => reject(new Error('Unable to start local enrollment. Port 3084 may already be in use.'));
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolveListen(); });
  });
  timer = setTimeout(() => close('expired'), Math.max(1, deadline - Date.now()));
  return { enrolled: false, url: `${origin}/`, server, close, closed };
}

async function main() {
  process.umask(0o077);
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !['setup', 'enroll'].includes(command)) throw new Error('Usage: node home-desktop/enroll.mjs setup|enroll');
  if (command === 'setup') { await setupDesktop(); return; }
  const session = await startEnrollment();
  if (session.url) console.log(session.url);
  const stop = () => session.close?.('stopped');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await session.closed;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
