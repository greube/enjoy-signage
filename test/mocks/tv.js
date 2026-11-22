#!/usr/bin/env node
'use strict';
/**
 * A pretend Google TV, for testing TV power (pairing, on/off, power schedules).
 *
 *   node test/mocks/tv.js HOST CONTROL-PORT [--off] [--ignore-wake] [--no-report] [--delay MS]
 *
 * It listens on HOST:6467 (pairing) and HOST:6466 (remote), like a real TV. Use 127.0.0.2, 127.0.0.3 …
 * for several TVs at once (all of 127.x.x.x is this computer on Linux). It speaks the same protocol as
 * a real TV: the androidtvremote2 library (used by Home Assistant) pairs with it and controls it.
 *
 * Its certificate is made with openssl, independently of the app's own certificate code.
 *
 * Control, on http://127.0.0.1:CONTROL-PORT:
 *   GET /state                      {"on":…,"paired":N,"keys":[…],"mode":{…}}
 *   GET /code                       the code the TV is showing while pairing ('' otherwise)
 *   GET /set?on=1|0                 someone used the TV's own remote
 *   GET /mode?ignoreWake=1&noReport=0&delay=1500&unplugged=1   change behaviour
 *        unplugged=1: connections are accepted but never answered (a TV off at the wall or asleep
 *        too deeply to hear the network, as seen from the server)
 *   GET /forget                     the TV forgets every pairing (a factory reset)
 * Everything it receives is printed with the time.
 */
