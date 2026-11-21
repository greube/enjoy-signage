#!/usr/bin/env node
'use strict';
/**
 * A TCP relay that delays traffic by DELAY ms in each direction: a slow but symmetric network.
 *   node test/net/delay-proxy.js LISTEN_PORT SERVER_PORT DELAY_MS
 *
 * Use this rather than Chrome's network emulation for clock-sync tests: Chrome adds its emulated latency to
 * responses only, which looks like a one-way delay and throws the clock estimate off by half of it.
 */
const net = require('net');
const [listen, target, delay] = process.argv.slice(2).map(Number);
net.createServer((c) => {
  const s = net.connect(target, '127.0.0.1');
  const pipe = (a, b) => {
    a.on('data', (d) => setTimeout(() => b.writable && b.write(d), delay));
    a.on('end', () => setTimeout(() => b.end(), delay));
    a.on('error', () => b.destroy());
  };
  pipe(c, s); pipe(s, c);
}).listen(listen, '127.0.0.1');
