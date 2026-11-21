#!/usr/bin/env node
'use strict';
/**
 * Plays one video's worth of "pause the music" against the mock Spotify and shows what the server does.
 *
 *   node test/mocks/spotify-drive.js MODE [video seconds=8] [watch seconds=60]
 * Environment: KEEP=0 turns off "keep trying to resume" (the Setup toggle); WAKE=n for asleep mode.
 * Prints the mock's log (every Spotify call) and the admin panel's Spotify status line as it changes.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORK, sleep, startServer, writeDb, textSlide, signInAsAdmin } = require('../common');

const [mode = 'normal', video = '8', watch = '60'] = process.argv.slice(2);
const SRV = 4402, MOCK = 4401;
(async () => {
  const data = path.join(WORK, 'spotify-' + mode);
  fs.rmSync(data, { recursive: true, force: true });
  writeDb(data, { media: [textSlide('t1', 'Welcome')], playlists: [{ id: 'P', name: 'Main', items: [{ id: 'i1', mediaId: 't1', duration: 8 }] }], screens: [{ id: 's1', name: 'Foyer TV', defaultPlaylistId: 'P' }] });
  fs.writeFileSync(path.join(data, 'spotify.json'), JSON.stringify({ clientId: 'test-client', refreshToken: 'mock-refresh', user: 'Enjoy Church', mode: 'pause', fadeSeconds: 0.5, resumeDelaySeconds: 1, keepTrying: process.env.KEEP !== '0' }));
  const mock = spawn(process.execPath, [path.join(__dirname, 'spotify.js'), MOCK, mode], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, QUIET_POLL: '1' } });
  await sleep(300);
  const srv = startServer(SRV, data, { SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${MOCK}`, SPOTIFY_API_BASE: `http://127.0.0.1:${MOCK}/v1` });
  await sleep(1300);
  const base = `http://127.0.0.1:${SRV}`;
  const { api } = await signInAsAdmin(base, data);
  const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  let last = '';
  const status = async () => {
    const sp = (await api('GET', '/api/state')).spotify || {};
    const line = [sp.lastAction, sp.lastError && 'PROBLEM: ' + sp.lastError].filter(Boolean).join(' | ');
    if (line && line !== last) console.log(`${T()}  [server] ${line}`);
    last = line;
  };
  console.log(`${T()}  --- video starts on Foyer TV (keep trying: ${process.env.KEEP !== '0' ? 'on' : 'off'})`);
  await fetch(`${base}/api/player/s1/music?hold=1&item=Announcement%20video`, { method: 'POST' });
  for (let i = 0; i < +video; i++) { await sleep(1000); await status(); }
  console.log(`${T()}  --- video ends`);
  await fetch(`${base}/api/player/s1/music?hold=0`, { method: 'POST' });
  for (let i = 0; i < +watch; i++) { await sleep(1000); await status(); }
  const ipad = await (await fetch(`http://127.0.0.1:${MOCK}/mock`)).json();
  console.log(`${T()}  RESULT: the iPad is ${ipad.playing ? 'PLAYING' : 'not playing'}`);
  srv.kill(); mock.kill();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
