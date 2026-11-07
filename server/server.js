'use strict';
/*
 * ENJOY Signage — a small, self-hosted digital signage server.
 * Zero dependencies: needs only Node.js 18+.
 *
 *   node server.js
 *
 * Environment variables (all optional):
 *   PORT            HTTP port (default 3000)
 *   DATA_DIR        where db.json and uploads live (default ./data)
 *   ADMIN_PASSWORD  password of the built-in "admin" account (recovery login); users are managed in the admin panel
 *   ADMIN_PASSWORD_FILE  …or read the password from this file instead (used by the Ubuntu installer)
 *   MAX_UPLOAD_MB   largest single upload in MB (default 4096)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { URL } = require('url');
const { createSpotify } = require('./spotify');
const { createFolders } = require('./folders');
const { createAccounts, MAX_TRIES, LOCK_MS } = require('./accounts');

const VERSION = '1.13.2';
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BRAND_DIR = path.join(DATA_DIR, 'branding');
const DEFAULT_WORDMARK = '/static/brand/wordmark.png'; // ENJOY Signage, shown on TVs unless another logo is uploaded
const LOGO_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }; // no SVG: it can carry scripts
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || readPasswordFile(process.env.ADMIN_PASSWORD_FILE);

/** ADMIN_PASSWORD_FILE: a plain-text file holding just the password (no quoting rules to worry about). */
function readPasswordFile(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (e) {
    // Fail closed: never start with an unprotected admin panel because the password file went missing.
    console.error(`! Could not read the admin password file ${file}: ${e.message}`);
    process.exit(1);
  }
}
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD_MB || '4096', 10) * 1024 * 1024;
const BOOT_ID = crypto.randomBytes(4).toString('hex');
const ONLINE_MS = 20000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const spotify = createSpotify({
  dataDir: DATA_DIR,
  getSchedules: () => db.musicSchedules || [],
  isActive: (s, now) => scheduleActive(s, now),
});

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const EMPTY = () => ({ media: [], playlists: [], screens: [], schedules: [], overrides: [], musicSchedules: [], settings: {}, playedOnce: {} });
let db = EMPTY();
try {
  if (fs.existsSync(DB_FILE)) {
    db = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'db.backup.json'));
  }
} catch (e) {
  const bad = DB_FILE + '.corrupt-' + Date.now();
  fs.copyFileSync(DB_FILE, bad);
  console.error(`! db.json could not be read (${e.message}). Saved a copy to ${bad} and started empty.`);
  db = EMPTY();
}

const accounts = createAccounts({ dataDir: DATA_DIR, builtinPassword: ADMIN_PASSWORD });

const folders = createFolders({
  defaultRoot: path.join(DATA_DIR, 'folders'),
  getRoot: () => (db.settings && db.settings.foldersDir) || '',
  onChange: () => syncFolders(),
});

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  announceChange();
}

/* Players keep a push connection open (/api/player/:id/events) and check in the moment anything changes,
   instead of waiting for their next 5-second check. Old TV browsers without it just keep checking. */
const listeners = new Set();
let changeTimer = null;
function announceChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { for (const r of listeners) r.write('data: change\n\n'); }, 40);
}
setInterval(() => { for (const r of listeners) r.write(': still here\n\n'); }, 25000).unref();

const screenName = (id) => (id === '__test__' ? 'Test' : (db.screens.find((x) => x.id === id) || {}).name || id);
const uid = () => crypto.randomBytes(5).toString('hex');
const byId = (list, id) => list.find((x) => x.id === id);

// Live, in-memory status for each screen (not persisted).
const status = {};

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Math.min(+m[1], 24) * 60 + +m[2] : null;
};

/**
 * Is a schedule active at `now`?
 *  - start < end  : normal window on the same day
 *  - start > end  : overnight window (e.g. 22:00 → 02:00), counted against the day it starts
 *  - start == end : all day
 * Days are 0=Sun … 6=Sat. Dates are inclusive YYYY-MM-DD.
 */
function scheduleActive(s, now = new Date()) {
  return !!scheduleOccurrence(s, now);
}

/** The day (YYYY-MM-DD) the currently running window of schedule s started on, or null if it isn't running. */
function scheduleOccurrence(s, now = new Date()) {
  if (!s.enabled) return null;
  const st = toMin(s.startTime);
  const en = toMin(s.endTime);
  if (st == null || en == null) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  let startDay = new Date(now);
  if (st < en) {
    if (mins < st || mins >= en) return null;
  } else if (st > en) {
    if (mins >= st) {
      /* today */
    } else if (mins < en) {
      startDay.setDate(startDay.getDate() - 1);
    } else return null;
  }
  const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(startDay.getDay())) return null;
  const d = ymd(startDay);
  if (s.startDate && d < s.startDate) return null;
  if (s.endDate && d > s.endDate) return null;
  return d;
}

const targets = (rule, screenId) => !!rule.allScreens || (rule.screenIds || []).includes(screenId);
const overrideActive = (o, now = Date.now()) => (!o.startAt || o.startAt <= now) && (!o.until || o.until > now);
const overrideExpired = (o, now = Date.now()) => !!o.until && o.until <= now;

/**
 * Work out what a screen should be showing right now. Takeover > schedule > default.
 *
 * "Play once" playlists: when a takeover or a schedule's window starts one, the screen plays it through
 * once, reports that (playedOnce), and from then on it's skipped for that takeover / that day's window,
 * so the screen drops to whatever comes next. onceKey identifies that one showing.
 */
function resolveScreen(screen, now = new Date()) {
  const done = (db.playedOnce && db.playedOnce[screen.id]) || {};
  const played = []; // names of play-once playlists already finished right now
  const once = (pl, key) => (pl.playOnce ? key : null);

  const ovs = db.overrides
    .filter((o) => overrideActive(o, now.getTime()) && targets(o, screen.id) && byId(db.playlists, o.playlistId))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const ov of ovs) {
    const pl = byId(db.playlists, ov.playlistId);
    const key = once(pl, `takeover:${ov.id}`);
    if (key && done[key]) { played.push(pl.name); continue; }
    return { source: 'takeover', label: 'Takeover', refId: ov.id, until: ov.until || null, playlist: pl, onceKey: key };
  }
  const schs = db.schedules
    .filter((s) => targets(s, screen.id) && byId(db.playlists, s.playlistId) && scheduleActive(s, now))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || toMin(b.startTime) - toMin(a.startTime));
  for (const sch of schs) {
    const pl = byId(db.playlists, sch.playlistId);
    // Includes the start time, so moving a schedule to a later time today lets it play once again.
    const key = once(pl, `schedule:${sch.id}:${scheduleOccurrence(sch, now)}:${sch.startTime}`);
    if (key && done[key]) { played.push(pl.name); continue; }
    return { source: 'schedule', label: sch.name || 'Schedule', refId: sch.id, playlist: pl, onceKey: key };
  }
  const note = played.length ? `“${played[0]}” has played once` : '';
  const pl = byId(db.playlists, screen.defaultPlaylistId);
  if (pl) return { source: 'default', label: 'Default', playlist: pl, note };
  return { source: 'none', label: 'Nothing assigned', playlist: null, note };
}

/* ------------------------------------------------------------------ */
/* Synced playback                                                     */
/* ------------------------------------------------------------------ */
//
// Every screen works out where it should be from the same timeline: a start moment for what it's showing
// (the "showing") plus the length of each item. Screens showing the same thing from the same moment are
// therefore in step, and a screen that joins late jumps straight to the right place. Screens in a room
// share one beat: at each step each shows its own next item, and the step lasts as long as the longest.

const SYNC_LOOKAHEAD = 6000; // players hear about a scheduled change this long before it, so all switch on the moment
const TAKEOVER_LEAD = 3000; // a new takeover starts this long after it's created, for the same reason
const roomOf = (s) => String((s && s.room) || '').trim().toLowerCase();
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** A video's length in seconds, if it has been measured for this version of the file. */
function videoLength(m) {
  if (!(m.length > 0)) return null;
  if (m.lengthFor && m.lengthFor !== mediaUrl(m)) return null; // the file was replaced since
  return m.length;
}

