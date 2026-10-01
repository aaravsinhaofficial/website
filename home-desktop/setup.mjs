#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePasswordHash, readDesktopConfig } from './auth.mjs';

const defaultStateDir = () => process.env.HOME_DESKTOP_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'aarav-home-desktop');
const defaultBrowserConfig = () => join(process.env.HOME_BROWSER_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'aarav-home-browser'), 'config.json');

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

/** Create once without replacing or migrating an existing configuration. */
export async function setupDesktop({ stateDir = defaultStateDir(), browserConfigPath = defaultBrowserConfig() } = {}) {
  await privateDirectory(stateDir);
  const configPath = join(stateDir, 'config.json');
  try {
    await lstat(configPath);
    readDesktopConfig(configPath);
    return { configPath, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = {
    passwordHash: await browserPasswordHash(browserConfigPath),
    sessionSecret: randomBytes(48).toString('base64url'),
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
    // Publish the complete file atomically without replacing a configuration
    // created concurrently by another setup process.
    try { await link(temporary, configPath); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = await open(stateDir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  readDesktopConfig(configPath);
  return { configPath, created };
}

async function main() {
  process.umask(0o077);
  if (process.argv.length !== 2) throw new Error('Usage: node home-desktop/setup.mjs');
  await setupDesktop();
  console.log('Home Desktop setup is ready.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
