#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

process.umask(0o077);
const sourceDir = dirname(fileURLToPath(import.meta.url));
const siteDir = dirname(sourceDir);
const stateDir = process.env.HOME_BROWSER_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'aarav-home-browser');
const configPath = join(stateDir, 'config.json');
const metadataPath = join(stateDir, 'runtime.json');
const accessPath = join(stateDir, 'access.txt');
const lockPath = join(stateDir, 'supervisor.pid');
const label = 'dev.aaravsinha.home-browser';
const launchTarget = `gui/${process.getuid()}/${label}`;
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const toolPath = [...new Set([dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(process.env.PATH || '').split(delimiter)])].join(delimiter);
const env = { ...process.env, PATH: toolPath };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = async (path) => access(path).then(() => true, () => false);
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function writePrivate(path, content) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function tool(name) {
  for (const dir of toolPath.split(delimiter)) {
    const candidate = join(dir, name);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Missing ${name}. Install it before starting Home Browser.`);
}

function command(binary, args, { input, timeout = 30000, allowFailure = false, cwd = sourceDir } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || (code !== 0 && !allowFailure)) reject(new Error(`${binary.split('/').pop()} ${args[0] || ''} failed. Check installation, authentication, and network connectivity.`));
      else resolveCommand({ code, output: output.trim(), errors: errors.trim() });
    };
    child.stdout.on('data', (data) => { output = (output + data).slice(-2_000_000); });
    child.stderr.on('data', (data) => { errors = (errors + data).slice(-100_000); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(null, code));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function createPassword() {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(24);
  const key = await promisify(scryptCallback)(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const passwordHash = `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
  return { password, passwordHash };
}

async function setup() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  if (!(await exists(configPath))) {
    const { password, passwordHash } = await createPassword();
    await writePrivate(configPath, JSON.stringify({ passwordHash, sessionSecret: randomBytes(48).toString('base64url'), publicUrl: '', port: 3081, upstream: 'http://127.0.0.1:3080' }, null, 2) + '\n');
    await writePrivate(accessPath, `Home Browser login password\n\n${password}\n\nKeep this file private. Use this password only at the Home Browser login opened from https://aaravsinha.dev/browser/.\n`);
  }
  let metadata;
  if (await exists(metadataPath)) {
    metadata = await json(metadataPath);
  } else {
    const gh = await tool('gh');
    const result = await command(gh, ['api', '--method', 'POST', '/gists', '--input', '-'], {
      input: JSON.stringify({ description: 'Home Browser connection discovery (contains no credentials)', public: false, files: { 'connection.json': { content: JSON.stringify({ url: '', updatedAt: new Date().toISOString() }) } } }),
    });
    const gist = JSON.parse(result.output);
    if (!gist.id || !gist.owner?.login) throw new Error('GitHub did not return a discovery Gist ID.');
    metadata = { gistId: gist.id, owner: gist.owner.login, discoveryUrl: `https://gist.githubusercontent.com/${gist.owner.login}/${gist.id}/raw/connection.json` };
    await writePrivate(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  }
  await mkdir(join(siteDir, 'browser'), { recursive: true });
  await writeFile(join(siteDir, 'browser', 'connection.json'), JSON.stringify({ discoveryUrl: metadata.discoveryUrl }, null, 2) + '\n');
  console.log(`Setup complete. Password saved privately in: ${accessPath}`);
  console.log('Commit browser/connection.json with the website. It contains only a public discovery URL.');
}

async function requireSetup() {
  if (!(await exists(configPath)) || !(await exists(metadataPath))) throw new Error('Run node home-browser/manage.mjs setup first.');
}

async function compose(args, options = {}) {
  return command(await tool('docker'), ['compose', '--file', join(sourceDir, 'compose.yaml'), ...args], options);
}

async function install() {
  await requireSetup();
  await Promise.all(['docker', 'gh', 'cloudflared'].map(tool));
  await mkdir(dirname(plistPath), { recursive: true });
  const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const s = (value) => `<string>${escapeXml(value)}</string>`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key>${s(label)}\n<key>ProgramArguments</key><array>${s(process.execPath)}${s(join(sourceDir, 'manage.mjs'))}${s('run')}</array>\n<key>WorkingDirectory</key>${s(sourceDir)}\n<key>EnvironmentVariables</key><dict><key>PATH</key>${s(toolPath)}<key>HOME_BROWSER_STATE_DIR</key>${s(stateDir)}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>15</integer>\n<key>ExitTimeOut</key><integer>65</integer>\n<key>StandardOutPath</key>${s(join(stateDir, 'supervisor.log'))}\n<key>StandardErrorPath</key>${s(join(stateDir, 'supervisor.log'))}\n</dict></plist>\n`;
  await writePrivate(plistPath, plist);
  // Create the log privately before launchd opens it.
  const logFile = await open(join(stateDir, 'supervisor.log'), 'a', 0o600);
  await logFile.close();
  console.log(`Installed login launch agent: ${plistPath}`);
  console.log('Run node home-browser/manage.mjs start to start it now.');
}

async function start() {
  if (!(await exists(plistPath))) await install();
  const loaded = await command('/bin/launchctl', ['print', launchTarget], { allowFailure: true });
  if (loaded.code !== 0) await command('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
  await command('/bin/launchctl', ['kickstart', launchTarget]);
  console.log('Home Browser started. Use status to check its connection.');
}

async function stop() {
  const saved = await json(lockPath).catch(() => null);
  const candidate = await processIdentity(typeof saved === 'number' ? saved : saved?.pid);
  const identity = candidate && candidate.command.endsWith('manage.mjs run') &&
    (typeof saved === 'number' || candidate.startedAt === saved?.startedAt) ? candidate : null;
  const deadline = Date.now() + 65000;
  await command('/bin/launchctl', ['bootout', launchTarget], { allowFailure: true, timeout: 70000 });
  // The supervisor runs the Compose pre-stop hook itself. Wait for it before
  // issuing a fallback stop, otherwise two shutdowns can race Chrome's save.
  if (identity) {
    while (true) {
      const current = await processIdentity(identity.pid);
      if (!current || current.startedAt !== identity.startedAt) break;
      if (Date.now() >= deadline) throw new Error('Browser shutdown is still in progress. Check the supervisor log before retrying.');
      await sleep(500);
    }
  }
  await compose(['stop'], { timeout: 55000 });
  console.log('Home Browser stopped. Saved browser data is retained.');
}

async function status() {
  const agent = await command('/bin/launchctl', ['print', launchTarget], { allowFailure: true });
  console.log(`Launch agent: ${agent.code === 0 ? 'loaded' : 'stopped'}`);
  const docker = await compose(['ps', '--format', 'json'], { allowFailure: true }).catch(() => null);
  console.log(`Browser container: ${docker?.output?.includes('running') ? 'running' : 'not running'}`);
  if (await exists(configPath)) {
    const config = await json(configPath);
    console.log(`Gateway connection: ${config.publicUrl || 'waiting for tunnel'}`);
    const health = await fetch('http://127.0.0.1:3081/browser/session/auth/health', { signal: AbortSignal.timeout(2500) }).then((response) => response.ok, () => false);
    console.log(`Gateway health: ${health ? 'responding' : 'unavailable'}`);
  }
  console.log(`Private password file: ${accessPath}`);
  console.log(`Supervisor log: ${join(stateDir, 'supervisor.log')}`);
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const [started, running] = await Promise.all([
    command('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { allowFailure: true }),
    command('/bin/ps', ['-p', String(pid), '-o', 'command='], { allowFailure: true }),
  ]);
  if (started.code !== 0 || running.code !== 0) return null;
  return { pid, startedAt: started.output, command: running.output };
}

async function run() {
  await requireSetup();
  const ownIdentity = await processIdentity(process.pid);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let saved;
    try { saved = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch { saved = null; }
    const pid = typeof saved === 'number' ? saved : saved?.pid;
    const identity = await processIdentity(pid);
    // PID existence alone is insufficient: after a crash or reboot another
    // application can inherit the number. New locks also bind the start time.
    const script = join(sourceDir, 'manage.mjs');
    const matchesCommand = identity && [script, 'home-browser/manage.mjs', 'manage.mjs']
      .some(candidate => identity.command.endsWith(` ${candidate} run`));
    const matchesStart = typeof saved === 'number' || saved?.startedAt === identity?.startedAt;
    if (matchesCommand && matchesStart) throw new Error('A Home Browser supervisor is already running.');
    await rm(lockPath, { force: true });
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: ownIdentity?.startedAt }));
  await lock.close();
  let stopping = false;
  let publicUrl = '';
  let publishedUrl = null;
  let publication = Promise.resolve();
  const children = new Set();
  const metadata = await json(metadataPath);
  const gh = await tool('gh');

  async function setUrl(url) {
    publicUrl = url;
    const config = await json(configPath);
    await writePrivate(configPath, JSON.stringify({ ...config, publicUrl: url }, null, 2) + '\n');
    publish();
  }
  function publish() {
    publication = publication.then(async () => {
      const url = publicUrl;
      if (publishedUrl === url) return;
      try {
        await command(gh, ['api', '--method', 'PATCH', `/gists/${metadata.gistId}`, '--input', '-'], {
          input: JSON.stringify({ files: { 'connection.json': { content: JSON.stringify({ url, updatedAt: new Date().toISOString() }) } } }), timeout: 12000,
        });
        publishedUrl = url;
        log(url ? 'Published active browser connection.' : 'Published offline browser status.');
      } catch { log('Could not refresh discovery; retrying automatically.'); }
    });
    return publication;
  }
  const heartbeat = setInterval(publish, 60000);

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    log('Stopping browser services.');
    for (const child of children) child.kill('SIGTERM');
    await setUrl('').catch(() => {});
    await Promise.allSettled([publish(), compose(['stop'], { timeout: 55000 }).catch(() => log('Chrome shutdown failed; check the Compose pre-stop hook before restarting.'))]);
    await rm(lockPath, { force: true });
    process.exit(0);
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('uncaughtException', () => { log('Unexpected supervisor error. Restarting cleanly.'); shutdown(); });
  process.once('unhandledRejection', () => { log('Unexpected supervisor failure. Restarting cleanly.'); shutdown(); });

  function supervise(name, binary, args, extraEnv = {}, onOutput, onClose) {
    return (async () => {
      let backoff = 1000;
      while (!stopping) {
        const started = Date.now();
        const child = spawn(binary, args, { cwd: sourceDir, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        log(`${name} started.`);
        if (onOutput) { child.stdout.on('data', onOutput); child.stderr.on('data', onOutput); }
        else { child.stdout.resume(); child.stderr.resume(); }
        await new Promise((done) => { child.once('error', done); child.once('close', done); });
        children.delete(child);
        if (onClose) await onClose();
        if (stopping) break;
        if (Date.now() - started > 60000) backoff = 1000;
        log(`${name} exited; retrying in ${Math.round(backoff / 1000)} seconds.`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    })();
  }

  await setUrl('');
  const docker = await tool('docker');
  let openedDocker = false;
  while (!stopping) {
    const result = await command(docker, ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeout: 8000 });
    if (result.code === 0) break;
    if (!openedDocker) {
      openedDocker = true;
      log('Waiting for Docker Desktop. Opening the installed application.');
      await command('/usr/bin/open', ['-a', 'Docker'], { allowFailure: true });
    }
    await sleep(5000);
  }
  if (stopping) return;
  await compose(['up', '-d'], { timeout: 180000 });
  log('Persistent Chrome container started.');
  let tunnelOutput = '';
  const tunnel = await tool('cloudflared');
  const parseTunnel = (chunk) => {
    tunnelOutput = (tunnelOutput + chunk.toString()).slice(-16000);
    const urls = tunnelOutput.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/g);
    const url = urls?.at(-1);
    if (url && url !== publicUrl) setUrl(url).catch(() => log('Could not save tunnel URL; waiting for retry.'));
  };
  await Promise.all([
    supervise('Gateway', process.execPath, [join(sourceDir, 'gateway', 'server.mjs')], { HOME_BROWSER_CONFIG: configPath, HOME_BROWSER_BASE_PATH: '/browser/session' }),
    supervise('Tunnel', tunnel, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3081'], {}, parseTunnel, async () => { tunnelOutput = ''; await setUrl(''); }),
    supervise('Idle sleep protection', '/usr/bin/caffeinate', ['-i']),
  ]);
}

const action = process.argv[2] || 'help';
try {
  if (process.platform !== 'darwin') throw new Error('This supervisor targets macOS and Docker Desktop.');
  switch (action) {
    case 'setup': await setup(); break;
    case 'install': await install(); break;
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'status': await status(); break;
    case 'run': await run(); break;
    default: console.log('Usage: node home-browser/manage.mjs <setup|install|start|stop|status|run>');
  }
} catch (error) {
  console.error(error.message);
  // A failed startup must not leave the heartbeat holding a broken supervisor
  // open. launchd restarts it and the next run removes its stale PID lock.
  process.exit(1);
}
