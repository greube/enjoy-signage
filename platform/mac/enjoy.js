#!/usr/bin/env node
'use strict';
/**
 * ENJOY Signage for macOS: installer, the app's launcher, and server controls.
 *
 * The server runs as a launchd LaunchAgent (macOS's own service manager): it starts when you log in and
 * launchd restarts it if it ever stops. The "ENJOY Signage" app is a small bundle written on this Mac by
 * the installer, so Gatekeeper never sees it as a download from an unidentified developer.
 *
 *   node install-mac.js              install or update (run once from the extracted folder)
 *   enjoy.js open                    what the app does: start the server if needed, open the admin panel
 *   enjoy.js start | stop | restart  control the background server
 *   enjoy.js status                  is it running? addresses, folders
 *   enjoy.js port 8080               change the web port
 *   enjoy.js password                set the built-in "admin" recovery password
 *   enjoy.js update [--check]        install the newest version from GitHub (see ../update.js)
 *   enjoy.js uninstall [--purge]     remove it (keeps your content unless --purge)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

// ENJOY_SIGNAGE_TEST_MAC=1 runs the macOS code paths on another OS (for testing, with stand-in tools).
const TEST_MAC = process.env.ENJOY_SIGNAGE_TEST_MAC === '1';
const IS_MAC = process.platform === 'darwin' || TEST_MAC;
const NAME = 'ENJOY Signage';
const LABEL = 'org.enjoychurch.signage';
const SRC = path.resolve(__dirname, '..', '..'); // the downloaded enjoy-signage folder
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
const USER_HOME = os.homedir();
const HOME = process.env.ENJOY_SIGNAGE_HOME || path.join(USER_HOME, 'Library', 'Application Support', NAME);
const P = {
  app: path.join(HOME, 'app'),
  data: path.join(HOME, 'data'),
  logs: path.join(HOME, 'logs'),
  log: path.join(HOME, 'logs', 'server.log'),
  config: path.join(HOME, 'config.json'),
  password: path.join(HOME, 'admin-password'),
  plist: path.join(USER_HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`),
};
const SCRIPT = path.join(P.app, 'platform', 'mac', 'enjoy.js');
// The installer and updater go along too, so the installed copy can reinstall itself if an update has to be undone.
const APP_FILES = ['package.json', 'README.md', 'install-mac.js', 'server', 'public', 'docs', path.join('platform', 'mac'), path.join('platform', 'update.js')];
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const DOMAIN = `gui/${UID}`;
const SERVICE = `${DOMAIN}/${LABEL}`;

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const ok = (s) => console.log(`  \u001b[32m✓\u001b[0m ${s}`);
const warn = (s) => console.log(`  \u001b[33m!\u001b[0m ${s}`);
const info = (s) => console.log(`    ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Fail extends Error {}

// ---------------------------------------------------------------- settings

function config() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(P.config, 'utf8')); } catch {}
  const port = parseInt(c.port, 10);
  return { ...c, port: port >= 1 && port <= 65535 ? port : 3000, keepAwake: c.keepAwake !== false };
}
function saveConfig(c) {
  fs.writeFileSync(P.config + '.tmp', JSON.stringify(c, null, 2));
  fs.renameSync(P.config + '.tmp', P.config);
}
const installed = () => fs.existsSync(path.join(P.app, 'server', 'server.js')) && fs.existsSync(P.config);

/** The node to run. Prefer a stable link (Homebrew's /opt/homebrew/bin/node) over a versioned Cellar path that an upgrade removes. */
function nodePath() {
  let real = process.execPath;
  try { real = fs.realpathSync(process.execPath); } catch {}
  for (const c of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try { if (fs.realpathSync(c) === real) return c; } catch {}
  }
  return process.execPath;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  const rank = (ip) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------- is it running?

function probe(port, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/status', timeout: ms }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 8192) body += d; });
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(res.statusCode === 200 && 'needsSetup' in j ? j : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
async function waitFor(test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await test();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}

// ---------------------------------------------------------------- launchd

const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });
const loaded = () => launchctl('print', SERVICE).status === 0;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function writePlist() {
  const c = config();
  const env = { PORT: String(c.port), DATA_DIR: P.data };
  if (fs.existsSync(P.password)) env.ADMIN_PASSWORD_FILE = P.password;
  // caffeinate -i stops the Mac idle-sleeping while the server runs (the display can still sleep).
  const args = [...(c.keepAwake ? ['/usr/bin/caffeinate', '-i'] : []), nodePath(), path.join(P.app, 'server', 'server.js')];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>AssociatedBundleIdentifiers</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(P.app)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${xml(P.log)}</string>
  <key>StandardErrorPath</key><string>${xml(P.log)}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(P.plist), { recursive: true });
  fs.writeFileSync(P.plist + '.tmp', plist);
  fs.renameSync(P.plist + '.tmp', P.plist);
}

