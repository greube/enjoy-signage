#!/usr/bin/env node
'use strict';
/**
 * A pretend Spotify (accounts + Web API) with one iPad that plays music, for testing the pause/resume logic.
 *
 *   node test/mocks/spotify.js PORT MODE      then start the server with
 *   SPOTIFY_ACCOUNTS_BASE=http://127.0.0.1:PORT SPOTIFY_API_BASE=http://127.0.0.1:PORT/v1
 *
 * MODE (what the iPad does once it's paused):
 *   normal    stays the active device; "play" works                       (a desk PC or a speaker)
 *   inactive  goes inactive after 2 s: plain "play" fails with 404, moving playback to it works
 *   asleep    drops off the device list after 2 s; comes back (inactive) WAKE seconds after the pause (default 20)
 *   gone      drops off the device list after 2 s and never comes back
 * Every request is printed with the time. GET /mock shows the iPad's state; GET /mock?mode=X changes mode.
 */
const http = require('http');
const PORT = +(process.argv[2] || 4401);
let mode = process.argv[3] || 'normal';
const WAKE = +(process.env.WAKE || 20) * 1000;
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const ipad = { id: 'ipad-1', name: 'Worship iPad', type: 'Tablet', volume_percent: 70, supports_volume: true, playing: true, active: true, listed: true, pausedAt: 0 };

function tick() { // the iPad's life after a pause
  if (ipad.playing || !ipad.pausedAt) return;
  const since = Date.now() - ipad.pausedAt;
  if (mode === 'inactive' && since > 2000) ipad.active = false;
  if ((mode === 'asleep' || mode === 'gone') && since > 2000) { ipad.active = false; ipad.listed = false; }
  if (mode === 'asleep' && since > WAKE) ipad.listed = true;
}
const device = () => ({ id: ipad.id, name: ipad.name, type: ipad.type, is_active: ipad.active, volume_percent: ipad.volume_percent, supports_volume: true });
const play = () => { ipad.playing = true; ipad.active = true; ipad.listed = true; ipad.pausedAt = 0; };
const noDevice = (res) => json(res, 404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    tick();
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p !== '/mock' && !(req.method === 'GET' && p === '/v1/me/player' && process.env.QUIET_POLL)) console.log(`${T()}  ${req.method} ${p}${u.search}${body ? ' ' + body : ''}`);
    if (p === '/mock') { if (u.searchParams.get('mode')) mode = u.searchParams.get('mode'); return json(res, 200, { mode, ...ipad }); }
    if (p === '/api/token') return json(res, 200, { access_token: 'mock-access', token_type: 'Bearer', expires_in: 3600, scope: 'user-modify-playback-state' });
    if (p === '/v1/me') return json(res, 200, { id: 'church', display_name: 'Enjoy Church' });
    if (p === '/v1/me/player' && req.method === 'GET') {
      if (!ipad.active) return json(res, 204);
      return json(res, 200, { device: device(), is_playing: ipad.playing, shuffle_state: false, repeat_state: 'off', progress_ms: 1000, item: { name: 'Goodness of God', artists: [{ name: 'Bethel Music' }], duration_ms: 300000 } });
    }
    if (p === '/v1/me/player/devices') return json(res, 200, { devices: ipad.listed ? [device()] : [] });
    if (p === '/v1/me/player/volume') { if (!ipad.active) return noDevice(res); ipad.volume_percent = +u.searchParams.get('volume_percent'); return json(res, 204); }
    if (p === '/v1/me/player/pause') { if (!ipad.active) return noDevice(res); ipad.playing = false; ipad.pausedAt = Date.now(); console.log(`${T()}  ⏸  iPad paused (mode ${mode})`); return json(res, 204); }
    if (p === '/v1/me/player/play') {
      if (!ipad.active) return noDevice(res);
      play(); console.log(`${T()}  ▶  iPad playing again`); return json(res, 204);
    }
    if (p === '/v1/me/player' && req.method === 'PUT') { // transfer playback
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (!ipad.listed || !(b.device_ids || []).includes(ipad.id)) return json(res, 404, { error: { status: 404, message: 'Device not found' } });
      if (b.play) { play(); console.log(`${T()}  ▶  iPad playing again (playback moved to it)`); } else ipad.active = true;
      return json(res, 204);
    }
    json(res, 404, { error: { status: 404, message: 'Not in the mock: ' + p } });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`${T()}  mock Spotify on :${PORT}, mode ${mode}${mode === 'asleep' ? `, wakes ${WAKE / 1000} s after a pause` : ''}`));
