#!/usr/bin/env node
'use strict';
/**
 * Switches Google TVs on and off over the network, the same way Google's own TV remote app on a
 * phone does ("Android TV Remote protocol v2"). No Fully Kiosk PLUS needed.
 *
 * For now this is a stand-alone test tool, so it can be tried on the real TVs before it becomes part
 * of the admin panel. Run it from the program folder (the one containing `server`):
 *
 *     node server/tvpower.js pair   192.168.1.50   once per TV: shows a code on the TV to type in here
 *     node server/tvpower.js status 192.168.1.50   on or in standby, model, and which app is in front
 *     node server/tvpower.js on     192.168.1.50
 *     node server/tvpower.js off    192.168.1.50
 *     node server/tvpower.js watch  192.168.1.50   checks every 5 minutes (--every N) and logs it
 *
 * How it works, briefly:
 * - Pairing (port 6467): this computer makes its own security certificate once, the TV shows a
 *   6-character code, and a hash of both certificates plus the code proves to the TV that the person
 *   typing it can see the screen. The TV then trusts this computer's certificate from then on.
 * - Remote (port 6466): with that certificate, the TV accepts key presses and reports whether it's
 *   on. "On" sends the WAKEUP key and "off" the SLEEP key, which only ever go one way. Only if the TV
 *   ignores those does it press POWER (which toggles), and only once it knows the TV is in the other
 *   state, so it can never switch the wrong way.
 *
 * Node built-ins only. The certificate and the protocol's (protobuf) messages are written byte by byte.
 */
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAIR_PORT = 6467;
const REMOTE_PORT = 6466;
const KEY = { POWER: 26, SLEEP: 223, WAKEUP: 224 };
const CLIENT_NAME = 'ENJOY Signage';

class Fail extends Error {}

// ---------------------------------------------------------------- protobuf, just the parts needed

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}

/** Returns [value, nextPosition], or null if the buffer ends part-way through. */
function readVarint(buf, pos) {
  let n = 0, mul = 1;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    n += (b & 127) * mul;
    if (!(b & 128)) return [n, pos];
    mul *= 128;
    if (mul > 2 ** 63) throw new Error('bad varint');
  }
}

/** Encodes [[fieldNumber, value], …]: numbers and booleans as varints, strings/Buffers as bytes, arrays as nested messages. */
function pb(fields) {
  const parts = [];
  for (const [num, v] of fields) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') parts.push(varint(num * 8), varint(Number(v)));
    else {
      const b = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v, 'utf8') : pb(v);
      parts.push(varint(num * 8 + 2), varint(b.length), b);
    }
  }
  return Buffer.concat(parts);
}

/** Decodes into { fieldNumber: [values] }. Length-delimited fields come back as Buffers (decode nested ones with unpb again). */
function unpb(buf) {
  const f = {};
  let pos = 0;
  while (pos < buf.length) {
    const k = readVarint(buf, pos);
    if (!k) throw new Error('truncated message');
    const num = Math.floor(k[0] / 8), type = k[0] % 8;
    let v, p = k[1];
    if (type === 0) { const r = readVarint(buf, p); if (!r) throw new Error('truncated message'); [v, p] = r; }
    else if (type === 2) {
      const r = readVarint(buf, p); if (!r || r[1] + r[0] > buf.length) throw new Error('truncated message');
      v = buf.subarray(r[1], r[1] + r[0]); p = r[1] + r[0];
    } else if (type === 5) { v = buf.subarray(p, p + 4); p += 4; }
    else if (type === 1) { v = buf.subarray(p, p + 8); p += 8; }
    else throw new Error(`unsupported wire type ${type}`);
    (f[num] = f[num] || []).push(v);
    pos = p;
  }
  return f;
}
const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : '');

// ---------------------------------------------------------------- a self-signed certificate (DER, by hand)