/** Keeps the log small while the server is stopped (launchd holds it open while running). */
function rotateLog() {
  try { if (fs.statSync(P.log).size > 5 * 1024 * 1024) fs.renameSync(P.log, path.join(P.logs, 'server.old.log')); } catch {}
}

async function startAgent() {
  fs.mkdirSync(P.logs, { recursive: true });
  if (!fs.existsSync(P.plist)) writePlist();
  if (loaded()) { launchctl('kickstart', SERVICE); return; }
  rotateLog();
  launchctl('enable', SERVICE); // in case it was switched off in System Settings → Login Items
  for (let i = 0; i < 6 && !loaded(); i++) { // right after a stop, launchd can need a moment
    const r = launchctl('bootstrap', DOMAIN, P.plist);
    if (r.status !== 0 && !loaded()) {
      if (i === 5) launchctl('load', '-w', P.plist); // older macOS
      else await sleep(500);
    }
  }
}

async function stopAgent() {
  const was = loaded();
  if (was) {
    launchctl('bootout', SERVICE);
    if (loaded()) launchctl('unload', P.plist);
    await waitFor(async () => !(await probe(config().port, 800)), 10000);
  }
  return was;
}

async function ensureRunning(ms = 30000) {
  const { port } = config();
  const now = await probe(port);
  if (now) return now;
  await startAgent();
  return waitFor(() => probe(port), ms);
}

async function restart() {
  await stopAgent();
  writePlist(); // picks up port or password changes
  await startAgent();
  return waitFor(() => probe(config().port), 30000);
}

// ---------------------------------------------------------------- opening things for the person

function openUrl(url) {
  if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else if (TEST_MAC) spawnSync('open', [url], { stdio: 'ignore' });
  else console.log(`Open ${url}`);
}

function lastLogLines(n) {
  try { return fs.readFileSync(P.log, 'utf8').split(/\r?\n/).slice(-n).join('\n'); } catch { return '(no log yet)'; }
}

/** The app has no window of its own, so problems open as a note in TextEdit. */
function showProblem(title, lines) {
  const text = [title, '', ...lines, '', `The server's log is ${P.log}. Its last lines:`, '', lastLogLines(25), ''].join('\n');
  console.error(text);
  if (!IS_MAC) return;
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    const file = path.join(P.logs, `${NAME} - problem.txt`);
    fs.writeFileSync(file, text);
    spawnSync('open', ['-e', file], { stdio: 'ignore' });
  } catch {}
}

function setupCode() {
  try { return (/(\d{6})/.exec(fs.readFileSync(path.join(P.data, 'setup-code.txt'), 'utf8')) || [])[1] || ''; } catch { return ''; }
}

async function openAdmin() {
  if (!installed()) throw new Fail(`${NAME} isn't installed yet. Run  node install-mac.js  from the downloaded folder.`);
  const status = await ensureRunning();
  const { port } = config();
  if (!status) {
    showProblem(`${NAME} didn't start.`, [
      `The most common reason is that another program is already using port ${port}.`,
      `• If ENJOY Signage is also running in a Terminal window (node server.js), press Ctrl+C there, then open ${NAME} again.`,
      `• To use another port, run in Terminal:  node "${SCRIPT}" port 8080`,
    ]);
    return false;
  }
  const code = status.needsSetup ? setupCode() : '';
  openUrl(code ? `http://127.0.0.1:${port}/login#setup=${code}` : `http://127.0.0.1:${port}/`);
  return true;
}

