#!/usr/bin/env node
'use strict';
/**
 * ENJOY Signage updater: installs the newest version from your GitHub repository.
 *
 *   Windows:  node app\platform\windows\enjoy.js update     (or Start → ENJOY Signage → Update)
 *   Mac:      node app/platform/mac/enjoy.js update
 *   Ubuntu:   sudo church-signage update
 *
 * Options:  --check            only say whether an update is available
 *           --force            reinstall even if it's already the newest version (or an older one)
 *           --token TOKEN      a read-only GitHub token, for a private repository (saved for next time)
 *           --repo owner/name  install from another repository (saved for next time)
 *           --branch name      install from another branch (saved for next time; default main)
 *
 * How it works: it downloads the repository as a .tar.gz from GitHub, unpacks it (plain Node, no
 * dependencies), keeps a copy of the current program, and runs the new version's own installer, which
 * stops the server, replaces the program, keeps your content and settings, and starts it again. If the
 * new version doesn't start, it puts the previous one back the same way.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');
const { spawnSync } = require('child_process');

const API = (process.env.ENJOY_SIGNAGE_UPDATE_API || 'https://api.github.com').replace(/\/$/, ''); // overridable for testing
const MAX_DOWNLOAD = 300 * 1024 * 1024;
const NAME = 'ENJOY Signage';

process.stdout.on('error', () => {});
const ok = (s) => console.log(`  \u001b[32m✓\u001b[0m ${s}`);
const warn = (s) => console.log(`  \u001b[33m!\u001b[0m ${s}`);
const info = (s) => console.log(`    ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Fail extends Error { constructor(m) { super(m); this.name = 'Fail'; } }

// ---------------------------------------------------------------- where things are on each platform

function layout(platform) {
  if (platform === 'ubuntu') {
    const conf = '/etc/church-signage';
    return {
      app: '/opt/church-signage',
      settings: path.join(conf, 'update.json'),
      token: path.join(conf, 'update-token'),
      port: () => { try { return parseInt((/^PORT=(\d+)/m.exec(fs.readFileSync(path.join(conf, 'church-signage.env'), 'utf8')) || [])[1], 10) || 3000; } catch { return 3000; } },
      installer: 'install-ubuntu.sh',
      run: (dir) => spawnSync('bash', [path.join(dir, 'install-ubuntu.sh')], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] }),
    };
  }
  const home = process.env.ENJOY_SIGNAGE_HOME || (platform === 'mac'
    ? path.join(os.homedir(), 'Library', 'Application Support', NAME)
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), NAME));
  const installer = platform === 'mac' ? 'install-mac.js' : 'install-windows.js';
  const extra = platform === 'mac' ? ['--no-dock'] : [];
  return {
    app: path.join(home, 'app'),
    settings: path.join(home, 'update.json'),
    token: path.join(home, 'update-token'),
    port: () => { try { return parseInt(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).port, 10) || 3000; } catch { return 3000; } },
    installer,
    run: (dir) => spawnSync(process.execPath, [path.join(dir, installer), '--no-open', '--yes', ...extra], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] }),
  };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };

/** 1.10.2 > 1.9.9; anything unreadable counts as 0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// ---------------------------------------------------------------- GitHub

// GitHub's other addresses for the same files (public repositories only), used if the API keeps failing.
const RAW = (process.env.ENJOY_SIGNAGE_UPDATE_RAW || 'https://raw.githubusercontent.com').replace(/\/$/, '');
const CODELOAD = (process.env.ENJOY_SIGNAGE_UPDATE_CODELOAD || 'https://codeload.github.com').replace(/\/$/, '');
const STATUS_TEXT = { 500: 'server error', 502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout' };

/** One request, with a time limit. Resolves to the response, or throws a Fail for a network problem. */
async function get(url, token, accept, ms) {
  const headers = { 'User-Agent': 'enjoy-signage-updater', Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'it took too long' : e.cause && e.cause.code ? e.cause.code : e.message;
    throw Object.assign(new Fail(`Couldn't reach GitHub (${why}). Check this computer's internet connection.`), { retry: true });
  }
}

function explainHttp(res, repo, token) {
  if (res.status === 404 && !token) return `Couldn't find the repository ${repo} on GitHub. If it's private, run the update again with  --token YOUR-TOKEN  (see the guide for how to make one).`;
  if (res.status === 404) return `Couldn't find ${repo} with the saved token. Check the repository name, and that the token has access to it.`;
  if (res.status === 401) return 'GitHub didn’t accept the access token (it may have expired). Run the update again with  --token NEW-TOKEN.';
  if (res.status === 403 || res.status === 429) return 'GitHub is limiting requests from this network right now. Try again in an hour, or use a token (--token), which has a higher limit.';
  if (res.status >= 500) return `GitHub's servers didn't answer properly (${res.status} ${STATUS_TEXT[res.status] || ''}). That's usually temporary: try the update again in a few minutes.`;
  return `GitHub answered ${res.status}.`;
}