/** When the showing r began (ms since 1970). */
function showingStart(r, now) {
  if (r.source === 'takeover') { const o = byId(db.overrides, r.refId); return o ? o.startAt || o.createdAt : 0; }
  if (r.source === 'schedule') {
    const sc = byId(db.schedules, r.refId);
    const day = sc && scheduleOccurrence(sc, now);
    if (!day) return 0;
    const [y, mo, d] = day.split('-').map(Number);
    const [hh, mm] = sc.startTime.split(':').map(Number);
    return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
  }
  return 0; // default playlists share one fixed reference, so every screen showing one agrees
}

/** Seconds each item lasts, or null if one isn't known (a video nobody has measured yet). */
function itemLengths(items) {
  const out = items.map((it) => (it.duration > 0 ? it.duration : it.type === 'video' ? it.length || null : null));
  return out.every((x) => x > 0) ? out : null;
}

function steps(rows) {
  let t = 0;
  const list = rows.map((r) => { const st = { key: r.key, at: +t.toFixed(3), len: +r.len.toFixed(3), own: +Math.min(r.own, r.len).toFixed(3) }; t += r.len; return st; });
  return { steps: list, cycle: +t.toFixed(3) };
}

/** The timeline for screen (showing r with items), or why there isn't one: 'off' (sync turned off) or 'lengths'. */
function timelineFor(screen, r, items, now) {
  if (!r.playlist || !items.length) return { timeline: null, why: '' };
  if (r.playlist.sync === false) return { timeline: null, why: 'off' };
  const own = itemLengths(items);
  if (!own) return { timeline: null, why: 'lengths' };
  const solo = () => ({ anchor: showingStart(r, now), loop: !r.onceKey, ...steps(items.map((it, i) => ({ key: it.key, own: own[i], len: own[i] }))) });
  if (r.onceKey || !roomOf(screen)) return { timeline: solo(), why: '' };
  const members = [];
  for (const sc of db.screens) {
    if (roomOf(sc) !== roomOf(screen)) continue;
    const rs = sc.id === screen.id ? r : resolveScreen(sc, now);
    if (!rs.playlist || rs.playlist.sync === false || rs.onceKey) continue; // play-once showings keep their own time
    const its = sc.id === screen.id ? items : buildItems(rs.playlist, sc);
    const lens = its.length ? itemLengths(its) : null;
    if (lens) members.push({ id: sc.id, lens, start: showingStart(rs, now) });
  }
  if (members.length < 2 || !members.some((m) => m.id === screen.id)) return { timeline: solo(), why: '' };
  // Enough steps for every screen's playlist to come round evenly (capped, for very mismatched playlists).
  let n = 1;
  for (const m of members) { n = (n * m.lens.length) / gcd(n, m.lens.length); if (n > 240) { n = Math.max(...members.map((x) => x.lens.length)); break; } }
  const rows = [];
  for (let k = 0; k < n; k++) {
    const i = k % items.length;
    rows.push({ key: items[i].key, own: own[i], len: Math.max(...members.map((m) => m.lens[k % m.lens.length])) });
  }
  // The room's beat restarts whenever something new starts on any of its screens.
  return { timeline: { anchor: Math.max(...members.map((m) => m.start)), loop: true, room: screen.room.trim(), ...steps(rows) }, why: '' };
}

/** Everything a player needs to show what screen should be showing at time `at`. */
function playerPayload(screen, at = Date.now()) {
  const now = new Date(at);
  const r = resolveScreen(screen, now);
  const items = r.playlist ? buildItems(r.playlist, screen) : [];
  const { timeline, why } = timelineFor(screen, r, items, now);
  const payload = {
    screen: { id: screen.id, name: screen.name, rotation: screen.rotation || 0 },
    source: r.source,
    label: r.label,
    playlistId: r.playlist ? r.playlist.id : null,
    transition: r.playlist ? r.playlist.transition : 'fade',
    playOnce: !!r.onceKey,
    onceKey: r.onceKey || null,
    items,
    timeline,
    logo: logoInfo() ? logoInfo().url : DEFAULT_WORDMARK,
  };
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return { payload, hash, r, why };
}

/** If what this screen shows changes within the next few seconds, the moment and what it changes to. */
function upcomingFor(screen, nowMs, currentHash) {
  const times = new Set([Math.ceil((nowMs + 1) / 60000) * 60000]); // schedules change on the minute
  for (const o of db.overrides) for (const t of [o.startAt, o.until]) if (t > nowMs) times.add(t);
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t > nowMs + SYNC_LOOKAHEAD) break;
    const next = playerPayload(screen, t + 1);
    if (next.hash !== currentHash) return { at: t, hash: next.hash, ...next.payload };
  }
  return null;
}

/** A screen finished a play-once playlist: remember it (kept in db.json, so a restart doesn't replay it). */
function markPlayedOnce(screenId, key) {
  const all = (db.playedOnce = db.playedOnce || {});
  (all[screenId] = all[screenId] || {})[key] = Date.now();
  // Tidy up: forget screens that are gone, takeovers that have ended, and schedule showings over 3 days old.
  const live = new Set(db.overrides.map((o) => `takeover:${o.id}`));
  const cutoff = Date.now() - 3 * 86400000;
  for (const [sid, keys] of Object.entries(all)) {
    if (!byId(db.screens, sid)) { delete all[sid]; continue; }
    for (const [k, t] of Object.entries(keys)) if (k.startsWith('takeover:') ? !live.has(k) : t < cutoff) delete keys[k];
  }
  save();
}

const DEFAULT_DURATION = { image: 10, video: 0, web: 30, text: 10, countdown: 30 };