function der(tag, content) {
  const n = content.length;
  let len;
  if (n < 128) len = Buffer.from([n]);
  else { const b = []; for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x % 256); len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, content]);
}
const seq = (...x) => der(0x30, Buffer.concat(x));
const set = (...x) => der(0x31, Buffer.concat(x));
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const b = [n % 128];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) b.unshift((v % 128) | 128);
    out.push(...b);
  }
  return der(0x06, Buffer.from(out));
}
const derInt = (b) => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utcTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

/** A new RSA key and a self-signed certificate for it, as PEM text: what this computer shows the TV. */
function createIdentity(name = CLIENT_NAME) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const dn = seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(name, 'utf8')))));
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x3f) | 0x40; // positive, and no leading zero byte
  const tbs = seq(
    der(0xa0, derInt(Buffer.from([2]))), // version 3
    derInt(serial),
    sha256WithRSA,
    dn,
    seq(utcTime(new Date(Date.now() - 86400e3)), utcTime(new Date('2049-12-31T23:59:59Z'))),
    dn,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sha256WithRSA, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

/** RSA modulus and exponent as big-endian bytes without leading zeros. */
function rsaNumbers(keyObject) {
  const j = keyObject.export({ format: 'jwk' });
  return [Buffer.from(j.n, 'base64url'), Buffer.from(j.e, 'base64url')];
}

/** The pairing secret: SHA-256 of both keys and the last 4 characters of the code. Its first byte must equal the code's first 2 characters. */
function pairingSecret(clientCertPem, serverPublicKey, code) {
  const h = crypto.createHash('sha256');
  for (const b of rsaNumbers(new crypto.X509Certificate(clientCertPem).publicKey)) h.update(b);
  for (const b of rsaNumbers(serverPublicKey)) h.update(b);
  h.update(Buffer.from(code.slice(2), 'hex'));
  return h.digest();
}

// ---------------------------------------------------------------- a connection to the TV

/** One TLS connection carrying length-prefixed protobuf messages. */
class Link {
  constructor(sock) {
    this.sock = sock;
    this.queue = [];
    this.waiters = [];
    this.ended = null;
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let r;
        try { r = readVarint(buf, 0); } catch (e) { sock.destroy(e); return; }
        if (!r || buf.length < r[1] + r[0]) return;
        const msg = buf.subarray(r[1], r[1] + r[0]);
        buf = buf.subarray(r[1] + r[0]);
        const w = this.waiters.shift();
        if (w) w.resolve(msg); else this.queue.push(msg);
      }
    });
    const end = (e) => {
      if (this.ended) return;
      this.ended = e || new Error('closed');
      for (const w of this.waiters.splice(0)) w.reject(this.ended);
    };
    sock.on('error', end);
    sock.on('close', () => end());
  }
  next(ms) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        const e = new Error('timeout'); e.code = 'TIMEOUT'; reject(e);
      }, ms);
      this.waiters.push(w);
    });
  }
  send(msg) { if (!this.ended) this.sock.write(Buffer.concat([varint(msg.length), msg])); }
  close() { this.sock.destroy(); }
}

function open(host, port, identity, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host, port, key: identity.key, cert: identity.cert,
      rejectUnauthorized: false, // the TV's certificate is self-signed; pairing is what proves who's who
      checkServerIdentity: () => undefined,
    });
    const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, timeoutMs);
    sock.once('secureConnect', () => { clearTimeout(t); resolve(new Link(sock)); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function explainConnectError(e, host) {
  const c = e && e.code;
  if (c === 'ECONNREFUSED') return new Fail(`The device at ${host} answered but refused the connection. Is it a Google TV, and is this the right address?`);
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'TIMEOUT'].includes(c)) return new Fail(`Couldn't reach the TV at ${host}. It may be switched off at the wall, in a deep sleep that turns off its network, or its address may have changed.`);
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new Fail(`"${host}" isn't a known address.`);
  return null;
}

// ---------------------------------------------------------------- pairing