// ---------------------------------------------------------------- the app bundle and the Dock

/** /Applications if this account can write there (admins can), otherwise ~/Applications. */
function appsDir() {
  try { fs.accessSync('/Applications', fs.constants.W_OK); return '/Applications'; } catch {}
  const mine = path.join(USER_HOME, 'Applications');
  fs.mkdirSync(mine, { recursive: true });
  return mine;
}
const appBundles = () => ['/Applications', path.join(USER_HOME, 'Applications')].map((d) => path.join(d, `${NAME}.app`));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function makeApp() {
  const app = path.join(appsDir(), `${NAME}.app`);
  const tmp = `${app}.new`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleVersion</key><string>${xml(VERSION)}</string>
  <key>CFBundleShortVersionString</key><string>${xml(VERSION)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>enjoy-signage</string>
  <key>CFBundleIconFile</key><string>enjoy</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);
  const launcher = path.join(tmp, 'Contents', 'MacOS', 'enjoy-signage');
  fs.writeFileSync(launcher, `#!/bin/sh\n# Opens the ENJOY Signage admin panel, starting the server first if needed.\nexec ${shq(nodePath())} ${shq(SCRIPT)} open\n`);
  fs.chmodSync(launcher, 0o755);
  // Written fresh (not copied) so no "downloaded from the internet" flag comes along from the zip.
  fs.writeFileSync(path.join(tmp, 'Contents', 'Resources', 'enjoy.icns'), fs.readFileSync(path.join(P.app, 'platform', 'mac', 'enjoy.icns')));
  fs.rmSync(app, { recursive: true, force: true });
  fs.renameSync(tmp, app);
  unquarantine(app);
  // Tell Finder and the Dock about the new app (and its icon) straight away.
  spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app], { stdio: 'ignore' });
  return app;
}

function inDock(app) {
  const r = spawnSync('defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' });
  return (r.stdout || '').includes(pathToFileURL(app).href);
}
function addToDock(app) {
  if (inDock(app)) return true;
  const url = pathToFileURL(app).href + '/';
  const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${xml(url)}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
  const r = spawnSync('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile], { stdio: 'ignore' });
  if (r.status !== 0) return false;
  spawnSync('killall', ['Dock'], { stdio: 'ignore' });
  return true;
}

function firewallNote() {
  const r = spawnSync('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { encoding: 'utf8' });
  if (r.status === 0 && /enabled/i.test(r.stdout || '') && !/disabled/i.test(r.stdout || '')) {
    warn('The macOS firewall is on. If it asks whether "node" may accept incoming connections, choose');
    info('Allow, or TVs won’t be able to connect. (System Settings → Network → Firewall → Options.)');
  }
}

// ---------------------------------------------------------------- prompts and content import

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
    rl.on('SIGINT', () => { rl.close(); console.log(); process.exit(130); });
  });
}
const interactive = () => !!process.stdin.isTTY;

function looksLikeContent(d) {
  const has = (f) => fs.existsSync(path.join(d, f));
  return has('db.json') || has('users.json') || (has('uploads') && has('folders'));
}
/** Accepts a data folder or the folder holding one. Folders dragged into Terminal arrive as /path/Old\ Church/x. */
function findDataFolder(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/\\(.)/g, '$1');
  if (!p) return '';
  p = p.replace(/^~(?=\/|$)/, USER_HOME);
  for (const d of [p, path.join(p, 'data')]) if (looksLikeContent(d)) return path.resolve(d);
  return null;
}

function dirSizeKB(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch {} } };
  try { walk(dir); } catch {}
  return Math.ceil(total / 1024);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = argv[++i];
    else if (a === '--import') o.import = argv[++i];
    else if (a === '--replace-content') o.replace = true;
    else if (a === '--no-open') o.noOpen = true;
    else if (a === '--allow-sleep') o.allowSleep = true;
    else if (a === '--keep-awake') o.keepAwake = true;
    else if (a === '--dock') o.dock = true;
    else if (a === '--no-dock') o.dock = false;
    else if (a === '--purge') o.purge = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else throw new Fail(`Unknown option ${a}`);
  }
  return o;
}