function youtubeEmbed(url, muted) {
  const m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url || '');
  if (!m) return null;
  const id = m[1];
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=${muted ? 1 : 0}&controls=0&loop=1&playlist=${id}&rel=0&modestbranding=1&playsinline=1`;
}

const mediaUrl = (m) => {
  if (m && m.folderName) return `/folders/${encodeURIComponent(m.folderName)}/${encodeURIComponent(m.folderFile)}?v=${m.mtime}`;
  return m && m.file ? `/uploads/${encodeURIComponent(m.file)}` : null;
};

/* ------------------------------------------------------------------ */
/* Drop folders → ordinary media and playlist items                    */
/* ------------------------------------------------------------------ */

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Remove a media item and every use of it (playlists, slide backgrounds). */
function removeMedia(m) {
  db.media = db.media.filter((x) => x.id !== m.id);
  for (const pl of db.playlists) pl.items = pl.items.filter((it) => it.mediaId !== m.id);
  for (const x of db.media) if (x.bgImageId === m.id) x.bgImageId = '';
}

/**
 * Keep media and playlists in step with the drop folders. Runs whenever a folder changes and
 * whenever a playlist is saved.
 *  - A finished file in a folder that a playlist is linked to becomes a normal media item.
 *  - Each linked playlist gets an item for every folder file it hasn't been given before
 *    (playlist.folder.known), at the end or the start. From then on it's a normal item: it can be
 *    moved, timed, removed. Removing it doesn't bring it back; deleting the file does remove it.
 *  - A replaced file (same name) keeps its media item, so its position and settings stay.
 *  - A deleted file removes its media item everywhere. A missing *folder* (or an unreadable
 *    location) removes nothing: that's more likely a sync hiccup than an intent to delete.
 */
function syncFolders() {
  if (!folders.ok()) return;
  let changed = false;
  for (const m of [...db.media]) {
    if (!m.folderName) continue;
    const f = folders.get(m.folderName);
    if (!f) { if (!m.missing) { m.missing = true; changed = true; } continue; }
    if (!f.present.has(m.folderFile)) { removeMedia(m); changed = true; continue; }
    if (m.missing) { delete m.missing; changed = true; }
    const r = f.ready.find((x) => x.file === m.folderFile);
    if (r && (r.mtime !== m.mtime || r.size !== m.size)) { Object.assign(m, { mtime: r.mtime, size: r.size }); changed = true; }
  }
  const linked = new Set(db.playlists.filter((p) => p.folder && p.folder.name).map((p) => p.folder.name));
  for (const name of linked) {
    const f = folders.get(name);
    if (!f) continue;
    for (const r of f.ready) {
      if (db.media.some((m) => m.folderName === name && m.folderFile === r.file)) continue;
      db.media.push({ id: uid(), type: r.type, name: r.file.replace(/\.[^.]+$/, '') || r.file, folderName: name, folderFile: r.file, size: r.size, mtime: r.mtime, createdAt: Date.now() });
      changed = true;
    }
  }
  for (const p of db.playlists) {
    if (!p.folder || !p.folder.name) continue;
    const known = new Set(p.folder.known || []);
    const fresh = db.media.filter((m) => m.folderName === p.folder.name && !known.has(m.id)).sort((a, b) => natural.compare(a.folderFile, b.folderFile));
    const live = new Set(db.media.map((m) => m.id));
    const prunedKnown = [...known].filter((id) => live.has(id));
    if (!fresh.length && prunedKnown.length === known.size) continue;
    const now = Date.now();
    const add = fresh.map((m) => ({ id: uid(), mediaId: m.id, duration: m.type === 'video' ? null : p.folder.imageSeconds || 10, fit: p.folder.fit || 'contain', music: '', addedAt: now }));
    p.items = p.folder.position === 'start' ? add.concat(p.items) : p.items.concat(add);
    p.folder.known = prunedKnown.concat(fresh.map((m) => m.id));
    changed = true;
  }
  if (changed) save();
}

/** Should background music (Spotify) pause while this item is on screen? Only screens with sound on count. */
function wantsMusicPause(playlist, itemMusic, hasSound, muted) {
  const plMusic = playlist.music || 'keep';
  const wants = itemMusic === 'pause' || (itemMusic !== 'keep' && (plMusic === 'all' || (plMusic === 'videos' && hasSound)));
  return wants && !muted;
}

/** Turn a stored playlist into the flat list of items a player needs. */
function buildItems(playlist, screen) {
  const muted = !(screen && screen.audio);
  const own = (playlist.items || [])
    .map((it) => {
      const m = byId(db.media, it.mediaId);
      if (!m) return null;
      if (m.folderName && !folders.readyFile(m.folderName, m.folderFile)) return null; // still copying, or folder missing
      const duration = it.duration != null && it.duration !== '' ? Number(it.duration) : DEFAULT_DURATION[m.type] ?? 10;
      const out = { key: it.id, mediaId: m.id, type: m.type, name: m.name, duration, fit: it.fit || 'contain', muted };
      if (wantsMusicPause(playlist, it.music, m.type === 'video' || (m.type === 'web' && !!youtubeEmbed(m.url)), muted)) out.pauseMusic = true;
      if (m.type === 'image' || m.type === 'video') out.url = mediaUrl(m);
      if (m.type === 'video' && videoLength(m)) out.length = videoLength(m);
      if (m.type === 'web') out.url = youtubeEmbed(m.url, muted) || m.url;
      if (m.type === 'text' || m.type === 'countdown') {
        Object.assign(out, { title: m.title || '', body: m.body || '', bg: m.bg || '#1b2a4a', fg: m.fg || '#ffffff', align: m.align || 'center' });
        const bgImg = byId(db.media, m.bgImageId);
        if (bgImg && bgImg.type === 'image') out.bgImage = mediaUrl(bgImg);
      }
      if (m.type === 'countdown') Object.assign(out, { target: m.target || '10:00', after: m.after || '' });
      return out;
    })
    .filter(Boolean);
  return own;
}

// Tidy expired takeovers once a minute.
setInterval(() => {
  const before = db.overrides.length;
  db.overrides = db.overrides.filter((o) => !overrideExpired(o));
  if (db.overrides.length !== before) save();
}, 60000).unref();

/* ------------------------------------------------------------------ */
/* Input sanitising                                                    */
/* ------------------------------------------------------------------ */

const str = (v, max = 500) => (v == null ? '' : String(v).slice(0, max));
const color = (v, d) => (/^#[0-9a-f]{3,8}$/i.test(v || '') ? v : d);
const time = (v, d) => (/^\d{1,2}:\d{2}$/.test(v || '') ? v : d);
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
const idList = (v, list) => (Array.isArray(v) ? v.filter((id) => byId(list, id)) : []);

function cleanMedia(b, existing) {
  const type = existing ? existing.type : b.type;
  if (!existing && !['web', 'text', 'countdown'].includes(type)) throw httpError(400, 'Unknown media type');
  const o = { name: str(b.name, 200) || (existing && existing.name) || 'Untitled' };
  if (type === 'web') {
    o.url = str(b.url, 2000).trim();
    if (!/^https?:\/\//i.test(o.url)) throw httpError(400, 'Web address must start with http:// or https://');
  }
  if (type === 'text' || type === 'countdown') {
    o.title = str(b.title, 300);
    o.body = str(b.body, 3000);
    o.bg = color(b.bg, '#1b2a4a');
    o.fg = color(b.fg, '#ffffff');
    o.align = ['left', 'center'].includes(b.align) ? b.align : 'center';
    o.bgImageId = byId(db.media, b.bgImageId) ? b.bgImageId : '';
  }
  if (type === 'countdown') {
    o.target = time(b.target, '10:00');
    o.after = str(b.after, 300);
  }
  if (type === 'video' && existing && b.length !== undefined && +b.length > 0.2 && +b.length < 86400) {
    o.length = Math.round(+b.length * 1000) / 1000;
    o.lengthFor = mediaUrl(existing);
  }
  if (!existing) o.type = type;
  return o;
}

function cleanPlaylist(b) {
  const items = (Array.isArray(b.items) ? b.items : [])
    .filter((it) => it && byId(db.media, it.mediaId))
    .map((it) => {
      const o = {
        id: /^[a-z0-9]{4,20}$/.test(it.id || '') ? it.id : uid(),
        mediaId: it.mediaId,
        duration: it.duration === '' || it.duration == null || isNaN(+it.duration) ? null : Math.max(0, Math.min(86400, +it.duration)),
        fit: it.fit === 'cover' ? 'cover' : 'contain',
        music: ['pause', 'keep'].includes(it.music) ? it.music : '',
      };
      if (Number.isFinite(it.addedAt)) o.addedAt = it.addedAt; // set when a drop folder added it
      return o;
    });
  return {
    name: str(b.name, 200) || 'Untitled playlist',
    transition: b.transition === 'none' ? 'none' : 'fade',
    playOnce: !!b.playOnce, // when a schedule or takeover starts it: play through once, then step aside
    sync: b.sync !== false, // screens showing it stay in step (see timelineFor)
    music: ['videos', 'all'].includes(b.music) ? b.music : 'keep',
    folder: cleanFolderFeed(b.folder, { items }),
    items,
  };
}

/**
 * A playlist's drop-folder link. `known` (folder files this playlist has already been given) is
 * worked out here on the server, never taken from the browser: it starts as the folder's files the
 * playlist already contains (so re-linking or duplicating doesn't add them twice).
 */
function cleanFolderFeed(f, { items = [], prev = null } = {}) {
  if (!f || typeof f !== 'object') return null;
  const name = folders.cleanFolderName(f.name);
  if (!name) return null;
  const known = new Set(prev && prev.name === name ? prev.known || [] : []);
  for (const it of items) { const m = byId(db.media, it.mediaId); if (m && m.folderName === name) known.add(m.id); }
  return {
    name,
    position: f.position === 'start' ? 'start' : 'end',
    known: [...known].filter((id) => byId(db.media, id)),
    imageSeconds: Math.max(1, Math.min(3600, parseInt(f.imageSeconds, 10) || 10)),
    fit: f.fit === 'cover' ? 'cover' : 'contain',
  };
}

function cleanMusicSchedule(b) {
  const t = cleanSchedule(Object.assign({}, b, { playlistId: '', allScreens: true, screenIds: [] }));
  const uri = spotify.parseUri(b.uri);
  const vol = b.volume === '' || b.volume == null || isNaN(+b.volume) ? null : Math.max(0, Math.min(100, Math.round(+b.volume)));
  return {
    name: str(b.name, 200) || 'Music',
    uri,
    playlistName: str(b.playlistName, 200),
    deviceId: str(b.deviceId, 100),
    deviceName: str(b.deviceName, 200),
    days: t.days, startTime: t.startTime, endTime: t.endTime, startDate: t.startDate, endDate: t.endDate,
    priority: t.priority,
    enabled: uri ? b.enabled !== false : false,
    volume: vol,
    shuffle: ['on', 'off'].includes(b.shuffle) ? b.shuffle : '',
    atEnd: b.atEnd === 'keep' ? 'keep' : 'pause',
  };
}

function cleanScreen(b) {
  return {
    name: str(b.name, 100) || 'Screen',
    location: str(b.location, 200),
    defaultPlaylistId: byId(db.playlists, b.defaultPlaylistId) ? b.defaultPlaylistId : '',
    rotation: [0, 90, 180, 270].includes(+b.rotation) ? +b.rotation : 0,
    audio: !!b.audio,
    room: str(b.room, 60).trim(), // screens in the same room change items together
  };
}

function cleanSchedule(b) {
  return {
    name: str(b.name, 200) || 'Schedule',
    playlistId: byId(db.playlists, b.playlistId) ? b.playlistId : '',
    allScreens: !!b.allScreens,
    screenIds: idList(b.screenIds, db.screens),
    days: Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6],
    startTime: time(b.startTime, '09:00'),
    endTime: time(b.endTime, '12:00'),
    startDate: date(b.startDate),
    endDate: date(b.endDate),
    priority: Math.max(-1000, Math.min(1000, parseInt(b.priority, 10) || 0)),
    enabled: b.enabled !== false,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function httpError(code, msg) {
  const e = new Error(msg);
  e.status = code;
  return e;
}

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const data = isBuf ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(data);
}

function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska',
};
const EXT_FOR_MIME = Object.fromEntries(Object.entries(MIME).filter(([, m]) => /^(image|video)\//.test(m)).reverse().map(([e, m]) => [m, e]));

/** Serve a file with Range support (needed for video seeking / iOS / smart TVs). */
// Headers for files people uploaded: never run them as a page (defuses scripts hidden in images).
const USER_FILE_HEADERS = { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' };

function serveFile(req, res, file, cacheSeconds = 0, extraHeaders = null) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-cache',
      'X-Frame-Options': 'SAMEORIGIN',
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
      res.writeHead(304, headers);
      return res.end();
    }
    // "Only send part of it if it hasn't changed": if it has changed, send the whole file instead.
    const ifRange = req.headers['if-range'];
    const rangeOk = !ifRange || ifRange === headers['Last-Modified'];
    const range = rangeOk && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (start < 0) start = 0;
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      // pipeline (not pipe) closes the file if the TV abandons the download part-way, which they often do.
      return pipeline(fs.createReadStream(file, { start, end }), res, () => {});
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(file), res, () => {});
  });
}

/* ---- Sessions (cookie) ---- */
const COOKIE = 'es_session';
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
const sessionCookie = (req, token, maxAgeSec) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
/** The visitor's address. Behind a tunnel on this computer (Cloudflare, Tailscale), use the address it passes on. */
function clientIp(req) {
  const direct = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (direct === '127.0.0.1' || direct === '::1') {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return direct;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  const rank = (ip) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : /^(169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const routes = [];
/**
 * Register a route. Access: { open: true } = anyone (TV players), { role: 'user' } = any signed-in
 * account (editors too; the handler checks which playlists/media), default = administrators only.
 */
const route = (method, pattern, handler, { open = false, role = 'admin' } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler, open, role });
};
const isAdmin = (u) => !!u && u.role === 'admin';
const canEditPlaylist = (u, id) => isAdmin(u) || (!!u && (u.playlists || []).includes(id));
const canEditMedia = (u, m) => isAdmin(u) || (!!u && !!m && !m.folderName && m.createdBy === u.id);

/* ---- Player (open: no password) ---- */

route('GET', '/player', (req, res) => serveFile(req, res, path.join(PUBLIC_DIR, 'player.html')), { open: true });
route('GET', '/player/:id', (req, res) => serveFile(req, res, path.join(PUBLIC_DIR, 'player.html')), { open: true });

route('GET', '/api/player-list', (req, res) => {
  send(res, 200, db.screens.map((s) => ({ id: s.id, name: s.name, location: s.location })), { 'X-Logo': logoInfo() ? logoInfo().url : DEFAULT_WORDMARK });
}, { open: true });

route('GET', '/api/player/:id/state', (req, res, p, url) => {
  const screen = byId(db.screens, p.id);
  if (!screen) return send(res, 404, { error: 'Unknown screen' });
  const st = (status[screen.id] = status[screen.id] || {});
  st.lastSeen = Date.now();
  st.ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (url.searchParams.has('item')) st.item = str(url.searchParams.get('item'), 200);
  if (url.searchParams.has('res')) st.res = str(url.searchParams.get('res'), 20);
  if (url.searchParams.has('err')) st.error = str(url.searchParams.get('err'), 300);
  if (url.searchParams.has('music')) spotify.setHold(screen.id, url.searchParams.get('music') === '1', st.item);
  // The player finished a play-once playlist. Only counts for what this screen is actually meant to be showing.
  if (url.searchParams.has('played')) {
    const key = url.searchParams.get('played');
    if (key && resolveScreen(screen).onceKey === key) markPlayedOnce(screen.id, key);
  }

  // A player measured a video's length (for videos added before lengths were recorded, and drop-folder videos).
  if (url.searchParams.has('len')) {
    try {
      const [mid, secs, src] = JSON.parse(url.searchParams.get('len'));
      const m = byId(db.media, mid);
      if (m && m.type === 'video' && !videoLength(m) && src === mediaUrl(m) && +secs > 0.2 && +secs < 86400) {
        m.length = Math.round(+secs * 1000) / 1000;
        m.lengthFor = src;
        save();
      }
    } catch {}
  }
  // How far the player is from its timeline, and how good its clock reading is (shown on the Screens page).
  if (url.searchParams.has('sync')) {
    const off = Math.round(+url.searchParams.get('sync'));
    st.sync = { off: Number.isFinite(off) ? Math.max(-99999, Math.min(99999, off)) : null, rtt: Math.round(+url.searchParams.get('rtt')) || null, at: Date.now() };
  } else st.sync = null;

  const nowMs = Date.now();
  const { payload, hash } = playerPayload(screen, nowMs);
  const upcoming = upcomingFor(screen, nowMs, hash);
  send(res, 200, Object.assign(payload, { hash, upcoming, boot: BOOT_ID, serverNow: Date.now(), identify: (st.identifyUntil || 0) > Date.now() }));
}, { open: true });

// Precise time, for players to line their clocks up with the server's (several quick samples each).
route('GET', '/api/time', (req, res) => send(res, 200, { now: Date.now() }), { open: true });

// Push channel: players are told the moment anything changes.
route('GET', '/api/player/:id/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  listeners.add(res);
  const done = () => listeners.delete(res);
  req.on('close', done);
  res.on('error', done);
}, { open: true });

// Instant signal from a player: an item that should silence the background music has started / finished.
route('POST', '/api/player/:id/music', (req, res, p, url) => {
  const screen = byId(db.screens, p.id);
  if (!screen) return send(res, 404, { error: 'Unknown screen' });
  spotify.setHold(screen.id, url.searchParams.get('hold') === '1', str(url.searchParams.get('item'), 200));
  send(res, 200, { ok: true });
}, { open: true });

/* Spotify sign-in lands here. It must be opened on the server computer itself (Spotify only allows
   http://127.0.0.1 redirect addresses without HTTPS). From another computer, paste the address instead. */
route('GET', '/spotify/callback', async (req, res, p, url) => {
  const page = (ok, msg) => send(res, ok ? 200 : 400, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify</title>
<body style="font-family:system-ui,sans-serif;background:#f4f6fa;color:#1d2433;display:grid;place-items:center;min-height:90vh"><div style="background:#fff;padding:32px 36px;border-radius:14px;max-width:460px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
<h2 style="margin-top:0">${ok ? '✅ Spotify connected' : '⚠ Spotify was not connected'}</h2><p>${msg}</p><p><a href="/#setup">Back to the admin panel</a></p></div>${ok ? '<script>setTimeout(()=>location.replace("/#setup"),1500)</script>' : ''}`, { 'Content-Type': 'text/html; charset=utf-8' });
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (url.searchParams.get('error')) return page(false, 'Spotify said: ' + esc(url.searchParams.get('error')));
  try {
    await spotify.finishAuth(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
    page(true, 'Background music can now pause for videos.');
  } catch (e) {
    page(false, esc(e.message));
  }
}, { open: true });