/**
 * Pairs this computer with a TV. askCode() is called once the TV shows its code, and is called again
 * (with the reason) if what was typed can't be right, up to 3 times.
 */
async function pair(host, identity, askCode, { port = PAIR_PORT, name = CLIENT_NAME } = {}) {
  let link;
  try { link = await open(host, port, identity); } catch (e) { throw explainConnectError(e, host) || e; }
  try {
    const msg = (fields) => pb([[1, 2], [2, 200], ...fields]);
    const expect = async (field, doing) => {
      let raw;
      try { raw = await link.next(15000); } catch (e) {
        throw new Fail(e.code === 'TIMEOUT' ? `The TV stopped answering while ${doing}.` : `The TV closed the connection while ${doing}.`);
      }
      const m = unpb(raw);
      const status = m[2] ? m[2][0] : 200;
      if (status === 402) throw new Fail('The TV didn’t accept the code. Run pair again and type the new code it shows.');
      if (status !== 200) throw new Fail(`The TV said no (status ${status}) while ${doing}.`);
      if (!m[field]) throw new Fail(`The TV answered something unexpected while ${doing}.`);
      return m;
    };
    const hex6 = [[1, 3], [2, 6]]; // hexadecimal, 6 characters
    link.send(msg([[10, [[1, 'atvremote'], [2, name]]]]));
    await expect(11, 'starting to pair');
    link.send(msg([[20, [[1, hex6], [3, 1]]]]));
    await expect(20, 'agreeing how to pair');
    link.send(msg([[30, [[1, hex6], [2, 1]]]]));
    await expect(31, 'asking it to show a code');

    const serverKey = link.sock.getPeerX509Certificate().publicKey;
    let secret, problem;
    for (let tries = 0; tries < 3 && !secret; tries++) {
      const code = String(await askCode(problem)).replace(/\s+/g, '').toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(code)) { problem = 'The code is 6 characters, using only 0–9 and A–F.'; continue; }
      const s = pairingSecret(identity.cert, serverKey, code);
      if (s[0] !== parseInt(code.slice(0, 2), 16)) { problem = 'That doesn’t match the code on the TV. Check it and type it again.'; continue; }
      secret = s;
    }
    if (!secret) throw new Fail(`${problem} Run pair again to start over.`);
    link.send(msg([[40, [[1, secret]]]]));
    await expect(41, 'checking the code');
    return true;
  } finally { link.close(); }
}

// ---------------------------------------------------------------- remote control

const FEATURES = 1 | 2 | 32 | 64 | 512; // ping, keys, power, volume, app links

/** A remote-control session. connect() resolves once the TV has said whether it's on. */
class Remote {
  constructor(link) {
    this.link = link;
    this.on = null;
    this.model = '';
    this.vendor = '';
    this.app = '';
    this.listeners = new Set();
  }

  static async connect(host, identity, { port = REMOTE_PORT, timeoutMs = 8000 } = {}) {
    let link;
    try { link = await open(host, port, identity, timeoutMs); } catch (e) {
      throw explainConnectError(e, host) || new Fail(`The TV at ${host} wouldn’t let this computer in. It isn’t paired yet, or the TV has forgotten it: run pair first. (${e.code || e.message})`);
    }
    const r = new Remote(link);
    const ready = new Promise((resolve, reject) => { r.ready = resolve; r.failed = reject; });
    r.loop();
    const t = setTimeout(() => r.failed(new Fail(`The TV at ${host} connected but didn’t say whether it’s on.`)), timeoutMs);
    try { await ready; } catch (e) {
      link.close();
      if (e instanceof Fail) throw e;
      throw new Fail(`The TV at ${host} closed the connection straight away. It isn’t paired with this computer yet, or has forgotten it: run pair first.`);
    } finally { clearTimeout(t); }
    return r;
  }

