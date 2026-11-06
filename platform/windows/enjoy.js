#!/usr/bin/env node
'use strict';
/**
 * ENJOY Signage for Windows: installer, background server manager and the desktop icon's launcher.
 *
 * Everything runs through node.exe, which is signed, so it works with Smart App Control on
 * (no .bat, .ps1, .vbs or unsigned .exe anywhere). Shortcuts are written by ./shortcut.js and the
 * Apps-list entry with Windows' own reg.exe.
 *
 *   node install-windows.js          install or update (run once from the extracted folder)
 *   enjoy.js open                    desktop icon: start the server if needed, open the admin panel
 *   enjoy.js start | stop | restart  control the background server
 *   enjoy.js status                  is it running? addresses, folders
 *   enjoy.js port 8080               change the web port
 *   enjoy.js password                set the built-in "admin" recovery password
 *   enjoy.js update [--check]        install the newest version from GitHub (see ../update.js)
 *   enjoy.js uninstall [--purge]     remove it (keeps your content unless --purge)
 *   enjoy.js run                     (internal) the background supervisor that keeps the server running
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const shortcut = require('./shortcut');

// ENJOY_SIGNAGE_TEST_WIN=1 runs the Windows code paths on another OS (for testing, with stand-in tools).
const TEST_WIN = process.env.ENJOY_SIGNAGE_TEST_WIN === '1';
const IS_WIN = process.platform === 'win32' || TEST_WIN;
const NAME = 'ENJOY Signage';
const SRC = path.resolve(__dirname, '..', '..'); // the downloaded enjoy-signage folder // the program folder this script came from
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
const HOME = process.env.ENJOY_SIGNAGE_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), NAME);
const P = {
  app: path.join(HOME, 'app'),
  data: path.join(HOME, 'data'),
  logs: path.join(HOME, 'logs'),
  log: path.join(HOME, 'logs', 'server.log'),
  pid: path.join(HOME, 'logs', 'supervisor.pid'),
  config: path.join(HOME, 'config.json'),
  password: path.join(HOME, 'admin-password'),
  icon: path.join(HOME, 'enjoy.ico'),
};
const SCRIPT = path.join(P.app, 'platform', 'windows', 'enjoy.js');
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ENJOYSignage';
const FIREWALL_RULE = 'ENJOY-Signage';
// Files that make up the program (everything else in the download stays behind).
// The installer and updater go along too, so the installed copy can reinstall itself if an update has to be undone.
const APP_FILES = ['package.json', 'README.md', 'install-windows.js', 'server', 'public', 'docs', path.join('platform', 'windows'), path.join('platform', 'update.js')];

// A closed console window must never take the server manager down with it.
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
  return { ...c, port: port >= 1 && port <= 65535 ? port : 3000 };
}
function saveConfig(c) {
  fs.writeFileSync(P.config + '.tmp', JSON.stringify(c, null, 2));
  fs.renameSync(P.config + '.tmp', P.config);
}
const installed = () => fs.existsSync(path.join(P.app, 'server', 'server.js')) && fs.existsSync(P.config);

/** Windows path for text that Windows will read (shortcuts, registry). Identity on Windows itself. */
function winPath(p) {
  if (process.platform === 'win32' || /^[A-Za-z]:\\/.test(p)) return p;
  return 'C:' + path.resolve(p).replace(/\//g, '\\'); // test mode: show a believable Windows path
}

/** The LAN addresses TVs use, private ranges first (same order as the server's). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  const rank = (ip) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------- is it running?

/** Asks the server for its sign-in status. Resolves to the status object, or null if nothing answers. */
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

function readPid() {
  try { return parseInt(JSON.parse(fs.readFileSync(P.pid, 'utf8')).pid, 10) || 0; } catch { return 0; }
}
/** True if pid is a live node process (process ids get reused, so on Windows check the program name too). */
function nodeAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.status !== 0 || /node/i.test(r.stdout || ''); // if tasklist itself fails, trust kill(0)
}

