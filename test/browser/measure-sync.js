#!/usr/bin/env node
'use strict';
/**
 * How far apart are screens showing the same playlist? Opens TV 1–3 side by side (switched on at different
 * moments): TV 2 on a slow network (100 ms each way through test/net/delay-proxy.js), TV 3 with a half-speed
 * CPU. Reports the spread of item changes and of video positions, per screen, and whether the video watchdog
 * fired during normal playback (it shouldn't).
 *
 *   node test/browser/measure-sync.js [seconds=75] [--unmeasured]
 *   --unmeasured  videos start without a recorded length (as after an upgrade), so you also see the TVs
 *                 measuring them and switching to synced playback
 *
 * Results from 1.13.1: item changes ~3–8 ms apart (median), videos ~3–4 ms; 1.12.1 (before sync): ~3.2 s.
 */
const path = require('path');
const { spawn } = require('child_process');
const { WORK, sleep, startServer, playwright } = require('../common');
const syncContent = require('./sync-content');

const SECS = +(process.argv.find((a) => /^\d+$/.test(a)) || 75);
const PORT = 3971, RELAY = 4071;
(async () => {
  const data = path.join(WORK, 'measure-sync');
  syncContent(data, { lengths: !process.argv.includes('--unmeasured') });
  const srv = startServer(PORT, data);
  const relay = spawn(process.execPath, [path.join(__dirname, '../net/delay-proxy.js'), RELAY, PORT, 100], { stdio: 'ignore' });
  await sleep(1300);
  const { chromium } = playwright();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const profiles = ['normal', 'slow network (100 ms each way)', 'slow CPU (2x)'];
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
    const p = await ctx.newPage();
    await p.addInitScript(syncContent.INSTRUMENT);
    if (i === 2) await (await ctx.newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: 2 });
    pages.push({ p, name: `TV ${i + 1} (${profiles[i]})` });
    p.goto(`http://127.0.0.1:${i === 1 ? RELAY : PORT}/player/s${i + 1}`);
    await sleep(1300 + i * 400); // switched on at different moments
  }
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const data2 = [];
  for (const { p, name } of pages) data2.push({ name, ev: await p.evaluate(() => window.__ev), vs: await p.evaluate(() => window.__vs), retried: await p.evaluate(() => !!window.__retried) });
  await b.close(); srv.kill(); relay.kill();

  const pct = (a, q) => { if (!a.length) return '–'; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const near = (list, t, l) => list.filter(([, k]) => k === l).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0];
  const ref = data2[0].ev.filter(([t]) => t > t0 + 5000);
  const spreads = [];
  for (const [t, l] of ref) {
    const ts = [t];
    for (const d of data2.slice(1)) { const m = near(d.ev, t, l); if (m) ts.push(m[0]); }
    if (ts.length === data2.length) spreads.push({ at: Math.round((t - t0) / 1000), ms: Math.max(...ts) - Math.min(...ts) });
  }
  const vsp = [];
  const sampleAt = (vs, T) => vs.filter(([u]) => Math.abs(u - T) <= 60).sort((a, b) => Math.abs(a[0] - T) - Math.abs(b[0] - T))[0];
  for (let T = t0 + 5000; T < t0 + SECS * 1000; T += 500) {
    const at = data2.map((d) => { const s = sampleAt(d.vs, T); return s && { l: s[1], pos: s[2] + (T - s[0]) / 1000 }; });
    if (at.every((x) => x && x.l === at[0].l)) vsp.push(Math.round((Math.max(...at.map((x) => x.pos)) - Math.min(...at.map((x) => x.pos))) * 1000));
  }
  const rel = data2.slice(1).map((d) => {
    const off = []; for (const [t, l] of ref) { const m = near(d.ev, t, l); if (m && Math.abs(m[0] - t) < 2000) off.push(m[0] - t); }
    const voff = [];
    for (let T = t0 + 15000; T < t0 + SECS * 1000; T += 500) { const a = sampleAt(data2[0].vs, T), c = sampleAt(d.vs, T); if (a && c && a[1] === c[1]) voff.push(Math.round((a[2] + (T - a[0]) / 1000 - (c[2] + (T - c[0]) / 1000)) * 1000)); }
    return `${d.name}: item changes ${pct(off, 0.5)} ms, video ${pct(voff, 0.5)} ms behind`;
  });
  const ms = spreads.map((s) => s.ms);
  console.log(`Item changes compared: ${ms.length}   spread median ${pct(ms, 0.5)} ms, 90% ${pct(ms, 0.9)} ms, worst ${Math.max(...ms, 0)} ms`);
  console.log(`Spread over time: ${spreads.map((s) => `${s.at}s:${s.ms}`).join('  ')}`);
  console.log(`Video positions (all on the same video): ${vsp.length} samples, spread median ${pct(vsp, 0.5)} ms, 90% ${pct(vsp, 0.9)} ms`);
  console.log(`Compared with ${data2[0].name}:\n  ${rel.join('\n  ')}`);
  console.log(`Watchdog reloaded a video during normal playback: ${data2.map((d) => d.name.split(' (')[0] + '=' + (d.retried ? 'YES (unexpected)' : 'no')).join(', ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