function copyApp() {
  const fresh = P.app + '.new';
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.mkdirSync(fresh, { recursive: true });
  for (const f of APP_FILES) {
    const from = path.join(SRC, f);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(fresh, f), { recursive: true });
  }
  if (!fs.existsSync(path.join(fresh, 'server', 'server.js'))) throw new Fail(`The server files are missing from ${SRC}. Run the installer from the extracted enjoy-signage folder.`);
  fs.rmSync(P.app, { recursive: true, force: true });
  fs.renameSync(fresh, P.app);
  unquarantine(P.app);
}

/** Files extracted from a downloaded zip carry macOS's quarantine flag, and copying keeps it: clear it on our copies. */
function unquarantine(dir) {
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', dir], { stdio: 'ignore' });
}

async function bringInContent(opts) {
  const has = looksLikeContent(P.data);
  let from = opts.import ? findDataFolder(opts.import) : null;
  if (opts.import && !from) throw new Fail(`${opts.import} doesn't contain ENJOY Signage content. Use the old church-signage or enjoy-signage folder, or the data folder inside it.`);
  if (has && !from) return ok(`Kept your content in ${P.data}`);
  if (has && from && !opts.replace) {
    warn(`Kept the content that's already installed, so ${from} was not copied in.`);
    info('To replace it, run the installer again with  --import "that folder" --replace-content');
    return;
  }
  if (!from && SRC !== P.app) from = findDataFolder(path.join(SRC, 'data')) || null;
  if (!from && !has && interactive() && !opts.yes) {
    console.log();
    console.log('  Have content from an older ENJOY Signage on this Mac? Drag its folder (the old');
    console.log('  church-signage or enjoy-signage folder, or the data folder inside it) into this window and press Return.');
    for (;;) {
      const a = await ask('  Or just press Return to start fresh: ');
      if (!a.trim()) break;
      from = findDataFolder(a);
      if (from) break;
      warn('That folder doesn’t have ENJOY Signage content in it. Try again, or press Return.');
    }
  }
  if (!from) { fs.mkdirSync(P.data, { recursive: true }); return ok(`New, empty content folder: ${P.data}`); }
  if (has) {
    const keep = `${P.data}.before-import-${new Date().toISOString().slice(0, 10)}`;
    fs.renameSync(P.data, keep);
    info(`The previous content was kept in ${keep}`);
  }
  const kb = dirSizeKB(from);
  info(`Copying your content from ${from} (${kb > 1048576 ? (kb / 1048576).toFixed(1) + ' GB' : Math.ceil(kb / 1024) + ' MB'})…`);
  fs.cpSync(from, P.data, { recursive: true, filter: (s) => !/\/sessions\.json$/.test(s) });
  ok(`Brought in your screens, playlists, schedules, uploads and accounts from ${from}`);
  info('(The old folder was left as it is. Once you’re happy, you can delete it.)');
}

// ---------------------------------------------------------------- install / uninstall