// Files from drop folders. Only files the folder scanner has listed can be served (see folders.js).
route('GET', '/folders/:folder/:file', (req, res, p) => {
  const file = folders.resolve(p.folder, p.file);
  if (!file) return send(res, 404, 'Not found');
  serveFile(req, res, file, 7 * 86400, USER_FILE_HEADERS); // URLs carry ?v=<modified time>, so a replaced file gets a new URL
}, { open: true });

route('GET', '/uploads/:file', (req, res, p) => {
  const name = path.basename(decodeURIComponent(p.file));
  serveFile(req, res, path.join(UPLOAD_DIR, name), 7 * 86400, USER_FILE_HEADERS);
}, { open: true });

/* ---- Admin ---- */

// The admin panel lives at /, the sign-in page at /login; each redirects to the other as needed.
// They're separate addresses and never cached, so a browser can't show the wrong one (that caused a
// reload loop when both pages had the same file date).
function sendPage(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) return send(res, 500, 'Missing ' + file);
    send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  });
}
const redirect = (res, to) => send(res, 302, '', { Location: to, 'Cache-Control': 'no-store' });
route('GET', '/', (req, res) => (req.user ? sendPage(res, 'admin.html') : redirect(res, '/login')), { open: true });
route('GET', '/login', (req, res) => (req.user ? redirect(res, '/') : sendPage(res, 'login.html')), { open: true });