/**
 * Fetch with patience: GitHub's servers (especially the one that packs downloads) occasionally time out.
 * Tries each address up to 3 times, waiting a little longer each time, on server errors and network
 * problems; anything else (not found, bad token) stops at once. `read` turns a good response into the result.
 */
async function patiently(what, urls, token, accept, ms, read, repo) {
  let last = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let problem;
      try {
        const res = await get(url, token, accept, ms);
        if (res.ok) {
          try { return await read(res); } catch (e) { if (e instanceof Fail && !e.retry) throw e; problem = e; } // a download cut off part-way: retry
        } else if (res.status >= 500 || res.status === 408) {
          problem = Object.assign(retryable(new Fail(explainHttp(res, repo, token))), { short: `GitHub answered ${res.status}${STATUS_TEXT[res.status] ? ' ' + STATUS_TEXT[res.status] : ''}` });
        } else throw new Fail(explainHttp(res, repo, token));
      } catch (e) {
        if (!(e instanceof Fail) || !e.retry) throw e;
        problem = e;
      }
      last = problem;
      const wait = [3, 8, 15][attempt - 1];
      if (attempt < 3) { info(`${what} didn’t work (${String(problem.short || problem.message).replace(/\.$/, '')}); trying again in ${wait} s…`); await sleep(wait * 1000); }
    }
    if (urls.length > 1 && url !== urls[urls.length - 1]) info(`Trying GitHub’s other address for ${what.toLowerCase()}…`);
  }
  throw last;
}
// Marks a Fail as worth retrying (server errors, network problems, a download cut off).
const retryable = (f) => Object.assign(f, { retry: true });

async function remoteVersion(repo, branch, token) {
  const urls = [`${API}/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`];
  if (!token) urls.push(`${RAW}/${repo}/${encodeURIComponent(branch)}/package.json`);
  return patiently('Checking the version', urls, token, 'application/vnd.github.raw+json', 20000, async (res) => {
    let pkg;
    try { pkg = JSON.parse(await res.text()); } catch { throw new Fail(`${repo} doesn't look like ENJOY Signage (its package.json couldn't be read).`); }
    if (!pkg.version || !/signage/i.test(pkg.name || '')) throw new Fail(`${repo} doesn't look like ENJOY Signage.`);
    return pkg.version;
  }, repo);
}

async function download(repo, branch, token) {
  const urls = [`${API}/repos/${repo}/tarball/${encodeURIComponent(branch)}`];
  if (!token) urls.push(`${CODELOAD}/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`);
  return patiently('The download', urls, token, 'application/vnd.github+json', 180000, async (res) => {
    const chunks = [];
    let total = 0;
    try {
      for await (const c of res.body) {
        total += c.length;
        if (total > MAX_DOWNLOAD) throw new Fail('The download is unexpectedly large, so it was stopped.');
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof Fail) throw e;
      throw retryable(new Fail('The download was cut off part-way'));
    }
    return Buffer.concat(chunks);
  }, repo);
}

// ---------------------------------------------------------------- unpacking a .tar.gz (no dependencies)

/** Unpacks a GitHub tarball into dest, dropping its top folder (owner-repo-commit/). Only plain files and folders. */
function untar(gz, dest) {
  let buf;
  try { buf = zlib.gunzipSync(gz); } catch { throw new Fail('The download was damaged (it isn’t a valid .tar.gz). Try again.'); }
  const root = path.resolve(dest);
  let off = 0;
  let pending = null; // long name from a pax ('x') or GNU ('L') header, for the next entry
  let files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue; // global header (GitHub puts the commit id here)
    if (type === 'x') {
      for (const rec of body.toString('utf8').split('\n')) { const m = /^\d+ path=(.*)$/.exec(rec); if (m) pending = m[1]; }
      continue;
    }
    if (type === 'L') { pending = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const prefix = field(345, 500);
    const full = pending || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    pending = null;
    const rel = full.split('/').slice(1).join('/');
    if (!rel || rel === '/') continue;
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Fail('The download contained an unsafe file path, so nothing was installed.');
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: (parseInt(field(100, 108), 8) & 0o755) | 0o644 });
      files++;
    } // symlinks and anything else are skipped: the program doesn't use them
  }
  if (!files) throw new Fail('The download was empty.');
}

// ---------------------------------------------------------------- checking the result