  async loop() {
    for (;;) {
      let raw;
      try { raw = await this.link.next(60000); } catch (e) {
        if (e.code === 'TIMEOUT') continue;
        this.failed(e);
        for (const fn of this.listeners) fn(null); // lets waitFor() give up straight away
        return;
      }
      let m;
      try { m = unpb(raw); } catch { continue; }
      if (m[1]) { // remote_configure: the TV introduces itself and its features
        const c = unpb(m[1][0]);
        const info = c[2] ? unpb(c[2][0]) : {};
        this.model = str(info[1] && info[1][0]);
        this.vendor = str(info[2] && info[2][0]);
        this.features = FEATURES & (c[1] ? c[1][0] : FEATURES);
        this.link.send(pb([[1, [[1, this.features], [2, [[3, 1], [4, '1'], [5, 'atvremote'], [6, '1.0.0']]]]]]));
      } else if (m[2]) { // remote_set_active
        this.link.send(pb([[2, [[1, this.features || FEATURES]]]]));
      } else if (m[8]) { // ping
        const p = unpb(m[8][0]);
        this.link.send(pb([[9, [[1, p[1] ? p[1][0] : 0]]]]));
      } else if (m[40]) { // remote_start: whether the TV is on (an empty message means off)
        const s = unpb(m[40][0]);
        this.on = !!(s[1] && s[1][0]);
        this.ready();
        for (const fn of this.listeners) fn(this.on);
      } else if (m[20]) { // remote_ime_key_inject: carries the app in front
        const k = unpb(m[20][0]);
        const appInfo = k[1] ? unpb(k[1][0]) : {};
        if (appInfo[12]) this.app = str(appInfo[12][0]);
      }
    }
  }

  key(code) { this.link.send(pb([[10, [[1, code], [2, 3]]]])); } // direction 3 = a short press

  /** Resolves true once the TV reports the wanted state, false after ms. */
  waitFor(on, ms) {
    if (this.on === on) return Promise.resolve(true);
    return new Promise((resolve) => {
      const fn = (now) => { if (now === on || now === null) { done(); resolve(now === on); } };
      const t = setTimeout(() => { done(); resolve(false); }, ms);
      const done = () => { clearTimeout(t); this.listeners.delete(fn); };
      this.listeners.add(fn);
    });
  }

  /** Brief pause so a just-pressed key is sent before closing. */
  close() { setTimeout(() => this.link.close(), 300); }
}

async function status(host, identity, opts) {
  const r = await Remote.connect(host, identity, opts);
  await new Promise((res) => setTimeout(res, 500)); // the app in front usually arrives just after
  r.close();
  return { on: r.on, model: r.model, vendor: r.vendor, app: r.app };
}

/** Switches the TV on or off. Returns { on, changed, how }. */
async function setPower(host, identity, on, opts = {}) {
  const wait = opts.waitMs || 8000;
  const again = () => Remote.connect(host, identity, opts).catch((e) => {
    throw new Fail(`Lost contact with the TV part-way through, so it may or may not have switched ${on ? 'on' : 'off'}. Check with: status`);
  });
  let r = await Remote.connect(host, identity, opts);
  try {
    if (r.on === on) return { on, changed: false };
    r.key(on ? KEY.WAKEUP : KEY.SLEEP);
    if (await r.waitFor(on, wait)) return { on, changed: true, how: on ? 'WAKEUP' : 'SLEEP' };
    // No news. Before pressing POWER, which toggles, ask again on a fresh connection: the TV may have
    // switched without saying so, and pressing POWER then would switch it straight back.
    r.close();
    r = await again();
    if (r.on === on) return { on, changed: true, how: on ? 'WAKEUP' : 'SLEEP' };
    // Some TVs ignore WAKEUP/SLEEP: press POWER, now that the TV has just said it's in the other state.
    r.key(KEY.POWER);
    if (await r.waitFor(on, wait)) return { on, changed: true, how: 'POWER' };
    r.close();
    r = await again();
    if (r.on === on) return { on, changed: true, how: 'POWER' };
    throw new Fail(`The TV didn’t switch ${on ? 'on' : 'off'}. It still says it’s ${r.on ? 'on' : 'in standby'}.`);
  } finally { r.close(); }
}