/* ---- Accounts ---- */

const needHeader = (req) => { if (req.headers['x-signage'] !== '1') throw httpError(403, 'Blocked: reload the page and try again.'); };
route('GET', '/api/auth/status', (req, res) => {
  send(res, 200, { needsSetup: accounts.needsSetup(), user: accounts.publicUser(req.user), maxTries: MAX_TRIES, lockSeconds: LOCK_MS / 1000 });
}, { open: true });
route('POST', '/api/login', async (req, res) => {
  needHeader(req);
  const b = await readJson(req, 10000);
  try {
    const { user, token } = await accounts.login(b.username, b.password, clientIp(req));
    send(res, 200, { user: accounts.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, 30 * 86400) });
  } catch (e) {
    if (e.status === 401 || e.status === 429) console.log(`  Sign-in failed for "${String(b.username || '').slice(0, 40)}" from ${clientIp(req)}${e.status === 429 ? ' (locked for a moment)' : ''}`);
    throw e.status === 429 ? Object.assign(httpError(429, e.message), { retryAfter: e.retryAfter }) : e;
  }
}, { open: true });
route('POST', '/api/setup', async (req, res) => {
  needHeader(req);
  const b = await readJson(req, 10000);
  const { user, token } = await accounts.setup(b, clientIp(req));
  console.log(`  Administrator account "${user.username}" created.`);
  send(res, 200, { user: accounts.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, 30 * 86400) });
}, { open: true });
route('POST', '/api/logout', (req, res) => {
  accounts.endSession(parseCookies(req)[COOKIE]);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
}, { role: 'user' });
route('GET', '/api/me', (req, res) => send(res, 200, accounts.publicUser(req.user)), { role: 'user' });
route('POST', '/api/me/password', async (req, res) => {
  const b = await readJson(req, 10000);
  await accounts.changeOwnPassword(req.user, b.current, b.password, parseCookies(req)[COOKIE]);
  send(res, 200, { ok: true });
}, { role: 'user' });

const cleanUserBody = (b) => Object.assign({}, b, Array.isArray(b.playlists) ? { playlists: b.playlists.filter((id) => byId(db.playlists, id)) } : {});
route('GET', '/api/users', (req, res) => send(res, 200, accounts.list()));
route('POST', '/api/users', async (req, res) => {
  const u = await accounts.createUser(cleanUserBody(await readJson(req, 100000)));
  send(res, 200, accounts.publicUser(u));
});
route('PUT', '/api/users/:id', async (req, res, p) => {
  const u = await accounts.updateUser(p.id, cleanUserBody(await readJson(req, 100000)), req.user);
  send(res, 200, accounts.publicUser(u));
});
route('DELETE', '/api/users/:id', (req, res, p) => {
  accounts.removeUser(p.id, req.user);
  send(res, 200, { ok: true });
});

route('GET', '/api/preview/:id/state', (req, res, p) => {
  const pl = byId(db.playlists, p.id);
  if (!pl || !canEditPlaylist(req.user, pl.id)) return send(res, 404, { error: 'Unknown playlist' });
  const payload = { screen: { id: 'preview', name: 'Preview: ' + pl.name, rotation: 0 }, source: 'preview', label: 'Preview', playlistId: pl.id, transition: pl.transition, items: buildItems(pl, { audio: true }) };
  const hash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  send(res, 200, Object.assign(payload, { hash, boot: BOOT_ID, serverNow: Date.now(), identify: false }));
}, { role: 'user' });

route('GET', '/api/state', (req, res) => {
  if (!isAdmin(req.user)) return sendEditorState(req, res);
  const now = new Date();
  const resolved = {};
  for (const s of db.screens) {
    const { r, payload, why } = playerPayload(s, now.getTime());
    const sync = payload.timeline ? (payload.timeline.room ? 'room' : 'on') : why || 'none'; // on | room | off | lengths | none
    resolved[s.id] = { source: r.source, label: r.label, refId: r.refId || null, until: r.until || null, playlistId: r.playlist ? r.playlist.id : null, playlistName: r.playlist ? r.playlist.name : null, playOnce: !!r.onceKey, note: r.note || '', sync, room: s.room || '' };
  }
  const st = {};
  for (const [id, v] of Object.entries(status)) st[id] = Object.assign({}, v, { online: Date.now() - (v.lastSeen || 0) < ONLINE_MS });
  send(res, 200, {
    db,
    status: st,
    resolved,
    activeSchedules: db.schedules.filter((s) => scheduleActive(s, now)).map((s) => s.id),
    activeMusicSchedules: (db.musicSchedules || []).filter((s) => s.enabled && scheduleActive(s, now)).map((s) => s.id),
    now: now.getTime(),
    tzOffset: now.getTimezoneOffset(),
    spotify: spotify.info(screenName),
    folders: folders.info(),
    logo: logoInfo(),
    me: accounts.publicUser(req.user),
    users: accounts.list(),
    info: { ips: lanAddresses(), port: PORT, version: VERSION, boot: BOOT_ID, hostname: os.hostname(), builtinAdmin: !!ADMIN_PASSWORD, spotifyRedirect: spotifyRedirect() },
  });
}, { role: 'user' });

/* ---- Spotify (admin) ---- */

const spotifyRedirect = () => `http://127.0.0.1:${PORT}/spotify/callback`;
route('POST', '/api/spotify/settings', async (req, res) => {
  spotify.updateSettings(await readJson(req));
  send(res, 200, spotify.info(screenName));
});
route('POST', '/api/spotify/login', (req, res) => send(res, 200, { url: spotify.authUrl(spotifyRedirect()), redirectUri: spotifyRedirect() }));
route('POST', '/api/spotify/paste', async (req, res) => {
  const b = await readJson(req);
  let u;
  try { u = new URL(String(b.url || '').trim()); } catch { throw httpError(400, 'Paste the whole address from the browser bar (it starts with http://127.0.0.1)'); }
  if (u.searchParams.get('error')) throw httpError(400, 'Spotify said: ' + u.searchParams.get('error'));
  if (!u.searchParams.get('code')) throw httpError(400, 'That address has no sign-in code in it');
  try { await spotify.finishAuth(u.searchParams.get('code'), u.searchParams.get('state')); } catch (e) { throw httpError(e.status || 502, e.message); }
  send(res, 200, spotify.info(screenName));
});
route('POST', '/api/spotify/disconnect', (req, res) => { spotify.disconnect(); send(res, 200, { ok: true }); });
route('POST', '/api/spotify/control', async (req, res) => {
  const b = await readJson(req);
  await spotify.control(String(b.action || ''));
  send(res, 200, spotify.info(screenName));
});

/* ---- Spotify music control ---- */

