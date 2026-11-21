#!/usr/bin/env node
'use strict';
/**
 * Sits between the browser and the server and acts out the server PC losing power and rebooting.
 *
 *   node test/net/power-cut-relay.js LISTEN_PORT SERVER_PORT CONTROL_PORT
 *   GET http://127.0.0.1:CONTROL_PORT/crash  → every open connection goes silent (no close, no data, like a
 *                                              PC that lost power); new connections get no answer
 *   GET http://127.0.0.1:CONTROL_PORT/up     → new connections reach the (restarted) server
 *
 * Like a real rebooted PC, a silent old connection is reset as soon as the browser sends anything on it after
 * /up. RESET_MS=45000 also resets the remaining silent ones that long after /up (TCP keepalive finding them).
 *
 * Other environment options:
 *   REFUSE=1            while down, refuse new connections instead of leaving them waiting
 *   REQLOG=file         log media requests (Range / If-* headers) and non-200 answers
 *   STALL_PATH=/uploads/x.webm   that address always stalls after its first 3 MB (a browser holding a broken
 *                       download); the same file with ?retry=… works
 */
const net = require('net');
const http = require('http');
const fs = require('fs');
const [LISTEN, TARGET, CTL] = process.argv.slice(2).map(Number);
const RESET_MS = +(process.env.RESET_MS || 0);
let down = false;
const live = new Set();
const frozen = new Set();
const waiting = [];

function forward(c) {
  const s = net.connect(TARGET, '127.0.0.1');
  const pair = { c, s };
  live.add(pair);
  if (process.env.STALL_PATH) {
    let stall = false;
    let sent = 0;
    c.on('data', (d) => { const t = d.toString('latin1', 0, 200); if (/^GET /.test(t)) stall = t.startsWith(`GET ${process.env.STALL_PATH} `) || t.startsWith(`GET ${process.env.STALL_PATH}?v`); });
    c.pipe(s);
    s.on('data', (d) => { if (stall) { sent += d.length; if (sent > 3e6) return; } c.write(d); });
    s.on('end', () => c.end());
  } else {
    c.pipe(s);
    s.pipe(c);
  }
  const LOG = process.env.REQLOG;
  if (LOG) {
    const stamp = () => new Date().toISOString().slice(14, 23);
    c.on('data', (d) => {
      const t = d.toString('latin1');
      if (!/^(GET|HEAD) \/(uploads|folders)\//.test(t)) return;
      const h = (n) => (new RegExp('^' + n + ': (.*)$', 'mi').exec(t) || [])[1];
      fs.appendFileSync(LOG, `${stamp()} ${t.split(' ')[1].split('?')[0]} range=${h('Range') || '-'} if-modified-since=${h('If-Modified-Since') ? 'yes' : '-'} if-range=${h('If-Range') ? 'yes' : '-'}\n`);
    });
    s.on('data', (d) => { const m = /^HTTP\/1\.1 (\d{3})/.exec(d.toString('latin1', 0, 40)); if (m && m[1] !== '200') fs.appendFileSync(LOG, `${stamp()}    → answered ${m[1]}\n`); });
  }
  const end = () => live.delete(pair);
  c.on('close', end); s.on('close', end);
  c.on('error', () => s.destroy()); s.on('error', () => c.destroy());
}

net.createServer((c) => {
  c.on('error', () => {});
  if (!down) return forward(c);
  if (process.env.REFUSE) c.resetAndDestroy(); else waiting.push(c);
}).listen(LISTEN, '127.0.0.1');

http.createServer((q, r) => {
  if (q.url === '/crash') {
    down = true;
    for (const p of live) {
      p.c.unpipe(p.s); p.s.unpipe(p.c); p.s.removeAllListeners('close'); p.s.destroy();
      frozen.add(p.c);
      p.c.on('data', () => { if (!down) { p.c.resetAndDestroy(); frozen.delete(p.c); } }); // the rebooted PC answers RST
    }
    live.clear();
  }
  if (q.url === '/up') {
    down = false;
    waiting.splice(0).forEach(forward);
    if (RESET_MS) setTimeout(() => { for (const c of frozen) c.resetAndDestroy(); frozen.clear(); }, RESET_MS);
  }
  r.end(JSON.stringify({ down, live: live.size, frozen: frozen.size }));
}).listen(CTL, '127.0.0.1');