async function install(argv) {
  const opts = parseArgs(argv);
  if (!IS_MAC) throw new Fail('This installer is for macOS. On Windows use  node install-windows.js, on Ubuntu  sudo bash install-ubuntu.sh.');
  const major = parseInt(process.versions.node, 10);
  if (major < 18) throw new Fail(`Node.js ${process.versions.node} is too old. Install the LTS version from https://nodejs.org and run this again.`);
  console.log(`\n  ${NAME} ${VERSION} installer for macOS\n`);

  fs.mkdirSync(HOME, { recursive: true });
  const before = config();
  const port = opts.port !== undefined ? parseInt(opts.port, 10) : before.port;
  if (!(port >= 1 && port <= 65535)) throw new Fail('Use a port number from 1 to 65535, for example --port 8080');
  const keepAwake = opts.allowSleep ? false : opts.keepAwake ? true : before.keepAwake;

  if (await stopAgent()) ok('Stopped the running copy while it’s updated');
  copyApp();
  ok(`Program installed in ${P.app}`);
  await bringInContent(opts);
  saveConfig({ ...before, port, keepAwake, version: VERSION, installedAt: new Date().toISOString() });

  const app = makeApp();
  ok(`${NAME} app added to ${path.dirname(app)}`);
  let dock = opts.dock;
  if (dock === undefined) dock = interactive() && !opts.yes ? !/^n/i.test((await ask('  Add it to the Dock? [Y/n] ')).trim()) : false;
  if (dock) { if (addToDock(app)) ok('Added to the Dock'); else warn('Couldn’t add it to the Dock. Drag it there from Applications.'); }

  const squatter = await probe(port);
  if (squatter) {
    writePlist();
    console.log();
    warn(`Something is already running on port ${port}, probably ENJOY Signage started in a Terminal window.`);
    info(`Press Ctrl+C in that window, then open the ${NAME} app.`);
    return;
  }

  writePlist();
  info('Starting the server…');
  await startAgent();
  const status = await waitFor(() => probe(port), 40000);
  if (!status) {
    showProblem(`${NAME} was installed but didn't start.`, [`Check the log, then open the ${NAME} app to try again.`]);
    process.exitCode = 1;
    return;
  }
  ok(`${NAME} is running, and starts by itself whenever you log in`);
  if (keepAwake) ok('This Mac won’t go to sleep while the server runs (the display still can)');
  firewallNote();
  const ips = lanAddresses();
  console.log();
  info(`Admin panel on this Mac:  http://127.0.0.1:${port}/   (or open the ${NAME} app)`);
  if (ips.length) {
    info(`From other computers:     ${ips.map((ip) => `http://${ip}:${port}/`).join('  ')}`);
    info(`TVs open:                 http://${ips[0]}:${port}/player`);
  }
  console.log();
  if (status.needsSetup) info('Your browser will open to create the first administrator account. The setup code is filled in.');
  info('macOS may show a "Background Items Added" notice for node: that’s the signage server.');
  info('Tip: give this Mac a fixed address in your router (a DHCP reservation), so TV links never change.');
  console.log();
  if (!opts.noOpen) await openAdmin();
}

async function uninstall(argv) {
  const opts = parseArgs(argv);
  console.log(`\n  Removing ${NAME}\n`);
  process.chdir(os.tmpdir());
  await stopAgent();
  fs.rmSync(P.plist, { force: true });
  ok('Server stopped, and it no longer starts at login');
  for (const app of appBundles()) fs.rmSync(app, { recursive: true, force: true });
  ok(`${NAME} app removed (if it's in the Dock, drag its icon out)`);
  for (const p of [P.app, P.app + '.new', P.app + '.previous', P.logs]) fs.rmSync(p, { recursive: true, force: true });
  ok('Program removed');

  let purge = !!opts.purge;
  if (!purge && interactive() && !opts.yes && fs.existsSync(P.data)) {
    console.log();
    console.log(`  Your content (screens, playlists, uploads, accounts) is in ${P.data}`);
    purge = (await ask('  Type DELETE to delete it too, or press Return to keep it: ')).trim() === 'DELETE';
  }
  if (purge) {
    fs.rmSync(HOME, { recursive: true, force: true });
    ok('All content deleted');
  } else if (fs.existsSync(P.data)) {
    ok(`Your content was kept in ${P.data}. Installing again picks it up.`);
  }
}

// ---------------------------------------------------------------- other commands

async function status() {
  const c = config();
  const s = installed() ? await probe(c.port) : null;
  const ips = lanAddresses();
  console.log();
  console.log(`  ${NAME} ${VERSION} is ${!installed() ? 'not installed' : s ? '\u001b[32mrunning\u001b[0m' : '\u001b[31mstopped\u001b[0m'}${installed() && !s && loaded() ? ' (launchd is trying to start it: see the log)' : ''}`);
  console.log(`  Admin panel:  http://127.0.0.1:${c.port}/  ${ips.map((ip) => `http://${ip}:${c.port}/`).join('  ')}`);
  if (ips.length) console.log(`  TVs open:     http://${ips[0]}:${c.port}/player`);
  console.log(`  Content:      ${P.data}`);
  console.log(`  Log:          ${P.log}`);
  console.log(`  Keeps the Mac awake: ${c.keepAwake ? 'yes' : 'no'}`);
  console.log(`  Built-in admin login: ${fs.existsSync(P.password) && fs.statSync(P.password).size ? 'on' : 'off'}`);
  console.log();
}

async function setPort(argv) {
  const port = parseInt(argv[0], 10);
  if (!(port >= 1 && port <= 65535)) throw new Fail('Usage: enjoy.js port 8080');
  saveConfig({ ...config(), port });
  const s = await restart();
  ok(`Port changed to ${port}${s ? '' : ' (but the server didn’t start: see the log)'}`);
  warn('Update each TV’s player link to the new port.');
  warn(`If Spotify is connected, add http://127.0.0.1:${port}/spotify/callback as a Redirect URI in your Spotify app.`);
}

async function setSleep(argv) {
  const v = argv[0];
  if (!['on', 'off'].includes(v)) throw new Fail('Usage: enjoy.js keep-awake on   (or off)');
  saveConfig({ ...config(), keepAwake: v === 'on' });
  await restart();
  ok(v === 'on' ? 'This Mac stays awake while the server runs' : 'This Mac can sleep normally again (TVs lose the server while it sleeps)');
}

async function setPassword(argv) {
  let pw = argv[0];
  if (pw === undefined) {
    if (!interactive()) throw new Fail('Usage: enjoy.js password NEW-PASSWORD');
    pw = await ask('  New password for the built-in "admin" account (blank turns that login off): ', { hidden: true });
    if (pw && (await ask('  Type it again: ', { hidden: true })) !== pw) throw new Fail('They didn’t match. Nothing was changed.');
  }
  if (/[\r\n]/.test(pw)) throw new Fail('The password can’t contain line breaks.');
  if (pw) fs.writeFileSync(P.password, pw, { mode: 0o600 });
  else fs.rmSync(P.password, { force: true });
  await restart();
  if (pw) ok('Built-in admin password set. Sign in as: admin');
  else warn('Built-in admin login turned off. Make sure another administrator account exists (Users page).');
}

async function main(argv) {
  const [cmd = 'open', ...rest] = argv;
  switch (cmd) {
    case 'install': return install(rest);
    case 'uninstall': return uninstall(rest);
    case 'open': return openAdmin();
    case 'start': { const s = await ensureRunning(); return s ? ok(`${NAME} is running`) : showProblem(`${NAME} didn't start.`, []); }
    case 'stop': await stopAgent(); return ok(`${NAME} server stopped. It starts again when you open the app or log in.`);
    case 'restart': { const s = await restart(); return s ? ok(`${NAME} server restarted`) : showProblem(`${NAME} didn't restart.`, []); }
    case 'status': return status();
    case 'port': return setPort(rest);
    case 'keep-awake': return setSleep(rest);
    case 'password': return setPassword(rest);
    case 'update':
      process.chdir(os.tmpdir()); // the program folder gets replaced
      return require(path.join(__dirname, '..', 'update.js')).update('mac', rest);
    default:
      console.log('Usage: node enjoy.js [open | start | stop | restart | status | port N | keep-awake on|off | password | update | uninstall]');
      process.exitCode = 1;
  }
}

module.exports = { main };

if (require.main === module) {
  const argv = process.argv.slice(2);
  main(argv).catch((e) => {
    const msg = e instanceof Fail || e.name === 'Fail' ? e.message : e.stack || e.message; // (update.js has its own Fail)
    process.exitCode = 1;
    if (argv[0] === 'open' || argv[0] === undefined) return showProblem(`${NAME} had a problem.`, [msg]); // started from the app: no Terminal to read
    console.error(`\n  \u001b[31mError:\u001b[0m ${msg}\n`);
  });
}