const spErr = (e) => httpError(e.status && e.status < 600 ? e.status : 502, e.message);
route('GET', '/api/spotify/devices', async (req, res) => {
  try { send(res, 200, { devices: await spotify.devices() }); } catch (e) { throw spErr(e); }
});
route('GET', '/api/spotify/playlists', async (req, res, p, url) => {
  try { send(res, 200, { playlists: await spotify.playlists(url.searchParams.has('fresh')) }); } catch (e) { throw spErr(e); }
});
route('POST', '/api/spotify/describe', async (req, res) => {
  const b = await readJson(req);
  const uri = spotify.parseUri(b.uri);
  if (!uri) throw httpError(400, 'That isn’t a Spotify playlist, album, artist or podcast link');
  send(res, 200, { uri, name: await spotify.describe(uri) });
});
route('POST', '/api/spotify/music', async (req, res) => {
  const b = await readJson(req);
  try { await spotify.music(String(b.action || ''), b); } catch (e) { throw spErr(e); }
  send(res, 200, spotify.info(screenName));
});
route('POST', '/api/musicSchedules/:id/run', async (req, res, p) => {
  const s = byId(db.musicSchedules, p.id);
  if (!s) throw httpError(404, 'Not found');
  try { await spotify.runSchedule(s); } catch (e) { throw spErr(e); }
  send(res, 200, spotify.info(screenName));
});

/* ---- Branding (logo) ---- */

const logoInfo = () => {
  const l = db.settings && db.settings.logo;
  return l && l.file ? { url: `/brand/logo?v=${l.v}`, file: l.file } : null;
};

// The logo is public: players and the browser tab icon use it.
route('GET', '/brand/logo', (req, res) => {
  const l = logoInfo();
  if (!l) return send(res, 404, 'No logo');
  serveFile(req, res, path.join(BRAND_DIR, path.basename(l.file)), 7 * 86400, USER_FILE_HEADERS);
}, { open: true });

route('POST', '/api/branding/logo', (req, res) => {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = LOGO_TYPES[mime];
  if (!ext) return send(res, 415, { error: 'Use a PNG, JPG or WebP image for the logo (PNG with a transparent background looks best)' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 5 * 1048576) { send(res, 413, { error: 'The logo must be under 5 MB' }); req.destroy(); } else chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    const buf = Buffer.concat(chunks);
    // Check the file really is the image type it claims to be.
    const sig = { '.png': buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '.jpg': buf[0] === 0xff && buf[1] === 0xd8, '.webp': buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' }[ext];
    if (!sig) return send(res, 415, { error: 'That file is not a valid PNG, JPG or WebP image' });
    fs.mkdirSync(BRAND_DIR, { recursive: true });
    const file = 'logo-' + uid() + ext;
    fs.writeFileSync(path.join(BRAND_DIR, file), buf);
    const old = db.settings.logo && db.settings.logo.file;
    db.settings = Object.assign({}, db.settings, { logo: { file, v: Date.now() } });
    save();
    if (old) fs.unlink(path.join(BRAND_DIR, path.basename(old)), () => {});
    send(res, 200, { logo: logoInfo() });
  });
});

route('DELETE', '/api/branding/logo', (req, res) => {
  const old = db.settings.logo && db.settings.logo.file;
  db.settings = Object.assign({}, db.settings, { logo: null });
  save();
  if (old) fs.unlink(path.join(BRAND_DIR, path.basename(old)), () => {});
  send(res, 200, { ok: true });
});

/* ---- Drop folders ---- */

route('POST', '/api/folders', async (req, res) => {
  const b = await readJson(req);
  const name = await folders.create(b.name);
  send(res, 200, { name, folders: folders.info() });
});
route('POST', '/api/folders/scan', async (req, res) => {
  await folders.scan();
  send(res, 200, folders.info());
});
route('POST', '/api/settings', async (req, res) => {
  const b = await readJson(req);
  if (b.foldersDir !== undefined) {
    const dir = str(b.foldersDir, 1000).trim();
    if (dir) {
      if (!path.isAbsolute(dir)) throw httpError(400, 'Use the full path, e.g. C:\\Users\\Office\\OneDrive\\Signage or /srv/signage');
      let st;
      try { st = fs.statSync(dir); } catch { throw httpError(400, `The server can't find ${dir}`); }
      if (!st.isDirectory()) throw httpError(400, `${dir} is a file, not a folder`);
      try { fs.readdirSync(dir); } catch { throw httpError(400, `The server isn't allowed to read ${dir}`); }
    }
    db.settings = Object.assign({}, db.settings, { foldersDir: dir ? path.resolve(dir) : '' });
    save();
    await folders.scan();
  }
  send(res, 200, { settings: db.settings, folders: folders.info() });
});

/** What an editor sees: the media library and only the playlists they may edit. Nothing about screens, schedules, music or settings. */
function sendEditorState(req, res) {
  const allowed = new Set(req.user.playlists || []);
  const fi = folders.info();
  send(res, 200, {
    db: { media: db.media, playlists: db.playlists.filter((p) => allowed.has(p.id)), screens: [], schedules: [], overrides: [], musicSchedules: [], settings: {} },
    me: accounts.publicUser(req.user),
    status: {}, resolved: {}, activeSchedules: [], activeMusicSchedules: [],
    folders: { root: '', isDefault: true, error: '', folders: fi.folders.map((f) => ({ name: f.name, count: f.count, pending: f.pending })) },
    logo: logoInfo(),
    now: Date.now(),
    tzOffset: new Date().getTimezoneOffset(),
    info: { ips: [], port: PORT, version: VERSION, boot: BOOT_ID },
  });
}