const tls = require('tls');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const [HOST = '127.0.0.2', CONTROL = '4600'] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] === '--delay'));
const flag = (n) => process.argv.includes(n);
const mode = {
  ignoreWake: flag('--ignore-wake'),
  noReport: flag('--no-report'),
  delay: Number(process.argv[process.argv.indexOf('--delay') + 1]) || 1500,
  unplugged: false,
};
const tv = { on: !flag('--off'), paired: new Set(), code: '', keys: [] };
const t0 = Date.now();
const log = (...x) => console.log(`[tv ${HOST} ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...x);

const dir = path.join(__dirname, '..', '.work', 'tv-' + HOST);
fs.mkdirSync(dir, { recursive: true });
const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem');
if (!fs.existsSync(certFile)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '3650', '-subj', '/CN=atvremote/O=Pretend TV'], { stdio: 'ignore' });
const opts = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), requestCert: true, rejectUnauthorized: false };

/* Protobuf, written separately from the app's so a shared mistake can't hide. */
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
function enc(fields) {
  return Buffer.concat(fields.flatMap(([k, v]) => {
    if (typeof v === 'number' || typeof v === 'boolean') return [varint(k << 3), varint(+v)];
    const b = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v) : enc(v);
    return [varint((k << 3) | 2), varint(b.length), b];
  }));
}
function dec(b) {
  const f = {}; let i = 0;
  const rv = () => { let n = 0, m = 1, x; do { x = b[i++]; n += (x & 127) * m; m *= 128; } while (x & 128); return n; };
  while (i < b.length) {
    const key = rv(), k = key >> 3, w = key & 7;
    let v;
    if (w === 0) v = rv(); else if (w === 2) { const n = rv(); v = b.subarray(i, i + n); i += n; } else throw new Error('wire type ' + w);
    (f[k] = f[k] || []).push(v);
  }
  return f;
}
function frames(sock, onMsg) {
  let buf = Buffer.alloc(0);
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      let n = 0, m = 1, i = 0, x;
      do { if (i >= buf.length) return; x = buf[i++]; n += (x & 127) * m; m *= 128; } while (x & 128);
      if (buf.length < i + n) return;
      const msg = buf.subarray(i, i + n); buf = buf.subarray(i + n);
      try { onMsg(dec(msg)); } catch (e) { log('BAD MESSAGE', e.message); sock.destroy(); return; }
    }
  });
}
const out = (sock, m) => sock.write(Buffer.concat([varint(m.length), m]));
const rsa = (k) => { const j = k.export({ format: 'jwk' }); return [Buffer.from(j.n, 'base64url'), Buffer.from(j.e, 'base64url')]; };

/** Plain TCP in front of each TLS server: while "unplugged", connections are held open and get no answer at all
    (as an unreachable TV looks from the server); otherwise they're handed to the TLS server. */
function front(tlsServer, port) {
  require('net').createServer((sock) => {
    sock.on('error', () => {});
    if (mode.unplugged) { setTimeout(() => sock.destroy(), 60000); return; }
    tlsServer.emit('connection', sock);
  }).listen(port, HOST, () => { if (port === 6466) log(`ready, ${tv.on ? 'on' : 'off'}`); });
}

// ---- pairing, port 6467
const pairServer = tls.createServer(opts, (sock) => {
  sock.on('error', () => {});
  const client = sock.getPeerX509Certificate();
  if (!client) { log('pair: no client certificate'); return sock.destroy(); }
  let secret = null;
  const reply = (fields, status = 200) => out(sock, enc([[1, 2], [2, status], ...fields]));
  frames(sock, (m) => {
    if ((m[1] || [])[0] !== 2 || (m[2] || [])[0] !== 200) log('PROBLEM: client sent version', m[1], 'status', m[2]);
    if (m[10]) {
      const r = dec(m[10][0]);
      log(`pair: request from "${r[2] ? r[2][0] : ''}" service=${r[1] ? r[1][0] : ''}`);
      reply([[11, [[1, 'Pretend TV']]]]);
    } else if (m[20]) reply([[20, [[1, [[1, 3], [2, 6]]], [3, 1]]]]);
    else if (m[30]) {
      const nonce = crypto.randomBytes(2);
      const h = crypto.createHash('sha256');
      for (const b of [...rsa(client.publicKey), ...rsa(crypto.createPublicKey(opts.key))]) h.update(b);
      h.update(nonce);
      secret = h.digest();
      tv.code = (secret.subarray(0, 1).toString('hex') + nonce.toString('hex')).toUpperCase();
      log('pair: showing code', tv.code);
      reply([[31, []]]);
    } else if (m[40]) {
      const got = dec(m[40][0])[1][0];
      if (secret && got.equals(secret)) { tv.paired.add(client.fingerprint256); tv.code = ''; log('pair: paired'); reply([[41, [[1, got]]]]); }
      else { log('pair: wrong code'); reply([], 402); }
    }
  });
  sock.on('close', () => { if (tv.code) { tv.code = ''; log('pair: cancelled'); } });
});

// ---- remote, port 6466
const remotes = new Set();
const report = () => { if (!mode.noReport) for (const s of remotes) out(s, enc([[40, [[1, tv.on]]]])); };
function setOn(on, why) {
  if (on === tv.on) return;
  tv.on = on;
  log(`now ${on ? 'ON' : 'OFF'} (${why})`);
  report();
}
const remoteServer = tls.createServer(opts, (sock) => {
  sock.on('error', () => {});
  const client = sock.getPeerX509Certificate();
  if (!client || !tv.paired.has(client.fingerprint256)) { log('remote: unknown client, closing'); return sock.destroy(); }
  out(sock, enc([[1, [[1, 622], [2, [[1, 'Pretend 55"'], [2, 'Kogan'], [3, 1], [4, '1'], [5, 'com.google.android.tv.remote.service'], [6, '5.2']]]]]]));
  const ping = setInterval(() => out(sock, enc([[8, [[1, 5], [2, 1]]]])), 5000);
  sock.on('close', () => { clearInterval(ping); remotes.delete(sock); });
  frames(sock, (m) => {
    if (m[1]) out(sock, enc([[2, [[1, 622]]]]));
    else if (m[2]) {
      remotes.add(sock);
      out(sock, enc([[40, [[1, tv.on]]]]));
      out(sock, enc([[20, [[1, [[1, 1], [12, tv.on ? 'de.ozerov.fully' : 'com.google.android.tvlauncher']]], [2, [[1, 0]]]]]]));
    } else if (m[10]) {
      const k = dec(m[10][0]);
      const code = k[1][0];
      tv.keys.push(code);
      log('remote: key', code, { 26: 'POWER', 223: 'SLEEP', 224: 'WAKEUP' }[code] || '');
      let next = tv.on;
      if (code === 26) next = !tv.on;
      else if (code === 224 && !mode.ignoreWake) next = true;
      else if (code === 223 && !mode.ignoreWake) next = false;
      if (next !== tv.on) setTimeout(() => setOn(next, 'key ' + code), mode.delay);
    }
  });
});
front(pairServer, 6467);
front(remoteServer, 6466);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = Object.fromEntries(u.searchParams);
  if (u.pathname === '/code') return res.end(tv.code);
  if (u.pathname === '/set') setOn(q.on === '1', 'its own remote');
  if (u.pathname === '/forget') { tv.paired.clear(); log('forgot every pairing'); }
  if (u.pathname === '/mode') {
    for (const k of ['ignoreWake', 'noReport', 'unplugged']) if (k in q) mode[k] = q[k] === '1';
    if (q.delay) mode.delay = +q.delay;
    log('mode', JSON.stringify(mode));
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ on: tv.on, paired: tv.paired.size, keys: tv.keys, mode }));
}).listen(+CONTROL, '127.0.0.1');
