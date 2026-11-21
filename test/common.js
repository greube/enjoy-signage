'use strict';
// Shared helpers for the test tools. Nothing here is used by the app itself.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, '.work'); // scratch space (git-ignored)
fs.mkdirSync(WORK, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the real server from this checkout. */
function startServer(port, dataDir, env = {}) {
  return spawn(process.execPath, ['server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: process.env.SERVER_LOG ? 'inherit' : 'ignore',
  });
}

/** Playwright is only needed by the browser tests (the app itself has no dependencies). */
function playwright() {
  for (const p of [process.env.PLAYWRIGHT, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean)) {
    try { return require(p); } catch {}
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright && npx playwright install chromium) and set PLAYWRIGHT=/path/to/node_modules/playwright');
}

/** First-run setup through the API: creates an administrator and returns a signed-in api(method, path, body). */
async function signInAsAdmin(base, dataDir) {
  let code = '';
  for (let i = 0; i < 20 && !code; i++) { try { code = fs.readFileSync(path.join(dataDir, 'setup-code.txt'), 'utf8').match(/\d{6}/)[0]; } catch { await sleep(250); } }
  const r = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signage': '1' }, body: JSON.stringify({ code, name: 'Tester', username: 'tester', password: 'a-good-password-1' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Signage': '1', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined })
    .then(async (res) => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(j)}`); return j; });
  return { api, cookie, code };
}

/** Writes a db.json from a short description. */
function writeDb(dataDir, db) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ media: [], playlists: [], screens: [], schedules: [], overrides: [], musicSchedules: [], settings: {}, ...db }, null, 1));
}
const textSlide = (id, name, bg = '#224') => ({ id, type: 'text', name, title: name, body: '', bg, fg: '#fff', createdAt: 1 });

/** Test clips made by fixtures/make-media.sh. */
function media(name) {
  const f = path.join(WORK, 'media', name);
  if (!fs.existsSync(f)) throw new Error(`${f} is missing: run  bash test/fixtures/make-media.sh  first`);
  return f;
}

module.exports = { REPO, WORK, sleep, startServer, playwright, signInAsAdmin, writeDb, textSlide, media };
