#!/usr/bin/env node
'use strict';
/**
 * A browser whose download of a video is stuck (it stalls after 3 MB at its usual address, however often it's
 * asked for again, like Chrome's cache holding a broken download after the server rebooted). Since 1.13.1 the
 * player notices the video isn't moving and loads it from a fresh address (?retry=…), which works.
 * Then the same after a refresh (F5).
 *
 *   bash test/fixtures/make-media.sh --long    (once)
 *   node test/browser/stuck-video.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORK, sleep, startServer, playwright, writeDb, textSlide, media } = require('../common');

const SRV = 4311, RELAY = 4312, CTL = 4313;
(async () => {
  const data = path.join(WORK, 'stuck-video');
  fs.rmSync(data, { recursive: true, force: true });
  writeDb(data, {
    media: [textSlide('t1', 'Welcome'), { id: 'mL', type: 'video', name: 'Long video', file: 'long.webm', createdAt: 1, length: 40 }],
    playlists: [{ id: 'P', name: 'Main', items: [{ id: 'i1', mediaId: 't1', duration: 3 }, { id: 'i2', mediaId: 'mL' }] }],
    screens: [{ id: 's1', name: 'Foyer TV', defaultPlaylistId: 'P' }],
  });
  fs.copyFileSync(media('long.webm'), path.join(data, 'uploads/long.webm'));
  const relay = spawn(process.execPath, [path.join(__dirname, '../net/power-cut-relay.js'), RELAY, SRV, CTL], { stdio: 'inherit', env: { ...process.env, STALL_PATH: '/uploads/long.webm' } });
  const srv = startServer(SRV, data);
  await sleep(1300);
  const { chromium } = playwright();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage({ viewport: { width: 800, height: 450 } });
  const t0 = Date.now(); const T = () => String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's';
  const look = () => page.evaluate(() => {
    const v = [...document.querySelectorAll('#stage .layer.show video')].pop();
    const h = [...document.querySelectorAll('#stage .layer.show h1')].pop();
    return v ? `${(v.currentSrc || '').split('/').pop()} t=${v.currentTime.toFixed(1)} ready=${v.readyState}` : h ? h.textContent : '(nothing)';
  }).catch(() => '(reloading)');
  const watch = async (n, tag) => { let last = ''; for (let i = 0; i < n; i++) { const s = await look(); const k = s.replace(/t=(\d+)\S*/, (m, x) => 't' + Math.floor(x / 5)); if (k !== last) console.log(`  ${T()}  ${tag} ${s}`); last = k; await sleep(1000); } };
  await page.goto(`http://127.0.0.1:${RELAY}/player/s1`);
  await watch(35, 'playing  ');
  console.log(`  ${T()}  >>> refresh (F5)`); await page.reload();
  await watch(30, 'refreshed');
  const fresh = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => /retry=/.test(v.currentSrc)));
  console.log(`\n  The video recovered from a fresh address: ${fresh ? 'yes' : 'NO'}`);
  await b.close(); srv.kill(); relay.kill();
})().catch((e) => { console.error(e); process.exit(1); });