function probe(port, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/status', timeout: ms }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
async function cameUp(L, version) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const v = (readJson(path.join(L.app, 'package.json')) || {}).version;
    if (v === version && (await probe(L.port()))) return true;
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------- main

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--force') o.force = true;
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--yes' || a === '-y') o.yes = true;
    else throw new Fail(`Unknown option ${a}`);
  }
  if (o.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Fail('Use --repo owner/name, for example --repo greube/enjoy-signage');
  if (o.token !== undefined && !/^[\w-]{20,255}$/.test(o.token || '')) throw new Fail('That doesn’t look like a GitHub token.');
  return o;
}

function save(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

async function update(platform, argv) {
  const o = parse(argv);
  const L = layout(platform);
  const installed = readJson(path.join(L.app, 'package.json'));
  if (!installed) throw new Fail(`${NAME} isn't installed here, so there's nothing to update. Install it first.`);
  const settings = readJson(L.settings) || {};
  const defaults = installed.enjoySignage || {};
  const repo = o.repo || settings.repo || defaults.updateRepo;
  const branch = o.branch || settings.branch || defaults.updateBranch || 'main';
  if (!repo) throw new Fail('No update repository is set. Run the update with  --repo owner/name.');
  if (o.repo || o.branch) save(L.settings, JSON.stringify({ ...settings, repo, branch }, null, 2));
  let token = o.token || readText(L.token);

  console.log(`\n  Checking ${repo} (${branch}) for a newer ${NAME}…`);
  let latest;
  try {
    latest = await remoteVersion(repo, branch, token);
  } catch (e) {
    // A private repository looks like "not found" without a token: offer to enter one.
    if (!(e instanceof Fail) || token || !process.stdin.isTTY || o.yes || !/private/.test(e.message)) throw e;
    console.log('\n  If the repository is private, paste a read-only GitHub token for it (or press Enter to stop).');
    const t = await ask('  Token: ');
    if (!t) throw e;
    if (!/^[\w-]{20,255}$/.test(t)) throw new Fail('That doesn’t look like a GitHub token.');
    token = t;
    latest = await remoteVersion(repo, branch, token);
    o.token = token;
  }
  if (o.token) { save(L.token, o.token); ok('Access token saved for future updates'); }

  const current = installed.version;
  const cmp = compareVersions(latest, current);
  if (o.check) {
    if (cmp > 0) ok(`Version ${latest} is available (this computer has ${current}).`);
    else ok(`Up to date (version ${current}).`);
    return;
  }
  if (cmp === 0 && !o.force) return ok(`Already up to date (version ${current}).`);
  if (cmp < 0 && !o.force) return ok(`This computer has ${current}, which is newer than ${latest} on ${branch}. Nothing to do (use --force to install ${latest} anyway).`);
  info(`Installing ${latest} (this computer has ${current})…`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'enjoy-signage-update-'));
  const pkgDir = path.join(work, 'new');
  const backup = `${L.app}.previous`;
  try {
    const gz = await download(repo, branch, token);
    untar(gz, pkgDir);
    const got = readJson(path.join(pkgDir, 'package.json'));
    if (!got || !fs.existsSync(path.join(pkgDir, L.installer))) throw new Fail(`The download isn't a complete ${NAME} (no ${L.installer}), so nothing was changed.`);
    ok(`Downloaded ${latest}`);

    // Keep the current program so it can be put back if the new one doesn't start.
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(L.app, backup, { recursive: true });

    console.log(`\n  Running the ${latest} installer:`);
    const r = L.run(pkgDir);
    if (r.status === 0 && (await cameUp(L, got.version))) {
      console.log();
      ok(`Updated from ${current} to ${got.version}. TVs reload by themselves within a few seconds.`);
      info(`(The previous version is kept in ${backup} for now.)`);
      return;
    }

    console.log();
    warn(`Version ${got.version} didn't start properly, so putting ${current} back…`);
    const back = fs.existsSync(path.join(backup, L.installer)) ? L.run(backup) : null;
    if (back && back.status === 0 && (await cameUp(L, current))) {
      ok(`Back on ${current}, and running. Your content wasn't affected.`);
      throw new Fail(`The update to ${got.version} didn't work. Tell whoever made it what you saw above.`);
    }
    throw new Fail(`The update to ${got.version} didn't start, and putting ${current} back didn't work either. The previous program is in ${backup}; run its installer to restore it, or reinstall from the download.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { update, untar, compareVersions };

if (require.main === module) {
  const [platform, ...argv] = process.argv.slice(2);
  if (!['windows', 'mac', 'ubuntu'].includes(platform)) {
    console.error('Usage: node update.js windows|mac|ubuntu [--check] [--force] [--token T] [--repo owner/name] [--branch b]');
    process.exit(2);
  }
  update(platform, argv).catch((e) => {
    console.error(`\n  \u001b[31mError:\u001b[0m ${e instanceof Fail ? e.message : e.stack || e.message}\n`);
    process.exitCode = 1;
  });
}
