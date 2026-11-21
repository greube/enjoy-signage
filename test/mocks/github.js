#!/usr/bin/env node
'use strict';
/**
 * A pretend GitHub that serves this checkout as a newer version, for testing the updater.
 *
 *   node test/mocks/github.js PORT [VERSION]     (VERSION defaults to the checkout's version + 0.0.1)
 *   then run the updater with
 *   ENJOY_SIGNAGE_UPDATE_API=http://127.0.0.1:PORT ENJOY_SIGNAGE_UPDATE_RAW=http://127.0.0.1:PORT/raw \
 *   ENJOY_SIGNAGE_UPDATE_CODELOAD=http://127.0.0.1:PORT/codeload  node platform/update.js windows|mac|ubuntu
 *
 * The tarball is made like GitHub makes one (git archive, top folder owner-repo-commit/), from the working tree
 * including uncommitted changes, with package.json's version set to VERSION. test/ is left out (export-ignore).
 *
 * Environment, to act out GitHub's bad days:
 *   FAIL_VERSION=n       the first n version checks through the API answer 504
 *   FAIL_API_TARBALL=n   the first n API downloads answer 504 ("all" = every one, so codeload has to be used)
 *   FAIL_ALL=1           every request answers 504 (the updater should give up politely, changing nothing)
 *   CUT=1                the first download stops halfway (connection dropped)
 *   PRIVATE=1            the repo is private: needs  --token ghp_TESTTOKEN0123456789abcdef ; raw/codeload say 404
 *   BROKEN=1             the new version's server crashes on start (the updater should put the old one back)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const PORT = +(process.argv[2] || 4501);
const cur = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const VERSION = process.argv[3] || cur.replace(/(\d+)$/, (n) => +n + 1);
const TOKEN = 'ghp_TESTTOKEN0123456789abcdef';
const env = process.env;
const T = () => new Date().toTimeString().slice(0, 8);

// ---- build the tarball from a throwaway index, so the real one isn't touched
function build() {
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: REPO, encoding: 'buffer', maxBuffer: 1 << 30, ...extra });
  const idx = path.join(os.tmpdir(), `mock-github-index-${process.pid}`);
  const genv = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(['read-tree', 'HEAD'], { env: genv });
    git(['add', '-A', '.'], { env: genv });
    const set = (file, text) => {
      const blob = git(['hash-object', '-w', '--stdin'], { input: Buffer.from(text) }).toString().trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env: genv });
    };
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    set('package.json', JSON.stringify({ ...pkg, version: VERSION }, null, 2) + '\n');
    if (env.BROKEN) set('server/server.js', "throw new Error('This pretend version is broken on purpose');\n");
    const tree = git(['write-tree'], { env: genv }).toString().trim();
    const tar = git(['archive', '--format=tar', `--prefix=greube-enjoy-signage-${tree.slice(0, 7)}/`, tree]);
    return zlib.gzipSync(tar);
  } finally { fs.rmSync(idx, { force: true }); }
}
const gz = build();
const pkgText = JSON.stringify({ name: 'enjoy-signage', version: VERSION }, null, 2);

let versionFails = +(env.FAIL_VERSION || 0);
let tarFails = env.FAIL_API_TARBALL === 'all' ? Infinity : +(env.FAIL_API_TARBALL || 0);
let cut = !!env.CUT;

function sendTar(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-gzip', 'Content-Length': gz.length });
  if (cut) {
    cut = false;
    console.log(`${T()}    … cutting this download off halfway`);
    res.write(gz.subarray(0, gz.length >> 1), () => setTimeout(() => res.socket.destroy(), 100));
    return;
  }
  res.end(gz);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const auth = req.headers.authorization || '';
  const authed = auth === `Bearer ${TOKEN}`;
  const p = u.pathname;
  const say = (code, why = '') => console.log(`${T()}  ${req.method} ${p}${u.search}${auth ? ' (with token)' : ''} → ${code}${why ? ' ' + why : ''}`);
  const fail = (code, msg) => { say(code); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: msg })); };
  if (env.FAIL_ALL) return fail(504, 'Gateway Timeout');
  if (auth && !authed) return fail(401, 'Bad credentials');
  const m = /^\/repos\/([^/]+\/[^/]+)\/(contents\/package\.json|tarball\/.+)$/.exec(p);
  if (m) {
    if (env.PRIVATE && !authed) return fail(404, 'Not Found');
    if (m[2].startsWith('contents')) {
      if (versionFails > 0) { versionFails--; return fail(504, 'Gateway Timeout'); }
      say(200, `version ${VERSION}`); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(pkgText);
    }
    if (tarFails > 0) { tarFails--; return fail(504, 'Gateway Timeout'); }
    say(200, `${(gz.length / 1e6).toFixed(1)} MB`); return sendTar(res);
  }
  if (/^\/raw\/[^/]+\/[^/]+\/[^/]+\/package\.json$/.test(p)) {
    if (env.PRIVATE) return fail(404, 'Not Found');
    say(200, `version ${VERSION}`); res.writeHead(200); return res.end(pkgText);
  }
  if (/^\/codeload\/[^/]+\/[^/]+\/tar\.gz\/refs\/heads\/.+$/.test(p)) {
    if (env.PRIVATE) return fail(404, 'Not Found');
    say(200, `${(gz.length / 1e6).toFixed(1)} MB`); return sendTar(res);
  }
  fail(404, 'Not Found');
}).listen(PORT, '127.0.0.1', () => console.log(`${T()}  mock GitHub on :${PORT} serving version ${VERSION} (${(gz.length / 1e6).toFixed(1)} MB)${env.BROKEN ? ', BROKEN on purpose' : ''}`));
