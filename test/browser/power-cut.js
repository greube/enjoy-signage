#!/usr/bin/env node
'use strict';
/**
 * Acts out the server PC losing power while a TV plays a long video, then coming back. Watches what the TV
 * shows throughout, then after a refresh, then after closing and reopening the browser (its cache is kept on
 * disk, like an installed browser).
 *
 *   bash test/fixtures/make-media.sh --long        (once: makes the 40 s, ~160 MB clip)
 *   node test/browser/power-cut.js [--original]     --original: no video lengths, so the original engine plays
 *
 * Options (environment): PLAY, DOWN, AFTER, REFRESHED = seconds for each phase (14/20/40/20);
 *   RESET_MS (default 45000) and REFUSE=1, REQLOG=file: passed to test/net/power-cut-relay.js
 *
 * Expected since 1.13.1: the offline dot appears during the outage, and within about a second of the server
 * returning the player reloads and plays at the right point. (Before: frozen until the browser was restarted.)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORK, sleep, startServer, playwright, writeDb, textSlide, media } = require('../common');

const SRV = 4301, RELAY = 4302, CTL = 4303;
const synced = !process.argv.includes('--original');
const secs = (k, d) => +(process.env[k] || d);
(async () => {
  const data = path.join(WORK, 'power-cut');
  fs.rmSync(data, { recursive: true, force: true });
  writeDb(data, {
    media: [textSlide('t1', 'Welcome'),
      { id: 'mL', type: 'video', name: 'Long video', file: 'long.webm', createdAt: 1, ...(synced ? { length: 40 } : {}) },
      { id: 'mS', type: 'video', name: 'Short video', file: 'short.webm', createdAt: 1, ...(synced ? { length: 7 } : {}) }],
    playlists: [{ id: 'P', name: 'Main', transition: 'fade', items: [{ id: 'i1', mediaId: 't1', duration: 3 }, { id: 'i2', mediaId: 'mL' }, { id: 'i3', mediaId: 'mS' }] }],
    screens: [{ id: 's1', name: 'Foyer TV', defaultPlaylistId: 'P' }],
  });
  fs.copyFileSync(media('long.webm'), path.join(data, 'uploads/long.webm'));
  fs.copyFileSync(media('v7.webm'), path.join(data, 'uploads/short.webm'));

  const relay = spawn(process.execPath, [path.join(__dirname, '../net/power-cut-relay.js'), RELAY, SRV, CTL], { stdio: 'inherit', env: { RESET_MS: '45000', ...process.env } });
  let srv = startServer(SRV, data);
  await sleep(1300);
  const ctl = (p) => fetch(`http://127.0.0.1:${CTL}${p}`).then((r) => r.json());
  const profile = path.join(WORK, 'power-cut-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const { chromium } = playwright();
  const launch = () => chromium.launchPersistentContext(profile, { args: ['--autoplay-policy=no-user-gesture-required'], viewport: { width: 800, height: 450 } });
  let ctx = await launch(); let page = ctx.pages()[0] || (await ctx.newPage());
  const t0 = Date.now(); const T = () => String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's';
  let last = '';
  const look = async (tag) => {
    const s = await page.evaluate(() => {
      const top = [...document.querySelectorAll('#stage .layer.show')].sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0];
      const v = top && top.querySelector('video'); const h = top && top.querySelector('h1');
      const off = document.getElementById('status').style.display === 'block' ? ' [offline dot]' : '';
      if (v) return `${(v.currentSrc || '').split('/').pop().replace(/\?retry=\w+/, ' (fresh address)')} t=${v.currentTime.toFixed(1)}${v.paused ? ' PAUSED' : ''} ready=${v.readyState}${v.error ? ' ERROR ' + v.error.code : ''}${off}`;
      return (h ? h.textContent : top ? '(layer)' : '(nothing)') + off;
    }).catch((e) => '(page busy: ' + e.message.split('\n')[0].slice(0, 40) + ')');
    const key = (tag + s).replace(/t=([\d]+)[\d.]*/, (m, n) => 't' + Math.floor(n / 4)); // print when it changes (or moves 4 s on)
    if (key !== last) console.log(`  ${T()}  ${tag} ${s}`);
    last = key;
  };
  const watch = async (n, tag) => { for (let i = 0; i < n; i++) { await look(tag); await sleep(1000); } };
  console.log(`Engine: ${synced ? 'synced (video lengths known)' : 'original (no video lengths)'}`);
  await page.goto(`http://127.0.0.1:${RELAY}/player/s1`);
  await watch(secs('PLAY', 14), 'playing    ');
  console.log(`  ${T()}  >>> POWER CUT: connections go silent; server off for ${secs('DOWN', 20)} s`);
  await ctl('/crash'); srv.kill('SIGKILL');
  await watch(secs('DOWN', 20), 'server down');
  srv = startServer(SRV, data); await sleep(1200); await ctl('/up');
  console.log(`  ${T()}  >>> server back`);
  await watch(secs('AFTER', 40), 'after      ');
  console.log(`  ${T()}  >>> refresh (F5)`); await page.reload().catch(() => {});
  await watch(secs('REFRESHED', 20), 'refreshed  ');
  console.log(`  ${T()}  >>> close the browser and open it again`); await ctx.close();
  ctx = await launch(); page = ctx.pages()[0] || (await ctx.newPage()); await page.goto(`http://127.0.0.1:${RELAY}/player/s1`);
  await watch(15, 'new browser');
  await ctx.close(); srv.kill('SIGKILL'); relay.kill();
})().catch((e) => { console.error(e); process.exit(1); });
