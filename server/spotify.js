'use strict';
/*
 * Spotify background-music control for ENJOY Signage. Zero dependencies (uses Node's built-in fetch).
 *
 * The server does not play music itself. It remote-controls whichever device the church's
 * Spotify account is already playing on (sound desk PC, a speaker, a phone…) through the
 * Spotify Web API. Requires Spotify Premium on that account.
 *
 * How it works:
 *  - Players tell the server when they start an item that should silence the background music
 *    (a "hold"). Holds are leases: the player renews it on every poll, so if a TV is switched
 *    off mid-video the music comes back by itself after HOLD_MS.
 *  - While any screen holds, the music is faded down and paused (or just turned down, in
 *    "duck" mode). When the last hold ends, after a short delay so back-to-back videos don't
 *    make it flap, the music resumes and fades back up.
 *  - It never fights a person: if Spotify wasn't playing, nothing is touched; if someone has
 *    changed device or volume in the meantime, it leaves things alone.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';
const API = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative';
const HOLD_MS = 30000; // a hold expires if the player stops renewing it
const STATUS_TTL = 4000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function createSpotify({ dataDir, log = console, getSchedules = () => [], isActive = () => false }) {
  const FILE = path.join(dataDir, 'spotify.json');
  const DEFAULTS = {
    clientId: '',
    refreshToken: '',
    accessToken: '',
    expiresAt: 0,
    user: '',
    enabled: true,
    mode: 'pause', // 'pause' | 'duck'
    duckPercent: 15, // in duck mode: % of the normal volume
    fadeSeconds: 2,
    resumeDelaySeconds: 3,
    engaged: null, // what we changed, so it can be undone (persisted across restarts)
  };
  let cfg = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    log.error(`! spotify.json could not be read (${e.message}); Spotify needs reconnecting.`);
  }
  const save = () => {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, FILE);
  };

  const pending = new Map(); // OAuth state -> { verifier, redirectUri, at }
  const holds = new Map(); // screenId -> { until, label }
  let releaseTimer = null;
  let lastError = '';
  let lastAction = '';
  let status = null;
  let statusAt = 0;
  let statusLoading = null;

  /* ---------------- Auth ---------------- */

  function authUrl(redirectUri) {
    if (!cfg.clientId) throw Object.assign(new Error('Enter your Spotify Client ID first'), { status: 400 });
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
    pending.set(state, { verifier, redirectUri, at: Date.now() });
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    });
    return `${ACCOUNTS}/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const r = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Spotify sign-in failed: ${j.error_description || j.error || 'HTTP ' + r.status}`);
    cfg.accessToken = j.access_token;
    cfg.expiresAt = Date.now() + (j.expires_in || 3600) * 1000 - 60000;
    if (j.refresh_token) cfg.refreshToken = j.refresh_token; // Spotify may rotate it
    if (j.scope) cfg.scope = j.scope;
    save();
  }

  async function finishAuth(code, state) {
    const p = pending.get(state || '');
    if (!p) throw Object.assign(new Error('That sign-in link has expired or was already used. Click Connect again.'), { status: 400 });
    pending.delete(state);
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    try {
      const me = await api('GET', '/me');
      cfg.user = (me && (me.display_name || me.id)) || '';
      save();
    } catch {}
    lastError = '';
    statusAt = 0;
  }

  async function token() {
    if (!cfg.refreshToken) throw new Error('Spotify is not connected');
    if (cfg.accessToken && Date.now() < cfg.expiresAt) return cfg.accessToken;
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken });
    return cfg.accessToken;
  }

  async function api(method, p, body, retried = false) {
    const r = await fetch(API + p, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + (await token()) }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : method === 'PUT' || method === 'POST' ? '' : undefined,
    });
    if (r.status === 401 && !retried) {
      cfg.expiresAt = 0;
      return api(method, p, body, true);
    }
    if (r.status === 204) return null;
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const reason = j && j.error ? j.error.reason || j.error.message : '';
      const err = new Error(friendly(r.status, reason));
      err.status = r.status;
      err.reason = reason;
      throw err;
    }
    return j;
  }

  function friendly(code, reason) {
    if (reason === 'PREMIUM_REQUIRED') return 'Spotify Premium is needed to control playback';
    if (reason === 'NO_ACTIVE_DEVICE' || code === 404) return 'No Spotify device is active. Start playing music in Spotify first.';
    if (reason === 'VOLUME_CONTROL_DISALLOW') return 'This Spotify device does not allow volume control';
    if (code === 429) return 'Spotify is rate-limiting requests; try again shortly';
    if (code === 403) return 'Spotify refused the request' + (reason ? ` (${reason})` : '');
    return `Spotify error ${code}${reason ? ': ' + reason : ''}`;
  }

  /* ---------------- Playback helpers ---------------- */

  const playerState = () => api('GET', '/me/player');
  const dev = (id) => (id ? '?device_id=' + encodeURIComponent(id) : '');
  const setVolume = (v, id) => api('PUT', `/me/player/volume?volume_percent=${clamp(Math.round(v), 0, 100)}${id ? '&device_id=' + encodeURIComponent(id) : ''}`);

  async function fade(from, to, deviceId) {
    const ms = clamp(cfg.fadeSeconds, 0, 10) * 1000;
    const steps = ms ? clamp(Math.round(ms / 250), 1, 16) : 1;
    for (let i = 1; i <= steps; i++) {
      await setVolume(from + ((to - from) * i) / steps, deviceId);
      if (i < steps) await sleep(ms / steps);
    }
  }

  // All playback changes run one at a time, in order.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn).catch((e) => {
    lastError = e.message;
    log.error('Spotify: ' + e.message);
  }));

  async function engage() {
    if (cfg.engaged) return;
    const s = await playerState();
    if (!s || !s.is_playing || !s.device) {
      // Nothing playing: remember that we looked, so we don't start music that was never on.
      cfg.engaged = { touched: false, at: Date.now() };
      save();
      lastAction = 'Video started; Spotify was not playing, so nothing to pause';
      return;
    }
    const d = s.device;
    const canVol = d.supports_volume !== false && typeof d.volume_percent === 'number';
    const vol = canVol ? d.volume_percent : null;
    const e = { touched: true, at: Date.now(), deviceId: d.id, deviceName: d.name, volume: vol, mode: cfg.mode, setVolume: null, paused: false };
    cfg.engaged = e; // save first, so a crash mid-fade can still be undone
    save();
    if (cfg.mode === 'duck' && canVol) {
      const target = Math.round((vol * clamp(cfg.duckPercent, 0, 100)) / 100);
      await fade(vol, target, d.id);
      e.setVolume = target;
      lastAction = `Turned music down to ${target}% on ${d.name}`;
    } else {
      if (canVol) {
        const low = Math.min(vol, Math.max(1, Math.round(vol * 0.1)));
        await fade(vol, low, d.id).catch(() => {});
        e.setVolume = low;
      }
      await api('PUT', '/me/player/pause' + dev(d.id));
      e.paused = true;
      lastAction = `Paused music on ${d.name}`;
    }
    save();
    statusAt = 0;
  }

  async function release() {
    const e = cfg.engaged;
    if (!e) return;
    cfg.engaged = null;
    save();
    statusAt = 0;
    if (!e.touched) { lastAction = 'Video finished'; return; }
    let s = null;
    try { s = await playerState(); } catch {}
    const sameDevice = !s || !s.device || s.device.id === e.deviceId;
    if (!sameDevice) { lastAction = 'Music was moved to another device meanwhile; left it alone'; return; }
    const curVol = s && s.device ? s.device.volume_percent : null;
    const volUntouched = e.setVolume == null || curVol == null || Math.abs(curVol - e.setVolume) <= 2;
    if (e.paused && scheduleChangePending()) {
      // A music schedule started or ended during the video: don't resume the old music. Put the volume
      // back and let the schedule take over (it fades its own playlist in, or leaves the music stopped).
      if (e.volume != null && volUntouched) await setVolume(e.volume, e.deviceId).catch(() => {});
      lastAction = 'Video finished; switching to the scheduled music';
      setTimeout(scheduleTick, 300).unref();
      return;
    }
    if (e.paused) {
      if (s && s.is_playing) {
        // Someone already pressed play by hand. Just put the volume back if they left it where we set it.
        if (e.volume != null && volUntouched) await setVolume(e.volume, e.deviceId).catch(() => {});
        lastAction = 'Music was already resumed by hand';
        return;
      }
      await api('PUT', '/me/player/play' + dev(e.deviceId));
      if (e.volume != null) await fade(e.setVolume ?? e.volume, e.volume, e.deviceId).catch(() => {});
      lastAction = `Resumed music on ${e.deviceName}`;
      setTimeout(scheduleTick, 1500).unref(); // a music schedule may have started or ended during the video
    } else if (e.volume != null && volUntouched) {
      await fade(e.setVolume ?? e.volume, e.volume, e.deviceId);
      lastAction = `Turned music back up on ${e.deviceName}`;
    } else {
      lastAction = 'Volume was changed by hand meanwhile; left it alone';
    }
  }

  /* ---------------- Holds ---------------- */

  const connected = () => !!cfg.refreshToken;
  const activeHolds = () => {
    const now = Date.now();
    for (const [k, v] of holds) if (v.until <= now) holds.delete(k);
    return [...holds.entries()];
  };

  function evaluate() {
    if (!connected()) return;
    const want = cfg.enabled && activeHolds().length > 0;
    if (want) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
      if (!cfg.engaged) serial(engage);
    } else if (cfg.engaged && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!(cfg.enabled && activeHolds().length)) serial(release);
      }, clamp(cfg.resumeDelaySeconds, 0, 60) * 1000);
    }
  }

  /** Called by players. hold=true while an item that should silence the music is on screen. */
  function setHold(screenId, hold, label = '') {
    const had = holds.has(screenId);
    if (hold) holds.set(screenId, { until: Date.now() + HOLD_MS, label: String(label).slice(0, 200) });
    else holds.delete(screenId);
    if (hold !== had || hold) evaluate();
  }
  function dropScreen(screenId) { holds.delete(screenId); evaluate(); }

  // Expire stale holds, and undo a change left over from before a restart once players have had time to check in.
  setInterval(evaluate, 5000).unref();
  if (cfg.engaged) setTimeout(evaluate, HOLD_MS).unref();

  /* ---------------- Admin ---------------- */

  function refreshStatus() {
    if (!connected() || statusLoading) return statusLoading;
    statusLoading = playerState()
      .then((s) => {
        status = s
          ? {
              isPlaying: !!s.is_playing,
              device: s.device ? { name: s.device.name, type: s.device.type, volume: s.device.volume_percent, supportsVolume: s.device.supports_volume !== false } : null,
              shuffle: !!s.shuffle_state,
              repeat: s.repeat_state || 'off',
              context: s.context ? s.context.uri : '',
              track: s.item ? s.item.name : '',
              artist: s.item && s.item.artists ? s.item.artists.map((a) => a.name).join(', ') : s.item && s.item.show ? s.item.show.name : '',
              art: s.item && s.item.album && s.item.album.images && s.item.album.images.length ? s.item.album.images[s.item.album.images.length - 1].url : '',
            }
          : { isPlaying: false, device: null, track: '', artist: '' };
        if (/^Spotify (error|sign-in)|not connected/.test(lastError)) lastError = '';
      })
      .catch((e) => { status = null; lastError = e.message; })
      .finally(() => { statusAt = Date.now(); statusLoading = null; });
    return statusLoading;
  }

  /** Summary for the admin panel. Kicks off a background refresh of what's playing when stale. */
  function info(screenName = (id) => id) {
    if (connected() && Date.now() - statusAt > STATUS_TTL) refreshStatus();
    return {
      clientId: cfg.clientId,
      connected: connected(),
      user: cfg.user,
      enabled: cfg.enabled,
      mode: cfg.mode,
      duckPercent: cfg.duckPercent,
      fadeSeconds: cfg.fadeSeconds,
      resumeDelaySeconds: cfg.resumeDelaySeconds,
      engaged: cfg.engaged ? { touched: cfg.engaged.touched, deviceName: cfg.engaged.deviceName || '', mode: cfg.engaged.mode || cfg.mode, at: cfg.engaged.at } : null,
      holds: activeHolds().map(([id, h]) => ({ screenId: id, screen: screenName(id), item: h.label })),
      now: status,
      canListPlaylists: hasScope('playlist-read-private'),
      musicRun: cfg.musicRun || null,
      lastAction,
      lastError,
    };
  }

  function updateSettings(b) {
    if (b.clientId !== undefined) {
      const id = String(b.clientId || '').trim();
      if (id && !/^[0-9a-f]{32}$/i.test(id)) throw Object.assign(new Error('That does not look like a Spotify Client ID (32 letters and numbers)'), { status: 400 });
      if (id !== cfg.clientId) Object.assign(cfg, { clientId: id, refreshToken: '', accessToken: '', expiresAt: 0, user: '', engaged: null });
    }
    if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
    if (b.mode !== undefined) cfg.mode = b.mode === 'duck' ? 'duck' : 'pause';
    if (b.duckPercent !== undefined) cfg.duckPercent = clamp(parseInt(b.duckPercent, 10) || 0, 0, 100);
    if (b.fadeSeconds !== undefined) cfg.fadeSeconds = clamp(+b.fadeSeconds || 0, 0, 10);
    if (b.resumeDelaySeconds !== undefined) cfg.resumeDelaySeconds = clamp(+b.resumeDelaySeconds || 0, 0, 60);
    save();
    evaluate();
  }

  function disconnect() {
    Object.assign(cfg, { refreshToken: '', accessToken: '', expiresAt: 0, user: '', engaged: null });
    status = null;
    lastError = '';
    lastAction = '';
    save();
  }

  /** Manual buttons in the admin panel. */
  async function control(action) {
    if (!connected()) throw Object.assign(new Error('Spotify is not connected'), { status: 400 });
    lastError = '';
    if (action === 'resume-now') {
      holds.clear();
      clearTimeout(releaseTimer);
      releaseTimer = null;
      await serial(release);
    } else if (action === 'play' || action === 'pause') {
      await serial(async () => {
        if (cfg.engaged) { cfg.engaged = null; save(); } // a person took charge
        await api('PUT', `/me/player/${action}`);
        lastAction = action === 'play' ? 'Played from the admin panel' : 'Paused from the admin panel';
      });
    } else if (action === 'test') {
      setHold('__test__', true, 'Test from the admin panel');
      setTimeout(() => setHold('__test__', false), 10000).unref();
      await chain;
    } else if (action === 'next' || action === 'previous') {
      await serial(() => api('POST', `/me/player/${action}`));
    } else throw Object.assign(new Error('Unknown action'), { status: 400 });
    if (lastError && action !== 'resume-now') { const e = lastError; lastError = ''; throw Object.assign(new Error(e), { status: 502 }); }
    statusAt = 0;
    await refreshStatus();
  }

  /* ---------------- Choosing what plays ---------------- */

  const hasScope = (sc) => !cfg.scope || String(cfg.scope).split(' ').includes(sc); // older tokens didn't record scopes

  async function devices() {
    const j = await api('GET', '/me/player/devices');
    return ((j && j.devices) || []).filter((d) => d.id).map((d) => ({
      id: d.id, name: d.name, type: d.type, active: !!d.is_active, volume: d.volume_percent, supportsVolume: d.supports_volume !== false,
    }));
  }

  let plCache = null;
  let plAt = 0;
  async function playlists(fresh) {
    if (!fresh && plCache && Date.now() - plAt < 60000) return plCache;
    const out = [];
    let next = '/me/playlists?limit=50';
    for (let i = 0; i < 20 && next; i++) {
      let j;
      try { j = await api('GET', next); } catch (e) {
        if (e.status === 401 || e.status === 403) throw Object.assign(new Error('Reconnect Spotify (Setup → Background music → Disconnect, then Connect) so ENJOY Signage can list your playlists'), { status: 403 });
        throw e;
      }
      for (const p of (j && j.items) || []) {
        if (!p) continue;
        const t = p.items || p.tracks || {};
        out.push({ uri: p.uri, name: p.name, owner: p.owner ? p.owner.display_name || p.owner.id : '', image: p.images && p.images.length ? p.images[p.images.length - 1].url : '', total: t.total || 0 });
      }
      next = j && j.next ? j.next.replace(API, '') : null;
    }
    plCache = out;
    plAt = Date.now();
    return out;
  }

  /** Accept a Spotify link or URI for a playlist, album, artist or show; return a spotify: URI. */
  function parseUri(v) {
    const t = String(v || '').trim();
    let m = /^spotify:(playlist|album|artist|show):([A-Za-z0-9]{10,40})$/.exec(t);
    if (m) return `spotify:${m[1]}:${m[2]}`;
    m = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:user\/[^/]+\/)?(playlist|album|artist|show)\/([A-Za-z0-9]{10,40})/i.exec(t);
    if (m) return `spotify:${m[1].toLowerCase()}:${m[2]}`;
    return '';
  }

  /** Best-effort name for a URI (Spotify only lets development apps read some playlists). */
  async function describe(uri) {
    const [, type, id] = uri.split(':');
    const known = (plCache || []).find((p) => p.uri === uri);
    if (known) return known.name;
    try {
      const path = { playlist: `/playlists/${id}?fields=name`, album: `/albums/${id}`, artist: `/artists/${id}`, show: `/shows/${id}` }[type];
      const j = await api('GET', path);
      if (j && j.name) return j.name;
    } catch {}
    return { playlist: 'Spotify playlist', album: 'Spotify album', artist: 'Spotify artist', show: 'Spotify podcast' }[type] || 'Spotify';
  }

  /** Find a device by id, then by name (ids of some speakers change after a restart). */
  async function findDevice(want) {
    const list = await devices();
    if (!want || (!want.id && !want.name)) {
      const d = list.find((x) => x.active) || (status && status.device ? list.find((x) => x.name === status.device.name) : null);
      if (!d) throw Object.assign(new Error('No Spotify device is active. Open Spotify on the music computer or speaker, or choose a device.'), { status: 409 });
      return d;
    }
    const d = list.find((x) => x.id === want.id) || list.find((x) => want.name && x.name.toLowerCase() === String(want.name).toLowerCase());
    if (!d) throw Object.assign(new Error(`“${want.name || 'That device'}” isn't available in Spotify right now. Make sure Spotify is open on it and signed in to the church account.`), { status: 409 });
    return d;
  }

  /** Start a playlist/album on a device, optionally shuffled and at a set volume (faded in). */
  async function playContext({ uri, device, shuffle = null, volume = null, fade: doFade = true }) {
    if (!uri) throw Object.assign(new Error('Choose a playlist'), { status: 400 });
    const d = await findDevice(device);
    const target = volume != null ? clamp(+volume, 0, 100) : null;
    const canVol = d.supportsVolume;
    if (canVol && target != null && doFade) await setVolume(Math.min(target, 8), d.id).catch(() => {});
    const body = { context_uri: uri };
    if (shuffle === true && /^spotify:(playlist|album):/.test(uri)) {
      const total = ((plCache || []).find((p) => p.uri === uri) || {}).total;
      if (total > 1) body.offset = { position: Math.floor(Math.random() * total) }; // so the first song isn't always the same
    }
    await api('PUT', '/me/player/play' + dev(d.id), body);
    if (shuffle !== null) await api('PUT', `/me/player/shuffle?state=${shuffle ? 'true' : 'false'}&device_id=${encodeURIComponent(d.id)}`).catch(() => {});
    if (canVol && target != null) await (doFade ? fade(Math.min(target, 8), target, d.id) : setVolume(target, d.id)).catch(() => {});
    statusAt = 0;
    return d;
  }

  /** Fade out and pause, then put the volume back so the next manual play isn't silent. */
  async function stopMusic() {
    const s = await playerState().catch(() => null);
    if (!s || !s.is_playing || !s.device) return;
    const v = s.device.volume_percent;
    const canVol = s.device.supports_volume !== false && typeof v === 'number';
    if (canVol) await fade(v, Math.min(v, 3), s.device.id).catch(() => {});
    await api('PUT', '/me/player/pause' + dev(s.device.id));
    if (canVol) await setVolume(v, s.device.id).catch(() => {});
    statusAt = 0;
  }

  /** Manual controls on the Music page. */
  async function music(action, b = {}) {
    if (!connected()) throw Object.assign(new Error('Spotify is not connected'), { status: 400 });
    let err = null;
    await serial(async () => {
      try {
        if (action === 'play-uri') {
          const uri = parseUri(b.uri);
          if (!uri) throw Object.assign(new Error('Paste a Spotify playlist or album link (Share → Copy link), or pick one of your playlists'), { status: 400 });
          if (cfg.engaged) { cfg.engaged = null; save(); }
          const d = await playContext({ uri, device: b.device, shuffle: b.shuffle == null ? null : !!b.shuffle, volume: b.volume == null || b.volume === '' ? null : b.volume });
          lastAction = `Started ${await describe(uri)} on ${d.name}`;
        } else if (action === 'volume') {
          const s = await playerState();
          if (!s || !s.device) throw Object.assign(new Error('Nothing is playing'), { status: 409 });
          await setVolume(b.percent, s.device.id);
        } else if (action === 'shuffle') {
          await api('PUT', `/me/player/shuffle?state=${b.state ? 'true' : 'false'}`);
        } else if (action === 'repeat') {
          await api('PUT', `/me/player/repeat?state=${['off', 'context', 'track'].includes(b.state) ? b.state : 'off'}`);
        } else if (action === 'transfer') {
          const d = await findDevice(b.device);
          await api('PUT', '/me/player', { device_ids: [d.id], play: true });
          lastAction = `Moved the music to ${d.name}`;
        } else if (action === 'stop') {
          if (cfg.engaged) { cfg.engaged = null; save(); }
          await stopMusic();
          lastAction = 'Music stopped from the admin panel';
        } else throw Object.assign(new Error('Unknown action'), { status: 400 });
      } catch (e) { err = e; }
    });
    if (err) throw err.status ? err : Object.assign(err, { status: 502 });
    statusAt = 0;
    await refreshStatus();
  }

  /* ---------------- Music schedules ---------------- */
  // A schedule starts its playlist when it becomes the highest-priority active one, and (optionally)
  // fades out when it ends. Changes only happen at those moments, so anyone can still change the
  // music by hand in between. Nothing changes while the music is paused for a video: the switch
  // happens as soon as the video finishes.

  const runKey = (s) => `${s.id}|${s.uri}|${s.deviceName || ''}`;
  let ticking = false;
  let failed = { key: '', at: 0 };

  function activeSchedule(now = new Date()) {
    return getSchedules()
      .filter((s) => s.enabled && s.uri && isActive(s, now))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null;
  }

  function scheduleChangePending() {
    const act = activeSchedule();
    return (act ? runKey(act) : null) !== (cfg.musicRun ? cfg.musicRun.key : null);
  }

  async function scheduleTick() {
    if (!connected() || ticking || cfg.engaged) return;
    const act = activeSchedule();
    const cur = cfg.musicRun || null;
    const want = act ? runKey(act) : null;
    if ((cur ? cur.key : null) === want) return;
    if (want && failed.key === want && Date.now() - failed.at < 60000) return; // retry a failed start once a minute
    ticking = true;
    await serial(async () => {
      try {
        if (act) {
          const d = await playContext({ uri: act.uri, device: act.deviceName ? { id: act.deviceId, name: act.deviceName } : null, shuffle: act.shuffle === 'on' ? true : act.shuffle === 'off' ? false : null, volume: act.volume });
          cfg.musicRun = { key: want, id: act.id, name: act.name, at: Date.now() };
          lastAction = `Schedule “${act.name}” started ${act.playlistName || 'its playlist'} on ${d.name}`;
        } else {
          const prev = getSchedules().find((s) => s.id === cur.id);
          if (prev && prev.atEnd !== 'keep') { await stopMusic(); lastAction = `Schedule “${prev.name}” ended, so the music was faded out`; }
          else lastAction = prev ? `Schedule “${prev.name}” ended; the music was left playing` : lastAction;
          cfg.musicRun = null;
        }
        failed = { key: '', at: 0 };
        save();
      } catch (e) {
        failed = { key: want, at: Date.now() };
        lastError = `Music schedule “${act ? act.name : cur ? cur.name : ''}”: ${e.message}`;
        log.error('Spotify: ' + lastError);
      }
    });
    ticking = false;
  }
  setInterval(scheduleTick, 10000).unref();
  setTimeout(scheduleTick, 3000).unref();

  /** "Start now" on a schedule: play its playlist even outside its times. */
  async function runSchedule(s) {
    let err = null;
    await serial(async () => {
      try {
        const d = await playContext({ uri: s.uri, device: s.deviceName ? { id: s.deviceId, name: s.deviceName } : null, shuffle: s.shuffle === 'on' ? true : s.shuffle === 'off' ? false : null, volume: s.volume });
        lastAction = `Started ${s.playlistName || 'the playlist'} on ${d.name}`;
      } catch (e) { err = e; }
    });
    if (err) throw err.status ? err : Object.assign(err, { status: 502 });
    statusAt = 0;
  }

  return { authUrl, finishAuth, setHold, dropScreen, info, updateSettings, disconnect, control, refreshStatus, connected, devices, playlists, parseUri, describe, music, runSchedule, scheduleTick, _cfg: () => cfg };
}

module.exports = { createSpotify };
