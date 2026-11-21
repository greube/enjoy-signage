#!/usr/bin/env node
'use strict';
/**
 * Synced-playback scenarios with four browsers (takes about 3 minutes):
 *   A. a room: TV 3 (playlist Main) and TV 4 (playlist Other) change items together
 *   B. a TV switched on late joins at the right place (and doesn't show a blank screen first)
 *   C. a schedule starting on the next minute: every screen switches on the second, from the first item
 *   D. a takeover from the admin API: all screens start it together after the 3 s lead-in
 *   E. a play-once schedule: plays once together, then everyone returns together
 *   F. sync turned off for a playlist: that screen goes back to independent playback
 *
 *   node test/browser/sync-scenarios.js
 */
const path = require('path');
const { WORK, sleep, startServer, playwright, signInAsAdmin } = require('../common');
const syncContent = require('./sync-content');

const PORT = 3980, base = `http://127.0.0.1:${PORT}`;
const fmt = (t) => new Date(t).toISOString().slice(14, 23);
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
(async () => {
  const data = path.join(WORK, 'sync-scenarios');
  syncContent(data);
  const srv = startServer(PORT, data);
  await sleep(1300);
  const { api } = await signInAsAdmin(base, data);
  const { chromium } = playwright();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const open = async (id) => { const ctx = await b.newContext({ viewport: { width: 800, height: 450 } }); const p = await ctx.newPage(); await p.addInitScript(syncContent.INSTRUMENT); await p.goto(`${base}/player/${id}`); return { id, p }; };
  const evs = (x) => x.p.evaluate(() => window.__ev);
  const vpos = (x) => x.p.evaluate(() => { const s = window.__vs[window.__vs.length - 1]; return s && [s[1], s[2] + (Date.now() - s[0]) / 1000]; });
  const screen = async (id) => (await api('GET', '/api/state')).db.screens.find((s) => s.id === id);

  // A
  await api('PUT', '/api/screens/s3', { ...(await screen('s3')), room: 'Foyer' });
  await api('PUT', '/api/screens/s4', { ...(await screen('s4')), room: 'Foyer' });
  const [t3, t4] = [await open('s3'), await open('s4')];
  await sleep(40000);
  const [e3, e4] = [await evs(t3), await evs(t4)];
  const pairs = e3.slice(1).map(([t, l]) => { const m = e4.reduce((best, x) => (Math.abs(x[0] - t) < Math.abs(best[0] - t) ? x : best), e4[0]); return { t, l, other: m[1], d: m[0] - t }; }).filter((x) => x.t > e3[0][0] + 8000);
  console.log('A. Room "Foyer": TV 3 shows Main, TV 4 shows Other (Δ = how far apart they changed)');
  console.log('   ' + pairs.map((x) => `${x.l} | ${x.other}  Δ${x.d}ms`).join('\n   '));

  // B
  const t1 = await open('s1'); await sleep(20000);
  const tOpen = Date.now(); const t2 = await open('s2'); await sleep(12000);
  const [p1, p2] = [await vpos(t1), await vpos(t2)];
  const e2b = await evs(t2);
  console.log(`B. TV 2 switched on 20 s after TV 1: first thing appeared ${e2b[0] ? ((e2b[0][0] - tOpen) / 1000).toFixed(1) + ' s after opening (' + e2b[0][1] + ')' : 'never'}`);
  console.log(`   12 s later: TV 1 ${p1 && p1.join(' @ ')}, TV 2 ${p2 && p2.join(' @ ')}  Δ ${p1 && p2 && p1[0] === p2[0] ? Math.round((p1[1] - p2[1]) * 1000) + ' ms' : 'different items'}`);

  // C
  const at = new Date(Math.ceil((Date.now() + 15000) / 60000) * 60000);
  await api('POST', '/api/schedules', { name: 'Service start', playlistId: 'Q', screenIds: ['s1', 's2'], allScreens: false, days: [0, 1, 2, 3, 4, 5, 6], startTime: hm(at), endTime: hm(new Date(at.getTime() + 10 * 60000)), startDate: '', endDate: '', priority: 0, enabled: true });
  console.log(`C. Schedule for TV 1 + TV 2 starts at ${hm(at)}:00 (in ${Math.round((at - Date.now()) / 1000)} s)`);
  await sleep(at - Date.now() + 9000);
  const first = (e) => e.find(([t, l]) => t >= at.getTime() - 2000 && l === 'Room X1');
  const [f1, f2] = [first(await evs(t1)), first(await evs(t2))];
  console.log(`   TV 1 switched at ${f1 ? fmt(f1[0]) : '—'}, TV 2 at ${f2 ? fmt(f2[0]) : '—'} (scheduled ${fmt(at.getTime())}), both on the first item: ${!!(f1 && f2)}`);

  // D
  const tk0 = Date.now();
  const ov = await api('POST', '/api/overrides', { playlistId: 'P', allScreens: true, minutes: 0 });
  await sleep(9000);
  const ds = await Promise.all([t1, t2, t3, t4].map(async (x) => ({ id: x.id, e: (await evs(x)).find(([t, l]) => t > tk0 && l === 'Slide A') })));
  console.log(`D. Takeover on all screens, created at ${fmt(tk0)}, starts at ${fmt(ov.startAt)}:\n   ${ds.map((d) => `${d.id} ${d.e ? fmt(d.e[0]) : '—'}`).join('   ')}`);
  await api('DELETE', '/api/overrides/' + ov.id);

  // E
  const pl = (await api('GET', '/api/state')).db.playlists.find((x) => x.id === 'Q');
  await api('PUT', '/api/playlists/Q', { ...pl, playOnce: true });
  const sch = (await api('GET', '/api/state')).db.schedules[0];
  const at2 = new Date(Math.ceil((Date.now() + 12000) / 60000) * 60000);
  await api('PUT', '/api/schedules/' + sch.id, { ...sch, startTime: hm(at2), endTime: hm(new Date(at2.getTime() + 10 * 60000)) });
  console.log(`E. Play-once schedule at ${hm(at2)}:00 (in ${Math.round((at2 - Date.now()) / 1000)} s)`);
  await sleep(at2 - Date.now() + 22000);
  const after = (e) => e.filter(([t]) => t >= at2.getTime() - 1500).map(([t, l]) => `${fmt(t)} ${l}`);
  console.log(`   TV 1: ${after(await evs(t1)).join(' → ')}\n   TV 2: ${after(await evs(t2)).join(' → ')}`);

  // F
  const plP = (await api('GET', '/api/state')).db.playlists.find((x) => x.id === 'P');
  await api('PUT', '/api/playlists/P', { ...plP, sync: false });
  await sleep(3000);
  const sf = await api('GET', '/api/state');
  const tl = await (await fetch(base + '/api/player/s3/state')).json();
  console.log(`F. Sync off for "Main": TV 3 gets a timeline? ${!!tl.timeline} (expect false); admin shows: ${sf.resolved.s3.sync}; TV 4: ${sf.resolved.s4.sync}`);
  await b.close(); srv.kill();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