route('GET', '/api/export', (req, res) => {
  send(res, 200, JSON.stringify(db, null, 2), {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="signage-backup-${ymd(new Date())}.json"`,
  });
});

route('POST', '/api/import', async (req, res) => {
  const b = await readJson(req, 50 * 1024 * 1024);
  if (!b || !Array.isArray(b.screens) || !Array.isArray(b.playlists)) throw httpError(400, 'That does not look like a signage backup file');
  db = Object.assign(EMPTY(), b);
  save();
  send(res, 200, { ok: true });
});

/* Media: upload one file per request, streamed straight to disk (no size limits from parsing). */
/* Uploads. Only real image/video types; never SVG (an SVG can carry scripts). */
const UPLOAD_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.mp4', '.m4v', '.webm', '.mov', '.ogv', '.mkv'];
function uploadType(name, mimeIn) {
  let ext = path.extname(String(name || '')).toLowerCase();
  let mime = String(mimeIn || '').split(';')[0].trim().toLowerCase();
  if (UPLOAD_EXTS.includes(ext)) mime = MIME[ext];
  else if (mime && EXT_FOR_MIME[mime] && UPLOAD_EXTS.includes(EXT_FOR_MIME[mime])) ext = EXT_FOR_MIME[mime];
  else return null;
  return { ext, mime };
}
function addUploadedMedia({ filename, original, mime, size, by }) {
  const m = {
    id: uid(),
    createdBy: by || '',
    type: mime.startsWith('video/') ? 'video' : 'image',
    name: String(original).replace(/\.[^.]+$/, '') || 'Upload',
    file: filename,
    mime,
    size,
    createdAt: Date.now(),
  };
  db.media.push(m);
  save();
  return m;
}
const notAllowed = (name) => `${name}: only images (JPG, PNG, GIF, WebP) and videos (MP4, WebM, MOV) can be uploaded`;

/* Single-request upload (kept for scripts and older pages; the admin panel uses chunked uploads below). */
route('POST', '/api/media/upload', (req, res, p, url) => {
  const original = str(url.searchParams.get('name') || 'upload', 255);
  const t = uploadType(original, req.headers['content-type']);
  if (!t) return send(res, 415, { error: notAllowed(original) });
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > MAX_UPLOAD) return send(res, 413, { error: `${original} is larger than ${MAX_UPLOAD / 1048576} MB` });
  const filename = uid() + uid() + t.ext;
  const dest = path.join(UPLOAD_DIR, filename);
  const out = fs.createWriteStream(dest);
  let size = 0;
  let failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    send(res, code, { error: msg });
  };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD) { fail(413, 'File too large'); req.destroy(); }
  });
  req.on('aborted', () => fail(400, 'Upload cancelled'));
  req.on('error', () => fail(400, 'Upload cancelled'));
  req.on('close', () => { if (!req.complete) fail(400, 'Upload cancelled'); });
  out.on('error', (e) => fail(500, 'Could not save file: ' + e.message));
  out.on('finish', () => { if (!failed) send(res, 200, addUploadedMedia({ filename, original, mime: t.mime, size, by: req.user.id })); });
  req.pipe(out);
}, { role: 'user' });

/*
 * Chunked, resumable uploads. The browser sends a file in pieces of up to CHUNK bytes, so no single
 * request is large (Cloudflare's free plan rejects requests over 100 MB), and a dropped connection
 * only costs the current piece.
 *   POST /api/uploads/start {name, size, type}  -> {id, chunkSize, received}
 *   PUT  /api/uploads/:id?offset=N  (raw bytes) -> {received}   (409 + {received} if out of step)
 *   GET  /api/uploads/:id                       -> {received}
 *   POST /api/uploads/:id/finish                -> the new media item
 *   DELETE /api/uploads/:id                     -> cancel
 * Unfinished uploads are kept across server restarts and deleted after 24 hours.
 */
const PARTIAL_DIR = path.join(UPLOAD_DIR, '.partial');
const CHUNK = 48 * 1048576;
fs.mkdirSync(PARTIAL_DIR, { recursive: true });
const partials = new Map();
const partPath = (id) => path.join(PARTIAL_DIR, id + '.part');
const metaPath = (id) => path.join(PARTIAL_DIR, id + '.json');
const saveMeta = (u) => fs.writeFileSync(metaPath(u.id), JSON.stringify({ ...u, busy: undefined, active: undefined }));
function dropPartial(id) {
  partials.delete(id);
  fs.unlink(partPath(id), () => {});
  fs.unlink(metaPath(id), () => {});
}
for (const f of fs.readdirSync(PARTIAL_DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    const u = JSON.parse(fs.readFileSync(path.join(PARTIAL_DIR, f), 'utf8'));
    const st = fs.statSync(partPath(u.id));
    u.received = Math.min(u.received, st.size);
    partials.set(u.id, u);
  } catch { fs.unlink(path.join(PARTIAL_DIR, f), () => {}); }
}
setInterval(() => {
  for (const [id, u] of partials) if (Date.now() - u.touched > 24 * 3600 * 1000) dropPartial(id);
}, 3600 * 1000).unref();
const getPartial = (id, user) => {
  const u = partials.get(id);
  if (!u || (u.owner && u.owner !== user.id && !isAdmin(user))) throw httpError(404, 'That upload has expired or was cancelled. Please upload the file again.');
  return u;
};

route('POST', '/api/uploads/start', async (req, res) => {
  const b = await readJson(req);
  const name = str(b.name || 'upload', 255);
  const t = uploadType(name, b.type);
  if (!t) throw httpError(415, notAllowed(name));
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw httpError(400, `${name} is empty`);
  if (size > MAX_UPLOAD) throw httpError(413, `${name} is larger than ${MAX_UPLOAD / 1048576} MB`);
  const u = { id: uid() + uid(), name, size, mime: t.mime, ext: t.ext, received: 0, touched: Date.now(), owner: req.user.id };
  fs.writeFileSync(partPath(u.id), '');
  partials.set(u.id, u);
  saveMeta(u);
  send(res, 200, { id: u.id, chunkSize: CHUNK, received: 0 });
}, { role: 'user' });

route('GET', '/api/uploads/:id', (req, res, p) => {
  const u = getPartial(p.id, req.user);
  send(res, 200, { received: u.received, size: u.size });
}, { role: 'user' });

route('PUT', '/api/uploads/:id', (req, res, p, url) => {
  const u = getPartial(p.id, req.user);
  const offset = Number(url.searchParams.get('offset'));
  // A retry of the piece in progress replaces it: the earlier attempt's connection has probably died
  // somewhere along the way (Wi-Fi drop, proxy) without the server being told.
  if (u.busy && offset === u.received && u.active) u.active('Replaced by a retry');
  if (u.busy || offset !== u.received) { req.resume(); return send(res, 409, { error: u.busy ? 'Still saving the previous piece' : 'Out of step', received: u.received, busy: !!u.busy }); }
  const len = parseInt(req.headers['content-length'] || '-1', 10);
  if (len > CHUNK || offset + Math.max(len, 0) > u.size) { req.resume(); return send(res, 413, { error: 'Piece too large' }); }
  u.busy = Date.now();
  // Write at the exact offset: if this piece is cut off, the retry simply overwrites it.
  const out = fs.createWriteStream(partPath(u.id), { flags: 'r+', start: offset });
  let n = 0;
  let failed = false;
  let idle;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    clearTimeout(idle);
    if (u.active === abort) { u.busy = 0; u.active = null; }
    out.destroy();
    if (!res.headersSent && !res.destroyed) send(res, code, { error: msg, received: u.received });
  };
  const abort = (why) => { fail(409, why); req.destroy(); };
  u.active = abort;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => abort('No data for 30 seconds'), 30000); };
  kick();
  req.on('data', (c) => {
    n += c.length;
    kick();
    if (n > CHUNK || offset + n > u.size) { fail(413, 'Piece too large'); req.destroy(); }
  });
  req.on('aborted', () => fail(400, 'Upload interrupted'));
  req.on('error', () => fail(400, 'Upload interrupted'));
  req.on('close', () => { if (!req.complete) fail(400, 'Upload interrupted'); });
  out.on('error', (e) => fail(500, 'Could not save: ' + e.message));
  out.on('finish', () => {
    if (failed) return;
    clearTimeout(idle);
    u.busy = 0;
    u.active = null;
    u.received = offset + n;
    u.touched = Date.now();
    saveMeta(u);
    send(res, 200, { received: u.received });
  });
  req.pipe(out);
}, { role: 'user' });

route('POST', '/api/uploads/:id/finish', async (req, res, p) => {
  const u = getPartial(p.id, req.user);
  if (u.busy || u.received !== u.size) throw httpError(409, `Only ${u.received} of ${u.size} bytes have arrived`);
  const filename = uid() + uid() + u.ext;
  await fs.promises.truncate(partPath(u.id), u.size);
  await fs.promises.rename(partPath(u.id), path.join(UPLOAD_DIR, filename));
  dropPartial(u.id);
  send(res, 200, addUploadedMedia({ filename, original: u.name, mime: u.mime, size: u.size, by: req.user.id }));
}, { role: 'user' });

route('DELETE', '/api/uploads/:id', (req, res, p) => {
  if (partials.has(p.id)) { getPartial(p.id, req.user); dropPartial(p.id); }
  send(res, 200, { ok: true });
}, { role: 'user' });

route('POST', '/api/media', async (req, res) => {
  const b = await readJson(req);
  const m = Object.assign({ id: uid(), createdAt: Date.now(), createdBy: req.user.id }, cleanMedia(b, null));
  db.media.push(m);
  save();
  send(res, 200, m);
}, { role: 'user' });

route('PUT', '/api/media/:id', async (req, res, p) => {
  const m = byId(db.media, p.id);
  if (!m) throw httpError(404, 'Not found');
  if (!canEditMedia(req.user, m)) throw httpError(403, 'You can only change content you added yourself');
  Object.assign(m, cleanMedia(await readJson(req), m));
  save();
  send(res, 200, m);
}, { role: 'user' });

route('DELETE', '/api/media/:id', async (req, res, p) => {
  const m = byId(db.media, p.id);
  if (!m) throw httpError(404, 'Not found');
  if (!canEditMedia(req.user, m)) throw httpError(403, 'You can only delete content you added yourself');
  if (!isAdmin(req.user)) {
    const others = db.playlists.filter((pl) => pl.items.some((it) => it.mediaId === m.id) && !canEditPlaylist(req.user, pl.id));
    if (others.length) throw httpError(409, `“${m.name}” is also used in ${others.map((pl) => pl.name).join(', ')}, which you can’t edit. Ask an administrator to remove it.`);
  }
  if (m.folderName) {
    // A folder file: deleting it means deleting the file, otherwise the folder would just bring it back.
    try { await folders.remove(m.folderName, m.folderFile); } catch (e) { throw httpError(409, `Couldn't delete ${m.folderFile} from the ${m.folderName} folder (${e.code || e.message}). Delete it from the folder instead.`); }
    if (!byId(db.media, m.id)) return send(res, 200, { ok: true }); // the folder sync already removed it
  }
  removeMedia(m);
  if (m.file) fs.unlink(path.join(UPLOAD_DIR, path.basename(m.file)), () => {});
  save();
  send(res, 200, { ok: true });
}, { role: 'user' });

/* Generic CRUD for playlists / screens / schedules */
function crud(name, clean, onDelete, { editorCanSave = false } = {}) {
  route('POST', `/api/${name}`, async (req, res) => {
    const o = Object.assign({ id: uid(), createdAt: Date.now() }, clean(await readJson(req)));
    db[name].push(o);
    save();
    if (name === 'playlists') syncFolders();
    if (name === 'musicSchedules') setTimeout(() => spotify.scheduleTick(), 200);
    send(res, 200, o);
  });
  route('PUT', `/api/${name}/:id`, async (req, res, p) => {
    const o = byId(db[name], p.id);
    if (!o) throw httpError(404, 'Not found');
    const b = await readJson(req);
    if (name === 'playlists') return savePlaylist(o, b, res, req.user);
    Object.assign(o, clean(Object.assign({}, o, b)));
    save();
    if (name === 'musicSchedules') setTimeout(() => spotify.scheduleTick(), 200);
    send(res, 200, o);
  }, { role: editorCanSave ? 'user' : 'admin' });
  route('DELETE', `/api/${name}/:id`, (req, res, p) => {
    const o = byId(db[name], p.id);
    if (!o) throw httpError(404, 'Not found');
    db[name] = db[name].filter((x) => x.id !== o.id);
    if (onDelete) onDelete(o);
    save();
    send(res, 200, { ok: true });
  });
}

/**
 * Saving a playlist from the editor. Two rules keep drop folders safe from stale copies of the
 * playlist (an editor left open, a second browser tab):
 *  - The folder link is never changed here, only by PUT /api/playlists/:id/folder.
 *  - Folder files added after the editor loaded the playlist (b.loadedAt) aren't in the editor's
 *    copy, so they're kept rather than dropped.
 */
function savePlaylist(o, b, res, user) {
  if (!canEditPlaylist(user, o.id)) throw httpError(403, 'You don’t have permission to edit this playlist');
  const before = o.items || [];
  const c = cleanPlaylist(Object.assign({}, o, b, { folder: null }));
  c.folder = o.folder || null;
  const since = Number(b.loadedAt) || 0;
  if (since) {
    const ids = new Set(c.items.map((i) => i.id));
    const arrived = before.filter((i) => i.addedAt && i.addedAt > since && !ids.has(i.id));
    c.items = c.folder && c.folder.position === 'start' ? arrived.concat(c.items) : c.items.concat(arrived);
  }
  Object.assign(o, c);
  save();
  syncFolders();
  send(res, 200, o);
}

// Link a playlist to a drop folder (or unlink with {folder: null}). Saved straight away.
route('PUT', '/api/playlists/:id/folder', async (req, res, p) => {
  const o = byId(db.playlists, p.id);
  if (!o) throw httpError(404, 'Not found');
  const b = await readJson(req);
  const folder = b.folder ? cleanFolderFeed(b.folder, { items: o.items, prev: o.folder }) : null;
  if (b.folder && !folder) throw httpError(400, 'Choose a folder');
  o.folder = folder;
  save();
  syncFolders();
  send(res, 200, o);
});

crud('playlists', cleanPlaylist, (pl) => {
  accounts.dropPlaylist(pl.id);
  for (const s of db.screens) if (s.defaultPlaylistId === pl.id) s.defaultPlaylistId = '';
  for (const s of db.schedules) if (s.playlistId === pl.id) { s.playlistId = ''; s.enabled = false; }
  db.overrides = db.overrides.filter((o) => o.playlistId !== pl.id);
}, { editorCanSave: true });
crud('screens', cleanScreen, (sc) => {
  for (const s of db.schedules) s.screenIds = (s.screenIds || []).filter((id) => id !== sc.id);
  for (const o of db.overrides) o.screenIds = (o.screenIds || []).filter((id) => id !== sc.id);
  delete status[sc.id];
  spotify.dropScreen(sc.id);
});
crud('schedules', cleanSchedule);
crud('musicSchedules', cleanMusicSchedule);

route('POST', '/api/screens/:id/identify', (req, res, p) => {
  if (!byId(db.screens, p.id)) throw httpError(404, 'Not found');
  (status[p.id] = status[p.id] || {}).identifyUntil = Date.now() + 15000;
  send(res, 200, { ok: true });
});

/* Takeovers: push a playlist to screens right now */
route('POST', '/api/overrides', async (req, res) => {
  const b = await readJson(req);
  if (!byId(db.playlists, b.playlistId)) throw httpError(400, 'Choose a playlist');
  const screenIds = idList(b.screenIds, db.screens);
  if (!b.allScreens && !screenIds.length) throw httpError(400, 'Choose at least one screen');
  const minutes = Math.max(0, Math.min(7 * 24 * 60, parseInt(b.minutes, 10) || 0));
  // Starts a few seconds from now, so every screen has it loaded and they all start it together.
  const startAt = Date.now() + TAKEOVER_LEAD;
  const o = { id: uid(), playlistId: b.playlistId, allScreens: !!b.allScreens, screenIds, createdAt: Date.now(), startAt, until: minutes ? startAt + minutes * 60000 : null };
  db.overrides.push(o);
  save();
  send(res, 200, o);
});
route('DELETE', '/api/overrides/:id', (req, res, p) => {
  db.overrides = db.overrides.filter((o) => o.id !== p.id);
  save();
  send(res, 200, { ok: true });
});
route('DELETE', '/api/overrides', (req, res) => {
  db.overrides = [];
  save();
  send(res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request');
  }
  const pathname = url.pathname;

  // Static assets for the admin panel
  if (req.method === 'GET' && pathname.startsWith('/static/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, pathname.slice(8)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    return serveFile(req, res, file);
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    // Changes from the admin panel must carry the X-Signage header. Browsers won't let another website
    // add a custom header to a request here, so this blocks forged ("cross-site") requests.
    if (!r.open && method !== 'GET' && req.headers['x-signage'] !== '1') {
      req.resume();
      return send(res, 403, { error: 'Blocked: this change didn’t come from the ENJOY Signage admin page. Reload the page and try again.' });
    }
    req.user = accounts.userForToken(parseCookies(req)[COOKIE]);
    if (!r.open && !req.user) { req.resume(); return send(res, 401, { error: 'Please sign in again', signin: true }); }
    if (!r.open && r.role === 'admin' && !isAdmin(req.user)) { req.resume(); return send(res, 403, { error: 'Only administrators can do that' }); }
    const params = {};
    try {
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      await r.handler(req, res, params, url);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, Object.assign({ error: e.message || 'Server error' }, e.retryAfter ? { retryAfter: e.retryAfter } : {}), e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
    }
    return;
  }
  send(res, 404, 'Not found');
});

server.requestTimeout = 0; // allow long uploads on slow Wi-Fi

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanAddresses();
    console.log(`\n  ENJOY Signage ${VERSION} is running\n`);
    console.log(`  Admin panel:   http://localhost:${PORT}/`);
    for (const ip of ips) console.log(`                 http://${ip}:${PORT}/`);
    console.log(`  Screens open:  http://${ips[0] || 'SERVER-IP'}:${PORT}/player`);
    console.log(`  Data folder:   ${DATA_DIR}`);
    if (accounts.needsSetup()) {
      console.log(`\n  ┌──────────────────────────────────────────────────────────┐`);
      console.log(`  │  First-time setup code:  ${accounts.setupCode()}                          │`);
      console.log(`  │  Open the admin panel and enter it to create the first    │`);
      console.log(`  │  administrator account. (Also saved in data/setup-code.txt)│`);
      console.log(`  └──────────────────────────────────────────────────────────┘`);
    }
    console.log('');
  });
}

module.exports = { scheduleActive, resolveScreen, server };
