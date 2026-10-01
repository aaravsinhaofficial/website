import { constants, readFileSync, openSync, fstatSync, closeSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function parsePasswordHash(hash) {
  const parts = String(hash || '').split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$1' ||
      !/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) {
    throw new Error('Invalid desktop authentication configuration.');
  }
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || salt.length > 64 || key.length !== 64 ||
      salt.toString('base64url') !== parts[4] || key.toString('base64url') !== parts[5]) {
    throw new Error('Invalid desktop authentication configuration.');
  }
  return { salt, key };
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) throw new Error('Invalid password.');
  const salt = randomBytes(24);
  const key = await deriveKey(password, salt, 64, SCRYPT);
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) return false;
  const { salt, key } = parsePasswordHash(hash);
  return timingSafeEqual(await deriveKey(password, salt, key.length, SCRYPT), key);
}

export function readDesktopConfig(configPath) {
  let descriptor;
  try {
    descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error();
    const config = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    parsePasswordHash(config.passwordHash);
    if (typeof config.sessionSecret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(config.sessionSecret)) throw new Error();
    return config;
  } catch {
    throw new Error('Desktop authentication configuration is missing, invalid, or not private.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Atomically persist private configuration for local setup and key rotation. */
export async function writeDesktopConfig(configPath, config) {
  const temporary = `${configPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, configPath);
    const directory = await open(dirname(configPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function authenticationState(config) {
  return {
    sessionSecret: config.sessionSecret,
    fingerprint: createHmac('sha256', config.sessionSecret)
      .update(config.passwordHash).digest('base64url'),
  };
}

export function createDesktopAuth({ configPath }) {
  readDesktopConfig(configPath);
  return {
    state() { return authenticationState(readDesktopConfig(configPath)); },
    async authenticate(password) {
      const checked = readDesktopConfig(configPath);
      if (!(await verifyPassword(password, checked.passwordHash))) return null;
      const current = readDesktopConfig(configPath);
      // Scrypt runs asynchronously. A local credential change during that wait
      // must not issue a session signed with stale authentication settings.
      if (current.passwordHash !== checked.passwordHash || current.sessionSecret !== checked.sessionSecret) return null;
      return authenticationState(current);
    },
  };
}
