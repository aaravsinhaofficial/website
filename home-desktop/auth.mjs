import { constants, readFileSync, openSync, fstatSync, closeSync } from 'node:fs';
import { open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { randomBytes, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function decodeBase32(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32,128}$/.test(secret)) throw new Error('Invalid desktop authentication configuration.');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (value !== 0 || bytes.length < 20) throw new Error('Invalid desktop authentication configuration.');
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return result;
}

/** RFC 6238: SHA-1, six digits, 30-second time steps. */
export function totpCode(secret, { now = Date.now(), counter = Math.floor(now / 30_000) } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid authenticator time.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function matchTotpCounter(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  let matched = null;
  for (const counter of [current - 1, current, current + 1]) {
    if (counter < 0) continue;
    const matches = timingSafeEqual(Buffer.from(code), Buffer.from(totpCode(secret, { counter })));
    if (matches && counter > lastCounter) matched = counter;
  }
  return matched;
}

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
    decodeBase32(config.totpSecret);
    if (typeof config.sessionSecret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(config.sessionSecret) ||
        typeof config.enrolled !== 'boolean' || !Number.isSafeInteger(config.lastTotpCounter ?? -1) ||
        (config.lastTotpCounter ?? -1) < -1) throw new Error();
    return { ...config, lastTotpCounter: config.lastTotpCounter ?? -1 };
  } catch {
    throw new Error('Desktop authentication configuration is missing, invalid, or not private.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Commit before issuing a session so a process restart cannot reuse a code. */
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

async function withConfigLock(configPath, operation) {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + 3000;
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await lock.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) { await lock.close(); await unlink(lockPath); lock = null; throw error; }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A crashed process must not permanently block authentication. Never take
      // over a lock belonging to a live process, even if a write is slow.
      const recovered = await recoverAbandonedLock(lockPath);
      if (recovered) continue;
      if (Date.now() >= deadline) throw new Error('Desktop authentication is temporarily unavailable.');
      await wait(25);
    }
  }
  try { return await operation(); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function recoverAbandonedLock(lockPath) {
  // Only one contender may inspect/remove an abandoned lock. Otherwise a
  // second reaper could unlink the first contender's newly acquired lock.
  const recoveryPath = `${lockPath}.recovery`;
  let guard;
  try { guard = await open(recoveryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    const info = await stat(lockPath);
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')).pid; } catch {}
    let alive = true;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    } else if (Date.now() - info.mtimeMs > 30_000) alive = false;
    if (!alive) { await unlink(lockPath); return true; }
    return false;
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  finally { await guard.close(); await unlink(recoveryPath); }
}

function authenticationState(config) {
  return {
    enrolled: config.enrolled,
    sessionSecret: config.sessionSecret,
    fingerprint: createHmac('sha256', config.sessionSecret)
      .update(`${config.passwordHash}\0${config.totpSecret}\0${config.enrolled}`).digest('base64url'),
  };
}

export function createDesktopAuth({ configPath, now = Date.now }) {
  readDesktopConfig(configPath);
  return {
    state() { return authenticationState(readDesktopConfig(configPath)); },
    async authenticate(password, code) {
      const checked = readDesktopConfig(configPath);
      if (!checked.enrolled || !(await verifyPassword(password, checked.passwordHash))) return null;
      return withConfigLock(configPath, async () => {
        const current = readDesktopConfig(configPath);
        if (!current.enrolled || current.passwordHash !== checked.passwordHash ||
            current.totpSecret !== checked.totpSecret || current.sessionSecret !== checked.sessionSecret) return null;
        const counter = matchTotpCounter(current.totpSecret, code, { now: now(), lastCounter: current.lastTotpCounter });
        if (counter === null) return null;
        await writeDesktopConfig(configPath, { ...current, lastTotpCounter: counter });
        return authenticationState(current);
      });
    },
  };
}