function startBackground() {
  fs.mkdirSync(P.logs, { recursive: true });
  const child = spawn(process.execPath, [SCRIPT, 'run'], { cwd: HOME, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** Makes sure the server is up. Resolves to the status object, or null if it didn't start. */
async function ensureRunning(ms = 30000) {
  const { port } = config();
  const now = await probe(port);
  if (now) return now;
  if (!nodeAlive(readPid())) startBackground();
  return waitFor(() => probe(port), ms);
}

async function stopServer() {
  const pid = readPid();
  if (nodeAlive(pid)) {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  }
  try { fs.unlinkSync(P.pid); } catch {}
  if (pid) await waitFor(async () => !(await probe(config().port, 800)), 10000);
  return !!pid;
}

// ---------------------------------------------------------------- the supervisor (enjoy.js run)

function makeLog() {
  fs.mkdirSync(P.logs, { recursive: true });
  let size = 0;
  try { size = fs.statSync(P.log).size; } catch {}
  let fd = fs.openSync(P.log, 'a');
  const write = (buf) => {
    if (size > 5 * 1024 * 1024) { // keep the log small: the previous one is kept as server.old.log
      fs.closeSync(fd);
      try { fs.renameSync(P.log, path.join(P.logs, 'server.old.log')); } catch {}
      fd = fs.openSync(P.log, 'a');
      size = 0;
    }
    try { fs.writeSync(fd, buf); size += buf.length; } catch {}
  };
  return { write, line: (s) => write(Buffer.from(`[${new Date().toLocaleString()}] ${s}${os.EOL}`)) };
}

function supervise() {
  const other = readPid();
  if (other && other !== process.pid && nodeAlive(other)) return; // already looked after
  fs.mkdirSync(P.logs, { recursive: true });
  fs.writeFileSync(P.pid, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const log = makeLog();
  const { port } = config();
  let child = null;
  let stopping = false;
  let delay = 1000;

  const shutdown = () => {
    stopping = true;
    if (child) child.kill();
    try { if (readPid() === process.pid) fs.unlinkSync(P.pid); } catch {}
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const launch = () => {
    const env = { ...process.env, PORT: String(port), DATA_DIR: P.data };
    if (fs.existsSync(P.password)) env.ADMIN_PASSWORD_FILE = P.password;
    const started = Date.now();
    log.line(`Starting ${NAME} ${VERSION} on port ${port}`);
    child = spawn(process.execPath, [path.join(P.app, 'server', 'server.js')], { cwd: P.app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', log.write);
    child.stderr.on('data', log.write);
    child.on('error', (e) => log.line(`Couldn't start the server: ${e.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      // Crashing straight away again and again (e.g. the port is taken)? Wait longer each time, up to a minute.
      delay = Date.now() - started < 15000 ? Math.min(delay * 2, 60000) : 2000;
      log.line(`The server stopped (${signal || 'exit code ' + code}). Restarting in ${delay / 1000} s.`);
      setTimeout(launch, delay);
    });
  };
  launch();
}

// ---------------------------------------------------------------- opening things for the person

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (TEST_WIN) {
    spawnSync('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
  } else console.log(`Open ${url}`);
}

function lastLogLines(n) {
  try { return fs.readFileSync(P.log, 'utf8').split(/\r?\n/).slice(-n).join(os.EOL); } catch { return '(no log yet)'; }
}

/** Shows a problem to someone who started us from an icon (there's no console to read), via Notepad. */
function showProblem(title, lines) {
  const text = [title, '', ...lines, '', `The server's log is ${P.log}. Its last lines:`, '', lastLogLines(25), ''].join(os.EOL);
  console.error(text);
  if (!IS_WIN) return;
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    const file = path.join(P.logs, `${NAME} - problem.txt`);
    fs.writeFileSync(file, '\ufeff' + text);
    if (process.platform === 'win32') spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
    else spawnSync('notepad', [file], { stdio: 'ignore' });
  } catch {}
}

function setupCode() {
  try { return (/(\d{6})/.exec(fs.readFileSync(path.join(P.data, 'setup-code.txt'), 'utf8')) || [])[1] || ''; } catch { return ''; }
}

async function openAdmin() {
  if (!installed()) throw new Fail(`${NAME} isn't installed yet. Run  node install-windows.js  from the downloaded folder.`);
  const status = await ensureRunning();
  const { port } = config();
  if (!status) {
    const holder = await probe(port); // nothing ENJOY-like answered
    showProblem(`${NAME} didn't start.`, [
      holder ? '' : `The most common reason is that another program is already using port ${port}.`,
      `• If an older ENJOY Signage server window is open, close it, then double-click the ${NAME} icon again.`,
      `• To use another port, open a terminal and run:  node "${SCRIPT}" port 8080`,
    ].filter(Boolean));
    return false;
  }
  const code = status.needsSetup ? setupCode() : '';
  openUrl(code ? `http://127.0.0.1:${port}/login#setup=${code}` : `http://127.0.0.1:${port}/`);
  return true;
}

// ---------------------------------------------------------------- Windows folders, shortcuts, registry, firewall

function reg(args) {
  return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/** A known folder (Desktop, Programs, Startup) from the registry, so OneDrive-redirected desktops work. */
function shellFolder(name, fallbacks) {
  for (const key of ['User Shell Folders', 'Shell Folders']) {
    const r = reg(['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\${key}`, '/v', name]);
    const m = r.status === 0 && new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'mi').exec(r.stdout || '');
    if (!m) continue;
    const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k.toUpperCase(), v]));
    const dir = m[1].replace(/%([^%]+)%/g, (all, k) => env[k.toUpperCase()] ?? all);
    if (!dir.includes('%') && fs.existsSync(dir)) return dir; // (reg.exe's output can garble non-English names: then use a fallback)
  }
  return fallbacks.find((d) => d && fs.existsSync(d)) || fallbacks[fallbacks.length - 1];
}
function folders() {
  const home = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programs = shellFolder('Programs', [path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')]);
  return {
    desktop: shellFolder('Desktop', [process.env.OneDrive && path.join(process.env.OneDrive, 'Desktop'), path.join(home, 'Desktop')]),
    menu: path.join(programs, NAME),
    startup: shellFolder('Startup', [path.join(programs, 'Startup')]),
  };
}

function shortcuts() {
  const node = winPath(process.execPath);
  const script = winPath(SCRIPT);
  const icon = winPath(P.icon);
  const workingDir = winPath(HOME);
  const run = (cmd, description, show = 'minimized') => ({ target: node, args: `"${script}" ${cmd}`, workingDir, icon, description, show });
  const f = folders();
  const explorer = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'explorer.exe');
  return [
    [path.join(f.desktop, `${NAME}.lnk`), run('open', `Open the ${NAME} admin panel (starts the server if it isn't running)`)],
    [path.join(f.menu, `${NAME}.lnk`), run('open', `Open the ${NAME} admin panel (starts the server if it isn't running)`)],
    [path.join(f.menu, `Restart ${NAME} server.lnk`), run('restart', `Restart the ${NAME} server`, 'normal')],
    [path.join(f.menu, `Update ${NAME}.lnk`), run('update', `Install the newest version of ${NAME}`, 'normal')],
    [path.join(f.menu, `Stop ${NAME} server.lnk`), run('stop', `Stop the ${NAME} server until you open it again or restart the computer`, 'normal')],
    [path.join(f.menu, `${NAME} folder.lnk`), { target: winPath(explorer), args: `"${workingDir}"`, icon, description: `Your ${NAME} content, drop folders and logs` }],
    [path.join(f.menu, `Uninstall ${NAME}.lnk`), run('uninstall', `Remove ${NAME}`, 'normal')],
    [path.join(f.startup, `${NAME} server.lnk`), run('start', `Starts the ${NAME} server in the background when you sign in`)],
  ];
}

function isAdmin() {
  return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
}
function firewall(port) {
  if (isAdmin()) {
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], { stdio: 'ignore', windowsHide: true });
    const r = spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=private,domain'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) return ok(`Windows Firewall lets TVs on your network reach port ${port}`);
  }
  const shown = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`], { encoding: 'utf8', windowsHide: true });
  if (shown.status === 0 && new RegExp(`LocalPort:\\s*${port}\\b`).test(shown.stdout || '')) return ok(`Windows Firewall already lets TVs reach port ${port}`);
  warn('If Windows asks whether Node.js may use the network, tick Private networks and choose Allow,');
  info('or TVs won\u2019t be able to connect. (Running the installer once from an administrator');
  info('terminal sets this up for you instead.)');
}

function dirSizeKB(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch {} } };
  try { walk(dir); } catch {}
  return Math.ceil(total / 1024);
}

function registerApp() {
  const node = winPath(process.execPath);
  const values = [
    ['DisplayName', 'REG_SZ', NAME],
    ['DisplayVersion', 'REG_SZ', VERSION],
    ['Publisher', 'REG_SZ', 'Enjoy Church'],
    ['DisplayIcon', 'REG_SZ', winPath(P.icon)],
    ['InstallLocation', 'REG_SZ', winPath(HOME)],
    ['UninstallString', 'REG_SZ', `"${node}" "${winPath(SCRIPT)}" uninstall`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(dirSizeKB(P.app))],
  ];
  return values.every(([name, type, data]) => reg(['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f']).status === 0);
}

// ---------------------------------------------------------------- prompts

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write(os.EOL); resolve(a); });
    rl.on('SIGINT', () => { rl.close(); console.log(); process.exit(130); });
  });
}
const interactive = () => !!process.stdin.isTTY;

/** Accepts a data folder, or the folder that holds one (people often drag the whole old church-signage folder). */
function findDataFolder(p) {
  p = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/^& '|'$/g, '');
  if (!p) return '';
  for (const d of [p, path.join(p, 'data')]) if (looksLikeContent(d)) return path.resolve(d);
  return null;
}
/** db.json appears after the first edit and users.json after the first account; a brand-new copy has uploads + folders. */
function looksLikeContent(d) {
  const has = (f) => fs.existsSync(path.join(d, f));
  return has('db.json') || has('users.json') || (has('uploads') && has('folders'));
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = argv[++i];
    else if (a === '--import') o.import = argv[++i];
    else if (a === '--replace-content') o.replace = true;
    else if (a === '--no-open') o.noOpen = true;
    else if (a === '--purge') o.purge = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else throw new Fail(`Unknown option ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------- install / update

function copyApp() {
  const fresh = P.app + '.new';
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.mkdirSync(fresh, { recursive: true });
  for (const f of APP_FILES) {
    const from = path.join(SRC, f);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(fresh, f), { recursive: true });
  }
  if (!fs.existsSync(path.join(fresh, 'server', 'server.js'))) throw new Fail(`The server files are missing from ${SRC}. Run the installer from the extracted enjoy-signage folder.`);
  const old = P.app + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  try {
    if (fs.existsSync(P.app)) fs.renameSync(P.app, old);
    fs.renameSync(fresh, P.app);
  } catch (e) {
    // A File Explorer window open inside the program folder can block renaming it: copy over the top instead.
    fs.cpSync(fresh, P.app, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
  fs.rmSync(old, { recursive: true, force: true });
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
  if (!from && SRC !== P.app) from = findDataFolder(path.join(SRC, 'data')) || null; // extracted over an older copy
  if (!from && !has && interactive() && !opts.yes) {
    console.log();
    console.log('  Have content from an older ENJOY Signage on this computer? Drag its folder (the old');
    console.log('  church-signage or enjoy-signage folder, or the data folder inside it) into this window and press Enter.');
    for (;;) {
      const a = await ask('  Or just press Enter to start fresh: ');
      if (!a.trim()) break;
      from = findDataFolder(a);
      if (from) break;
      warn('That folder doesn\u2019t have ENJOY Signage content in it. Try again, or press Enter.');
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
  fs.cpSync(from, P.data, { recursive: true, filter: (s) => !/[\\/]sessions\.json$/.test(s) }); // everyone signs in again
  ok(`Brought in your screens, playlists, schedules, uploads and accounts from ${from}`);
  info('(The old folder was left as it is. Once you\u2019re happy, you can delete it.)');
}

async function install(argv) {
  const opts = parseArgs(argv);
  if (!IS_WIN) throw new Fail('This installer is for Windows. On Ubuntu, use  sudo bash install-ubuntu.sh  instead.');
  const major = parseInt(process.versions.node, 10);
  if (major < 18) throw new Fail(`Node.js ${process.versions.node} is too old. Install the LTS version from https://nodejs.org and run this again.`);
  console.log(`\n  ${NAME} ${VERSION} installer\n`);

  fs.mkdirSync(HOME, { recursive: true });
  const before = config();
  const port = opts.port !== undefined ? parseInt(opts.port, 10) : before.port;
  if (!(port >= 1 && port <= 65535)) throw new Fail('Use a port number from 1 to 65535, for example --port 8080');

  if (await stopServer()) ok('Stopped the running copy while it\u2019s updated');
  copyApp();
  fs.copyFileSync(path.join(P.app, 'platform', 'windows', 'enjoy.ico'), P.icon);
  ok(`Program installed in ${P.app}`);
  await bringInContent(opts);
  saveConfig({ ...before, port, version: VERSION, installedAt: new Date().toISOString() });

  let made = 0;
  for (const [file, link] of shortcuts()) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); shortcut.write(file, link); made++; } catch (e) { warn(`Couldn't make the shortcut ${file}: ${e.message}`); }
  }
  if (made) {
    ok('Desktop icon and Start menu entries added');
    ok('The server starts in the background whenever you sign in to Windows');
  }
  if (registerApp()) ok('Listed in Settings \u2192 Apps (uninstall it from there)');
  else warn('Couldn\u2019t add it to Settings \u2192 Apps. Use Start \u2192 ENJOY Signage \u2192 Uninstall instead.');
  firewall(port);

  // Something else answering on the port (typically an old copy's server window) would stop ours starting.
  const squatter = await probe(port);
  if (squatter) {
    console.log();
    warn(`Something is already running on port ${port}, probably an older ENJOY Signage server window.`);
    info('Close that window, and delete its shortcut from the Startup folder (Win+R, shell:startup) if');
    info(`it has one. Then double-click the ${NAME} icon on your desktop.`);
    return;
  }

  info('Starting the server…');
  const status = await ensureRunning(40000);
  if (!status) {
    showProblem(`${NAME} was installed but didn't start.`, [`Check the log, then double-click the ${NAME} icon to try again.`]);
    process.exitCode = 1;
    return;
  }
  ok(`${NAME} is running`);
  const ips = lanAddresses();
  console.log();
  info(`Admin panel on this computer:  http://127.0.0.1:${port}/   (or double-click the desktop icon)`);
  if (ips.length) {
    info(`From other computers:          ${ips.map((ip) => `http://${ip}:${port}/`).join('  ')}`);
    info(`TVs open:                      http://${ips[0]}:${port}/player`);
  }
  console.log();
  if (status.needsSetup) info('Your browser will open to create the first administrator account. The setup code is filled in.');
  info('Tip: give this computer a fixed address in your router (a DHCP reservation), and set Windows');
  info('     to never sleep (Settings \u2192 System \u2192 Power), so TVs can always reach it.');
  console.log();
  if (!opts.noOpen) await openAdmin();
}

// ---------------------------------------------------------------- uninstall

async function uninstall(argv) {
  const opts = parseArgs(argv);
  console.log(`\n  Removing ${NAME}\n`);
  process.chdir(os.tmpdir()); // so the folders below can be deleted
  await stopServer();
  ok('Server stopped');
  for (const [file] of shortcuts()) try { fs.unlinkSync(file); } catch {}
  try { fs.rmSync(folders().menu, { recursive: true, force: true }); } catch {}
  ok('Desktop icon, Start menu entries and start-at-sign-in removed');
  reg(['delete', UNINSTALL_KEY, '/f']);
  if (isAdmin()) spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE}`], { stdio: 'ignore', windowsHide: true });
  for (const p of [P.app, P.app + '.new', P.app + '.old', P.app + '.previous', P.icon, P.logs]) fs.rmSync(p, { recursive: true, force: true });
  ok('Program removed');

  let purge = !!opts.purge;
  if (!purge && interactive() && !opts.yes && fs.existsSync(P.data)) {
    console.log();
    console.log(`  Your content (screens, playlists, uploads, accounts) is in ${P.data}`);
    purge = (await ask('  Type DELETE to delete it too, or press Enter to keep it: ')).trim() === 'DELETE';
  }
  if (purge) {
    fs.rmSync(HOME, { recursive: true, force: true });
    ok('All content deleted');
  } else if (fs.existsSync(P.data)) {
    ok(`Your content was kept in ${P.data}. Installing again picks it up.`);
  }
  if (interactive() && !opts.yes) await ask('\n  Done. Press Enter to close this window.');
}

// ---------------------------------------------------------------- other commands

async function status() {
  const c = config();
  const s = installed() ? await probe(c.port) : null;
  const ips = lanAddresses();
  console.log();
  console.log(`  ${NAME} ${VERSION} is ${!installed() ? 'not installed' : s ? '\u001b[32mrunning\u001b[0m' : '\u001b[31mstopped\u001b[0m'}`);
  console.log(`  Admin panel:  http://127.0.0.1:${c.port}/  ${ips.map((ip) => `http://${ip}:${c.port}/`).join('  ')}`);
  if (ips.length) console.log(`  TVs open:     http://${ips[0]}:${c.port}/player`);
  console.log(`  Content:      ${P.data}`);
  console.log(`  Log:          ${P.log}`);
  console.log(`  Built-in admin login: ${fs.existsSync(P.password) && fs.statSync(P.password).size ? 'on' : 'off'}`);
  console.log();
}

async function restart() {
  await stopServer();
  return ensureRunning();
}

async function setPort(argv) {
  const port = parseInt(argv[0], 10);
  if (!(port >= 1 && port <= 65535)) throw new Fail('Usage: enjoy.js port 8080');
  const c = config();
  saveConfig({ ...c, port });
  firewall(port);
  const s = await restart();
  ok(`Port changed to ${port}${s ? '' : ' (but the server didn\u2019t start: see the log)'}`);
  warn('Update each TV\u2019s player link to the new port.');
  warn(`If Spotify is connected, add http://127.0.0.1:${port}/spotify/callback as a Redirect URI in your Spotify app.`);
}

async function setPassword(argv) {
  let pw = argv[0];
  if (pw === undefined) {
    if (!interactive()) throw new Fail('Usage: enjoy.js password NEW-PASSWORD');
    pw = await ask('  New password for the built-in "admin" account (blank turns that login off): ', { hidden: true });
    if (pw && (await ask('  Type it again: ', { hidden: true })) !== pw) throw new Fail('They didn\u2019t match. Nothing was changed.');
  }
  if (/[\r\n]/.test(pw)) throw new Fail('The password can\u2019t contain line breaks.');
  if (pw) fs.writeFileSync(P.password, pw, { mode: 0o600 });
  else fs.rmSync(P.password, { force: true });
  await restart();
  if (pw) ok('Built-in admin password set. Sign in as: admin');
  else warn('Built-in admin login turned off. Make sure another administrator account exists (Users page).');
}

/** Short-lived windows (Stop, Restart) say what happened, then close by themselves. */
async function linger(message) {
  console.log(`\n  ${message}`);
  if (interactive()) await sleep(4000);
}

async function main(argv) {
  const [cmd = 'open', ...rest] = argv;
  switch (cmd) {
    case 'install': return install(rest);
    case 'uninstall': return uninstall(rest);
    case 'run': return supervise();
    case 'open': return openAdmin();
    case 'start': if (installed()) await ensureRunning(); return;
    case 'stop': await stopServer(); return linger(`${NAME} server stopped. It starts again when you open ${NAME} or restart the computer.`);
    case 'restart': { const s = await restart(); return s ? linger(`${NAME} server restarted.`) : showProblem(`${NAME} didn't restart.`, []); }
    case 'status': return status();
    case 'port': return setPort(rest);
    case 'password': return setPassword(rest);
    case 'update': {
      process.chdir(os.tmpdir()); // the program folder gets replaced
      await require(path.join(__dirname, '..', 'update.js')).update('windows', rest);
      if (interactive()) await ask('\n  Press Enter to close this window.');
      return;
    }
    default:
      console.log(`Usage: node enjoy.js [open | start | stop | restart | status | port N | password | update | uninstall]`);
      process.exitCode = 1;
  }
}

module.exports = { main, install };

if (require.main === module) {
  const argv = process.argv.slice(2);
  main(argv).catch(async (e) => {
    const msg = e instanceof Fail || e.name === 'Fail' ? e.message : e.stack || e.message; // (update.js has its own Fail)
    process.exitCode = 1;
    // The icon and sign-in shortcuts run in a minimised window nobody reads, so show those problems in Notepad.
    if (['open', 'start', 'restart', undefined].includes(argv[0])) return showProblem(`${NAME} had a problem.`, [msg]);
    console.error(`\n  \u001b[31mError:\u001b[0m ${msg}\n`);
    if (interactive()) await ask('  Press Enter to close.');
  });
}