module.exports = { createIdentity, pair, status, setPower, Remote, pairingSecret, pb, unpb, varint, Fail, KEY };

// ---------------------------------------------------------------- command line (the test tool)

if (require.main === module) {
  const file = process.env.ENJOY_TV_REMOTE_FILE || path.join(os.homedir(), '.enjoy-signage-tv-remote.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const save = (d) => fs.writeFileSync(file, JSON.stringify(d, null, 2), { mode: 0o600 });
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
  const pairPort = Number(opt('--pair-port', PAIR_PORT));
  const port = Number(opt('--port', REMOTE_PORT));
  const every = Number(opt('--every', 5));
  const [cmd, host] = args;
  const say = (s) => console.log(`  ${s}`);
  const stamp = () => new Date().toLocaleString();
  const describe = (s) => `${s.on ? 'ON' : 'in STANDBY'}${s.vendor || s.model ? ` · ${[s.vendor, s.model].filter(Boolean).join(' ')}` : ''}${s.app ? ` · in front: ${s.app}` : ''}`;

  const main = async () => {
    if (!['pair', 'status', 'on', 'off', 'watch'].includes(cmd) || !host) {
      console.log('\n  Usage: node server/tvpower.js pair|status|on|off|watch TV-ADDRESS   (watch: add --every MINUTES)\n');
      process.exitCode = 1;
      return;
    }
    let data = load();
    if (!data || !data.identity) {
      data = { identity: createIdentity(), tvs: {} };
      save(data);
    }
    const id = data.identity;
    console.log('');
    if (cmd === 'pair') {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise((res) => rl.question(q, res));
      say(`Connecting to ${host}…`);
      try {
        await pair(host, id, (problem) => {
          if (problem) say(problem);
          else say('A code should now be showing on the TV.');
          return ask('  Type the code and press Enter: ');
        }, { port: pairPort });
      } finally { rl.close(); }
      const s = await status(host, id, { port }).catch(() => null);
      data.tvs[host] = { pairedAt: new Date().toISOString(), model: s ? [s.vendor, s.model].filter(Boolean).join(' ') : '' };
      save(data);
      say(`✔ Paired. ${s ? `The TV is ${describe(s)}.` : ''}`);
      say(`Try:  node server/tvpower.js off ${host}`);
    } else if (cmd === 'status') {
      const t0 = Date.now();
      const s = await status(host, id, { port });
      say(`${host}: ${describe(s)}   (answered in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } else if (cmd === 'on' || cmd === 'off') {
      const t0 = Date.now();
      const r = await setPower(host, id, cmd === 'on', { port });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      say(r.changed ? `✔ Switched ${cmd} in ${secs} s (with the ${r.how} key).` : `It was already ${cmd === 'on' ? 'on' : 'in standby'}. Nothing to do.`);
    } else if (cmd === 'watch') {
      const log = path.join(path.dirname(file), 'enjoy-signage-tv-watch.log');
      say(`Checking ${host} every ${every} minute(s). Leave this window open; press Ctrl+C to stop.`);
      say(`Also writing to ${log}`);
      for (;;) {
        let line;
        try { line = describe(await status(host, id, { port })); } catch (e) { line = `NOT REACHABLE: ${e.message}`; }
        line = `${stamp()}  ${host}  ${line}`;
        console.log(`  ${line}`);
        try { fs.appendFileSync(log, line + '\n'); } catch {}
        await new Promise((res) => setTimeout(res, every * 60e3));
      }
    }
    console.log('');
  };
  main().catch((e) => {
    console.error(`\n  \u001b[31m${e instanceof Fail ? e.message : e.stack || e.message}\u001b[0m\n`);
    process.exitCode = 1;
  });
}
