#!/usr/bin/env node
'use strict';
/**
 * Play-once playlists (about 4 minutes):
 *   1. scheduled on the next minute: plays once, then the screen goes back to its default
 *   2. the server restarts inside the schedule's window: it does NOT play again
 *   3. the schedule's start time is moved: that's a new occurrence, so it plays once more
 *   4. a play-once takeover of a single video: plays the video once, then the screen steps aside to its default
 *      (the takeover itself stays listed until it's ended or runs out, and the Screens page notes it has played)
 *   5. a play-once playlist set as a screen's default: still loops (as the guide says)
 *
 *   node test/browser/play-once.js
 */
const path = require('path');
const fs = require('fs');
const { WORK, sleep, startServer, playwright, signInAsAdmin, writeDb, textSlide, media } = require('../common');

const PORT = 3990, base = `http://127.0.0.1:${PORT}`;
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const fmt = (t) => new Date(t).toTimeString().slice(0, 8);
(async () => {
  const data = path.join(WORK, 'play-once');
  fs.rmSync(data, { recursive: true, force: true });
  writeDb(data, {
    media: [textSlide('d1', 'Default'), textSlide('o1', 'Once A', '#422'), textSlide('o2', 'Once B', '#242'), { id: 'm7', type: 'video', name: 'Video 7s', file: 'v7.webm', createdAt: 1, length: 7 }],
    playlists: [
      { id: 'D', name: 'Default', items: [{ id: 'i1', mediaId: 'd1', duration: 5 }] },
      { id: 'O', name: 'Welcome once', playOnce: true, items: [{ id: 'j1', mediaId: 'o1', duration: 4 }, { id: 'j2', mediaId: 'o2', duration: 4 }] },
      { id: 'V', name: 'Video once', playOnce: true, items: [{ id: 'k1', mediaId: 'm7' }] },
    ],
    screens: [{ id: 's1', name: 'Foyer TV', defaultPlaylistId: 'D' }, { id: 's2', name: 'Kids TV', defaultPlaylistId: 'O' }],
  });
  fs.copyFileSync(media('v7.webm'), path.join(data, 'uploads/v7.webm'));
  let srv = startServer(PORT, data);
  await sleep(1300);
  const { api } = await signInAsAdmin(base, data);
  const { chromium } = playwright();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const open = async (id) => { const p = await b.newPage({ viewport: { width: 640, height: 360 } }); await p.addInitScript(require('./sync-content').INSTRUMENT); await p.goto(`${base}/player/${id}`); return p; };
  const tv = await open('s1');
  const seen = async (p, since) => (await p.evaluate(() => window.__ev)).filter(([t]) => t >= since).map(([t, l]) => `${fmt(t)} ${l}`);
  const nextMinute = (lead) => new Date(Math.ceil((Date.now() + lead) / 60000) * 60000);

  // 1
  let at = nextMinute(12000);
  const sch = await api('POST', '/api/schedules', { name: 'Welcome', playlistId: 'O', screenIds: ['s1'], allScreens: false, days: [0, 1, 2, 3, 4, 5, 6], startTime: hm(at), endTime: hm(new Date(at.getTime() + 15 * 60000)), startDate: '', endDate: '', priority: 0, enabled: true });
  console.log(`1. Play-once schedule from ${hm(at)}`);
  await sleep(at - Date.now() + 16000);
  console.log('   ' + (await seen(tv, at.getTime() - 1000)).join(' → ') + '   (expect Once A → Once B → Default)');
  // 2
  srv.kill(); await sleep(800); srv = startServer(PORT, data); await sleep(1500);
  const t2 = Date.now(); await tv.reload(); await sleep(12000);
  console.log('2. After a server restart inside the window: ' + (await seen(tv, t2)).join(' → ') + '   (expect only Default)');
  // 3
  at = nextMinute(12000);
  const id = sch.id;
  const cur = (await api('GET', '/api/state')).db.schedules.find((s) => s.id === id);
  await api('PUT', '/api/schedules/' + id, { ...cur, startTime: hm(at) });
  console.log(`3. Start time moved to ${hm(at)}`);
  await sleep(at - Date.now() + 16000);
  console.log('   ' + (await seen(tv, at.getTime() - 1000)).join(' → ') + '   (expect Once A → Once B → Default)');
  // 4
  const t4 = Date.now();
  await api('POST', '/api/overrides', { playlistId: 'V', allScreens: false, screenIds: ['s1'], minutes: 0 });
  await sleep(16000);
  const note = (await api('GET', '/api/state')).resolved.s1.note;
  console.log('4. Play-once takeover of one video: ' + (await seen(tv, t4)).join(' → ') + `   (expect video → Default); Screens page: ${note || '—'} (expect "has played once")`);
  // 5
  const kids = await open('s2'); await sleep(14000);
  console.log('5. Play-once playlist as the default: ' + (await seen(kids, 0)).join(' → ') + `   (expect it to keep looping)`);
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
