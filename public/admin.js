'use strict';
/* ENJOY Signage — admin panel (no framework, no build step). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { db: { media: [], playlists: [], screens: [], schedules: [], overrides: [] }, status: {}, resolved: {}, activeSchedules: [], now: Date.now(), info: { ips: [], port: 3000 } };
let tab = (location.hash || '').slice(1);
const isAdminUser = () => !!(S.me && S.me.role === 'admin');
const ADMIN_TABS = ['screens', 'schedules', 'music', 'setup', 'users'];
const tabAllowed = (t) => !!VIEWS[t] && (isAdminUser() || !ADMIN_TABS.includes(t));
const defaultTab = () => (isAdminUser() ? 'screens' : 'playlists');
let selectedPl = null;
let plDraft = null;
let plDirty = false;
let mediaFilter = { q: '', type: '' };
let timelineScreen = 'all';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const COLORS = ['#3b5bdb', '#e8590c', '#2b8a3e', '#ae3ec9', '#1098ad', '#d6336c', '#5f3dc4', '#c77700', '#0b7285', '#862e9c'];
const TYPE_LABEL = { image: 'Image', video: 'Video', web: 'Web page', text: 'Text slide', countdown: 'Countdown' };
const DEFAULT_DURATION = { image: 10, video: 0, web: 30, text: 10, countdown: 30 };

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function api(method, url, body) {
  // X-Signage marks requests as coming from this page; the server refuses changes without it (blocks forged requests).
  const r = await fetch(url, { method, headers: Object.assign({ 'X-Signage': '1' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
async function refresh() { S = await api('GET', '/api/state'); }
async function mutate(fn, okMsg) {
  try {
    const out = await fn();
    await refresh();
    render();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    toast(e.message, 'error');
    e.toasted = true;
    throw e;
  }
}

const media = (id) => S.db.media.find((m) => m.id === id);
const playlist = (id) => S.db.playlists.find((p) => p.id === id);
const screen = (id) => S.db.screens.find((s) => s.id === id);
const mediaSrc = (m) => {
  if (m && m.folderName) return `/folders/${encodeURIComponent(m.folderName)}/${encodeURIComponent(m.folderFile)}?v=${m.mtime}`;
  return m && m.file ? '/uploads/' + encodeURIComponent(m.file) : '';
};

/** The address TVs use: always the server's local network address, even when this page was opened
 *  through a remote-access name (Cloudflare Tunnel, Tailscale) that TVs on the church network can't use. */
function serverBase() {
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const isLanIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if ((local || !isLanIp) && S.info.ips[0]) return `http://${S.info.ips[0]}${+S.info.port === 80 ? '' : ':' + S.info.port}`;
  const port = location.port || (location.protocol === 'https:' ? 443 : 80);
  return `${location.protocol}//${host}${String(port) === '80' ? '' : ':' + port}`;
}
const playerUrl = (id) => `${serverBase()}/player/${id}`;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

function copy(text) {
  const done = () => toast('Copied to clipboard');
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { prompt('Copy this link:', text); }
  ta.remove();
}

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}
function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function fmtDur(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m}m ${s}s` : `${m} min`;
}
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const hh = ((h + 11) % 12) + 1;
  return `${hh}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 || h === 24 ? 'am' : 'pm'}`;
}
function fmtUntil(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
const toMin = (t) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function daysLabel(days) {
  const d = [...(days || [])].sort();
  if (d.length === 7 || !d.length) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  if (d.join() === '0,6') return 'Weekends';
  return WEEK_ORDER.filter((x) => d.includes(x)).map((x) => DAY_NAMES[x]).join(', ');
}
function targetLabel(rule) {
  if (rule.allScreens) return 'All screens';
  const names = (rule.screenIds || []).map((id) => screen(id)?.name).filter(Boolean);
  return names.length ? names.join(', ') : '<span class="muted">No screens</span>';
}

function usage(mediaId) {
  return S.db.playlists.filter((p) => p.items.some((i) => i.mediaId === mediaId));
}

function thumb(m, cls = '') {
  if (!m) return `<div class="thumb ${cls}"><div class="ico">?</div></div>`;
  let inner = '';
  if (m.type === 'image') inner = `<img src="${mediaSrc(m)}" loading="lazy" alt="">`;
  else if (m.type === 'video') inner = `<video src="${mediaSrc(m)}#t=1" preload="metadata" muted playsinline></video>`;
  else if (m.type === 'web') {
    let host = m.url;
    try { host = new URL(m.url).hostname.replace(/^www\./, ''); } catch {}
    const yt = /youtu\.?be/.test(m.url);
    inner = `<div class="ico">${yt ? '▶' : '🌐'}<small>${esc(host)}</small></div>`;
  } else {
    const bgImg = media(m.bgImageId);
    const bgStyle = bgImg ? `background-image:linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url('${mediaSrc(bgImg)}');` : '';
    inner = `<div class="txt" style="background-color:${esc(m.bg)};color:${esc(m.fg)};${bgStyle}">${esc(m.title || m.name)}${m.type === 'countdown' ? '<em>05:00</em>' : ''}</div>`;
  }
  return `<div class="thumb ${cls}">${inner}<span class="type">${TYPE_LABEL[m.type]}</span></div>`;
}

function playlistOptions(selected, { none = '' } = {}) {
  const opts = S.db.playlists.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return (none ? `<option value="">${esc(none)}</option>` : '') + opts;
}

function screenChips(name, selectedIds, allChecked) {
  return `<div class="chips" data-screen-chips>
    <label class="chip"><input type="checkbox" name="allScreens" ${allChecked ? 'checked' : ''}><span>All screens</span></label>
    ${S.db.screens.map((s) => `<label class="chip ${allChecked ? 'disabled' : ''}"><input type="checkbox" name="${name}" value="${s.id}" ${selectedIds.includes(s.id) ? 'checked' : ''} ${allChecked ? 'disabled' : ''}><span>${esc(s.name)}</span></label>`).join('')}
  </div>`;
}
// "All screens" disables the individual screen chips
document.addEventListener('change', (e) => {
  if (e.target.name === 'allScreens') {
    const wrap = e.target.closest('[data-screen-chips]');
    $$('input:not([name=allScreens])', wrap).forEach((i) => { i.disabled = e.target.checked; i.closest('.chip').classList.toggle('disabled', e.target.checked); });
  }
});

function emptyBox(title, text, action = '') {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

function modal({ title, body, saveLabel = 'Save', onSave, wide = false, danger = false, hideSave = false }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<form class="modal ${wide ? 'wide' : ''}" novalidate>
    <header><h2>${esc(title)}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="modal-body">${body}</div>
    <footer><button type="button" class="btn" data-close>${hideSave ? 'Close' : 'Cancel'}</button>${hideSave ? '' : `<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(saveLabel)}</button>`}</footer>
  </form>`;
  document.body.appendChild(back);
  const form = $('form', back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('footer [type=submit]', form);
    if (btn) btn.disabled = true;
    try {
      const keep = await onSave(form, close);
      if (keep !== false) close();
    } catch (err) {
      if (!err.toasted) toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  setTimeout(() => $('input:not([type=checkbox]):not([type=color]),select,textarea', form)?.focus(), 40);
  return { back, form, close };
}

function confirmBox(title, text, label = 'Delete') {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal({ title, body: `<p>${text}</p>`, saveLabel: label, danger: true, onSave: () => { ok = true; } });
    const obs = new MutationObserver(() => { if (!m.back.isConnected) { obs.disconnect(); resolve(ok); } });
    obs.observe(document.body, { childList: true });
  });
}

const fd = (form) => Object.fromEntries(new FormData(form));
const checkedValues = (form, name) => $$(`input[name="${name}"]:checked`, form).map((i) => i.value);

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/** Show the uploaded logo (Setup → Branding) in the sidebar and as the browser tab icon. */
let shownLogo;
function applyBranding() {
  const url = S.logo ? S.logo.url : '';
  if (url === shownLogo) return;
  shownLogo = url;
  const mark = $('#brand-mark');
  if (!mark.dataset.default) mark.dataset.default = mark.innerHTML;
  mark.innerHTML = url ? `<img src="${esc(url)}" alt="ENJOY Signage">` : mark.dataset.default;
  const fav = $('#favicon');
  if (!fav.dataset.default) fav.dataset.default = fav.href;
  fav.href = url || fav.dataset.default;
}

function render() {
  applyBranding();
  if (!tabAllowed(tab)) { tab = defaultTab(); history.replaceState(null, '', '#' + tab); }
  $$('.nav a').forEach((a) => { a.classList.toggle('active', a.dataset.tab === tab); a.hidden = !tabAllowed(a.dataset.tab); });
  $('#view').innerHTML = VIEWS[tab]();
  AFTER[tab] && AFTER[tab]();
  renderSideFoot();
}

/** Bottom of the sidebar: who's signed in, plus screen status for administrators. */
function renderSideFoot() {
  const el = $('#side-foot');
  if (!el) return;
  const me = S.me || {};
  const online = Object.values(S.status).filter((s) => s.online).length;
  el.innerHTML = `<div class="me"><b>${esc(me.name || me.username || '')}</b><span>${me.role === 'admin' ? 'Administrator' : 'Editor'}</span>
      <div class="me-acts"><a href="#" data-action="me-password">Change password</a> · <a href="#" data-action="me-signout">Sign out</a></div></div>` +
    (isAdminUser() ? `<b>${online}</b> of <b>${S.db.screens.length}</b> screens online<br>Server: ${esc(serverBase().replace(/^https?:\/\//, ''))}<br>` : '') + `v${esc(S.info.version || '')}`;
}

const VIEWS = {};
const AFTER = {};

/* ---------- Screens ---------- */

VIEWS.screens = () => `
  <header class="page-head">
    <div><h1>Screens</h1><p class="sub">Each TV or projector opens its own player link in a web browser on the church network. What it shows comes from its default playlist, unless a schedule or a takeover is active.</p></div>
    <button class="btn primary" data-action="screen-new">+ Add screen</button>
  </header>
  ${S.spotify && S.spotify.connected ? musicCard() : ''}
  ${S.db.screens.length && S.db.playlists.length ? takeoverCard() : ''}
  <div class="grid screens">
    ${S.db.screens.map(screenCard).join('') || emptyBox('No screens yet', 'Add a screen for each display — e.g. “Foyer TV”, “Kids Check-in”, “Café”. Then open its link on that device.', '<button class="btn primary" data-action="screen-new">+ Add your first screen</button>')}
  </div>`;

/* ---------- Background music (Spotify) ---------- */

const MUSIC_LABEL = { keep: 'Keep playing', videos: 'Pause for videos', all: 'Pause the whole time' };
const spotifyOn = () => !!(S.spotify && (S.spotify.connected || S.spotify.clientId));

/** Would this playlist item pause the music (on a screen with sound on)? Mirrors server.js buildItems. */
function pausesMusic(p, it) {
  const m = media(it.mediaId);
  if (!m) return false;
  const hasSound = m.type === 'video' || (m.type === 'web' && /youtu\.?be/.test(m.url || ''));
  const pl = p.music || 'keep';
  return it.music === 'pause' || (it.music !== 'keep' && (pl === 'all' || (pl === 'videos' && hasSound)));
}

function musicCard() {
  const sp = S.spotify;
  const n = sp.now;
  const holding = sp.holds;
  let state;
  if (!sp.enabled) state = '<span class="badge">Auto-pause off</span>';
  else if (sp.engaged && sp.engaged.touched) state = `<span class="badge takeover">${sp.engaged.mode === 'duck' ? 'Turned down' : 'Paused'} for video</span>`;
  else if (holding.length) state = '<span class="badge schedule">Video playing</span>';
  else state = '<span class="badge live">Ready</span>';
  const track = n && n.track ? `<b>${esc(n.track)}</b>${n.artist ? ' · ' + esc(n.artist) : ''}` : '<span class="muted">Nothing playing</span>';
  const device = n && n.device ? `${n.isPlaying ? '▶ Playing' : '❚❚ Paused'} on ${esc(n.device.name)}${n.device.volume != null ? ' · volume ' + n.device.volume + '%' : ''}` : 'No active Spotify device — start music in the Spotify app';
  const why = holding.length ? `Held by ${holding.map((h) => `<b>${esc(h.screen)}</b>${h.item ? ' (' + esc(h.item) + ')' : ''}`).join(', ')}` : sp.lastAction ? esc(sp.lastAction) : '';
  return `<section class="card music">
    <div class="music-row">
      ${n && n.art ? `<img class="art" src="${esc(n.art)}" alt="">` : '<div class="art ph">♪</div>'}
      <div class="grow">
        <div class="row" style="gap:8px"><h2>Background music</h2>${state}</div>
        <div class="track">${track}</div>
        <div class="muted small">${device}</div>
        ${why ? `<div class="muted small">${why}</div>` : ''}
        ${sp.lastError ? `<div class="warn-line">⚠ ${esc(sp.lastError)}</div>` : ''}
      </div>
      <div class="row music-btns">
        <button class="btn icon" data-action="sp-control" data-a="previous" title="Previous">⏮</button>
        <button class="btn icon" data-action="sp-control" data-a="${n && n.isPlaying ? 'pause' : 'play'}" title="${n && n.isPlaying ? 'Pause' : 'Play'}">${n && n.isPlaying ? '❚❚' : '▶'}</button>
        <button class="btn icon" data-action="sp-control" data-a="next" title="Next">⏭</button>
        ${sp.engaged ? '<button class="btn sm" data-action="sp-control" data-a="resume-now">Resume music now</button>' : ''}
        <a class="btn sm ghost" href="#music">Music →</a>
      </div>
    </div>
  </section>`;
}

function spotifyCard() {
  const sp = S.spotify || {};
  const redirect = S.info.spotifyRedirect;
  const head = `<h2 style="margin-bottom:6px">Background music (Spotify)</h2>
    <p class="small">The signage server can fade out and pause the church’s Spotify music while a video with sound plays, then bring it back afterwards. It controls whichever device Spotify is already playing on (sound desk PC, speaker, phone). <b>Needs Spotify Premium.</b></p>`;
  if (!sp.connected) {
    return `<section class="card" id="spotify-card">${head}
      <ol class="steps small">
        <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> and sign in with the church’s Spotify account (the one that plays the music). Click <b>Create app</b>. Any name works, e.g. “ENJOY Signage”.</li>
        <li>Under <b>Redirect URIs</b> add exactly this address, and tick <b>Web API</b>:
          <div class="linkbox" style="margin:6px 0"><code>${esc(redirect)}</code><button class="btn sm ghost" data-action="copy" data-text="${esc(redirect)}">Copy</button></div></li>
        <li>Save, then copy the app’s <b>Client ID</b> into the box below.</li>
        <li>Click <b>Connect Spotify</b> and approve.</li>
      </ol>
      <form id="sp-connect" class="row" style="align-items:flex-end">
        <label class="field grow" style="margin:0"><span>Client ID</span><input type="text" name="clientId" value="${esc(sp.clientId || '')}" placeholder="32 letters and numbers" autocomplete="off" spellcheck="false"></label>
        <button class="btn primary" type="submit">Connect Spotify</button>
      </form>
      <div id="sp-paste" class="hidden" style="margin-top:14px">
        <p class="small">A Spotify tab has opened. After you click <b>Agree</b>, it will land on a page at <code>127.0.0.1</code> that may say it <i>can’t be reached</i>, which is expected on this computer. Copy the <b>whole address</b> from that tab’s address bar and paste it here:</p>
        <form id="sp-paste-form" class="row"><input type="text" name="url" class="grow" placeholder="http://127.0.0.1:${esc(S.info.port)}/spotify/callback?code=…" style="flex:1"><button class="btn primary" type="submit">Finish connecting</button></form>
      </div>
      ${sp.lastError ? `<div class="warn-line" style="margin-top:8px">⚠ ${esc(sp.lastError)}</div>` : ''}
    </section>`;
  }
  return `<section class="card" id="spotify-card">${head}
    <p class="small">✅ Connected${sp.user ? ' as <b>' + esc(sp.user) + '</b>' : ''}. <button class="btn sm ghost danger-text" data-action="sp-disconnect">Disconnect</button></p>
    <form id="sp-settings">
      <div class="grid2">
        <div class="field"><span class="field-label">Automatic pausing</span><label class="check"><input type="checkbox" name="enabled" ${sp.enabled ? 'checked' : ''}> Pause the music for videos</label>
          <div class="hint">Which videos is set per playlist and per item on the Playlists page.</div></div>
        <label class="field"><span>When a video plays</span><select name="mode">
          <option value="pause">Fade out and pause the music</option>
          <option value="duck" ${sp.mode === 'duck' ? 'selected' : ''}>Just turn the music down</option></select></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Turn down to</span><input type="number" name="duckPercent" min="0" max="100" value="${esc(sp.duckPercent)}"><div class="hint">% of normal volume (turn-down mode).</div></label>
        <label class="field"><span>Fade (seconds)</span><input type="number" name="fadeSeconds" min="0" max="10" step="0.5" value="${esc(sp.fadeSeconds)}"></label>
        <label class="field"><span>Resume after (seconds)</span><input type="number" name="resumeDelaySeconds" min="0" max="60" value="${esc(sp.resumeDelaySeconds)}"><div class="hint">Wait this long after the video, so back-to-back videos don’t make the music flicker.</div></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">Save music settings</button><button class="btn" type="button" data-action="sp-control" data-a="test">Test: pause for 10 seconds</button></div>
    </form>
    <p class="muted small" style="margin-top:12px">Only screens with <b>Play video sound</b> turned on pause the music. If the TV that plays a video has its sound off, the music keeps going. The device’s volume must be controllable from Spotify for fades; otherwise it simply pauses.</p>
    ${sp.lastError ? `<div class="warn-line">⚠ ${esc(sp.lastError)}</div>` : ''}
  </section>`;
}

function takeoverCard() {
  const active = S.db.overrides.filter((o) => !o.until || o.until > S.now);
  return `<section class="card takeover">
    <div class="card-head"><div><h2>Take over screens now</h2><div class="muted small">Push a playlist to screens immediately — “Service starting”, a welcome, or an urgent notice. It overrides everything else.</div></div></div>
    <form id="takeover-form" class="takeover-form">
      <label class="field"><span>Playlist</span><select name="playlistId">${playlistOptions('')}</select></label>
      <div class="field"><span class="field-label">Screens</span>${screenChips('screenIds', [], true)}</div>
      <label class="field"><span>For</span><select name="minutes">
        <option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30" selected>30 minutes</option>
        <option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="0">Until I stop it</option>
      </select></label>
      <button class="btn danger" type="submit">Start takeover</button>
    </form>
    ${active.length ? `<div class="active-overrides">${active.map((o) => `
      <div class="override-row">
        <span class="badge takeover">● LIVE</span>
        <div class="grow"><b>${esc(playlist(o.playlistId)?.name || 'Deleted playlist')}</b> on ${targetLabel(o)} <span class="muted small">· ${o.until ? 'ends ' + fmtUntil(o.until) : 'until stopped'}</span></div>
        <button class="btn sm" data-action="override-stop" data-id="${o.id}">Stop</button>
      </div>`).join('')}</div>` : ''}
  </section>`;
}

function screenCard(s) {
  const st = S.status[s.id] || {};
  const r = S.resolved[s.id] || { source: 'none' };
  const online = !!st.online;
  const badge = { takeover: 'Takeover', schedule: 'Scheduled', default: 'Default', none: 'Nothing' }[r.source];
  const seen = st.lastSeen ? (online ? 'Online' : 'Last seen ' + ago(S.now - st.lastSeen)) : 'Never connected';
  return `<div class="card screen-card">
    <div class="top">
      <span class="dot ${online ? 'on' : 'off'}" title="${esc(seen)}"></span>
      <div class="grow"><h3>${esc(s.name)}</h3><div class="loc">${s.room ? `<b>${esc(s.room)}</b> · ` : ''}${esc(s.location || '')}${s.location ? ' · ' : ''}${esc(seen)}</div></div>
    </div>
    <div class="now">
      <span class="badge ${r.source}">${badge}${r.source === 'schedule' ? ': ' + esc(r.label) : ''}${r.playOnce ? ' · plays once' : ''}</span>
      <div class="pl">${r.playlistName ? esc(r.playlistName) : '<span class="muted">No playlist — choose a default</span>'}</div>
      <div class="meta">${online && st.item ? 'Showing “' + esc(st.item) + '”' : ''}${online && st.res ? ' · ' + esc(st.res) : ''}${r.until ? ' · until ' + fmtUntil(r.until) : ''}</div>
      ${r.note ? `<div class="meta">▶ ${esc(r.note)}</div>` : ''}
      ${syncLine(r, st, online)}
    </div>
    ${st.error && online ? `<div class="warn-line">⚠ ${esc(st.error)}</div>` : ''}
    <div class="linkbox"><code title="${esc(playerUrl(s.id))}">${esc(playerUrl(s.id))}</code><button class="btn sm ghost" data-action="copy" data-text="${esc(playerUrl(s.id))}">Copy</button></div>
    <div class="actions">
      <button class="btn sm" data-action="screen-edit" data-id="${s.id}">Edit</button>
      <button class="btn sm" data-action="screen-identify" data-id="${s.id}" ${online ? '' : 'disabled title="Screen is offline"'}>Identify</button>
      <a class="btn sm" href="/player/${s.id}" target="_blank" rel="noopener">Open player</a>
      <span class="grow"></span>
      <button class="btn sm ghost danger-text" data-action="screen-delete" data-id="${s.id}">Delete</button>
    </div>
  </div>`;
}

/** How the screen is keeping in step with the others (see Synced playback in the guide). */
function syncLine(r, st, online) {
  if (r.sync === 'lengths') return `<div class="meta" title="Synced playback needs every video's length. A TV measures it the first time it plays the video, then this screen switches to synced by itself.">⏱ Not synced yet: waiting for a TV to measure a video’s length</div>`;
  if (r.sync !== 'on' && r.sync !== 'room') return '';
  const off = online && st.sync && st.sync.off != null ? Math.abs(st.sync.off) : null;
  const how = off == null ? '' : off <= 50 ? ` · within ${off} ms` : ` · catching up (${off >= 1000 ? (off / 1000).toFixed(1) + ' s' : off + ' ms'} out)`;
  return `<div class="meta" title="Every screen showing this playlist plays it in step${r.sync === 'room' ? ', and screens in the same room change items together' : ''}.">⏱ ${r.sync === 'room' ? `In step with the <b>${esc(r.room)}</b> room` : 'Synced'}${how}</div>`;
}

function screenForm(s = {}) {
  return `
    <label class="field"><span>Name</span><input type="text" name="name" value="${esc(s.name || '')}" placeholder="e.g. Foyer TV" required></label>
    <label class="field"><span>Location <em class="muted">(optional)</em></span><input type="text" name="location" value="${esc(s.location || '')}" placeholder="e.g. Main entrance, left wall"></label>
    <label class="field"><span>Room <em class="muted">(optional)</em></span><input type="text" name="room" list="room-list" value="${esc(s.room || '')}" placeholder="e.g. Foyer" maxlength="60">
      <datalist id="room-list">${[...new Set(S.db.screens.map((x) => (x.room || '').trim()).filter(Boolean))].map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <div class="hint">Screens in the same room change items at the same moments, even when they show different playlists.</div></label>
    <label class="field"><span>Default playlist</span><select name="defaultPlaylistId">${playlistOptions(s.defaultPlaylistId, { none: '— None (black screen) —' })}</select>
      <div class="hint">Plays whenever no schedule or takeover is active.</div></label>
    <div class="grid2">
      <label class="field"><span>Rotation</span><select name="rotation">
        ${[0, 90, 180, 270].map((d) => `<option value="${d}" ${+s.rotation === d ? 'selected' : ''}>${d === 0 ? 'None (landscape)' : d === 90 ? '90° (portrait)' : d === 270 ? '270° (portrait, other way)' : '180° (upside down)'}</option>`).join('')}
      </select><div class="hint">For TVs mounted sideways.</div></label>
      <div class="field"><span class="field-label">Sound</span><label class="check"><input type="checkbox" name="audio" ${s.audio ? 'checked' : ''}> Play video sound</label>
        <div class="hint">Browsers may still mute until kiosk mode is set up (see Setup).</div></div>
    </div>`;
}
const screenBody = (f) => ({ ...fd(f), audio: f.audio.checked });

/* ---------- Media ---------- */

VIEWS.media = () => `
  <header class="page-head">
    <div><h1>Media</h1><p class="sub">Images, videos, web pages and slides you can add to playlists. Tip: export videos as MP4 (H.264) for the best compatibility with TVs.</p></div>
    <div class="row">
      <label class="btn primary">⬆ Upload files<input type="file" id="file-input" multiple accept="image/*,video/*" hidden></label>
      <button class="btn" data-action="media-new" data-type="text">+ Text slide</button>
      <button class="btn" data-action="media-new" data-type="countdown">+ Countdown</button>
      <button class="btn" data-action="media-new" data-type="web">+ Web page / YouTube</button>
    </div>
  </header>
  <div class="dropzone" id="dropzone">Drag images or videos here to upload</div>
  <div class="uploads" id="uploads"></div>
  <div class="toolbar">
    <input type="search" id="media-q" placeholder="Search media…" value="${esc(mediaFilter.q)}">
    <select id="media-type"><option value="">All types</option>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${mediaFilter.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <span class="muted small" id="media-count"></span>
  </div>
  <div class="grid media" id="media-grid"></div>`;

const canEditMediaUi = (m) => isAdminUser() || (!m.folderName && m.createdBy && m.createdBy === (S.me || {}).id);
const userName = (id) => { const u = (S.users || []).find((x) => x.id === id); return u ? u.name : ''; };

function renderMediaGrid() {
  const q = mediaFilter.q.toLowerCase();
  const list = S.db.media
    .filter((m) => (!mediaFilter.type || m.type === mediaFilter.type) && (!q || (m.name + ' ' + (m.title || '')).toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt);
  $('#media-count').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  $('#media-grid').innerHTML = list.map((m) => {
    const used = usage(m.id).length;
    return `<div class="tile">
      ${thumb(m)}
      <div class="info"><div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
        <div class="muted small">${m.folderName ? `<span class="folder-tag">📁 ${esc(m.folderName)}</span> · ` : ''}${isAdminUser() && userName(m.createdBy) ? `by ${esc(userName(m.createdBy))} · ` : ''}${TYPE_LABEL[m.type]}${m.size ? ' · ' + fmtSize(m.size) : ''} · ${used ? `in ${used} playlist${used > 1 ? 's' : ''}` : 'unused'}</div></div>
      <div class="acts">${canEditMediaUi(m) ? `<button class="btn sm" data-action="media-edit" data-id="${m.id}">Edit</button><span class="grow"></span><button class="btn sm ghost danger-text" data-action="media-delete" data-id="${m.id}">Delete</button>` : `<span class="muted small" style="padding:4px 2px">${m.createdBy === (S.me || {}).id ? '' : 'Added by someone else'}</span>`}</div>
    </div>`;
  }).join('') || emptyBox(S.db.media.length ? 'No matches' : 'No media yet', S.db.media.length ? 'Try a different search.' : 'Upload images or videos, or create a text slide or countdown.');
}

AFTER.media = () => {
  renderMediaGrid();
  $('#media-q').addEventListener('input', (e) => { mediaFilter.q = e.target.value; renderMediaGrid(); });
  $('#media-type').addEventListener('change', (e) => { mediaFilter.type = e.target.value; renderMediaGrid(); });
  $('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
};

// Drag & drop anywhere on the media page
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (tab !== 'media' || !e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  $('#dropzone')?.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (tab !== 'media') return;
  if (ev === 'dragleave' && e.relatedTarget) return;
  $('#dropzone')?.classList.remove('over');
  if (ev === 'drop' && e.dataTransfer?.files?.length) { e.preventDefault(); uploadFiles(e.dataTransfer.files); }
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send one piece of a file. Resolves with the server's byte count; rejects with .status/.received on errors. */
function sendPiece(id, offset, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/uploads/${id}?offset=${offset}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Signage', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status < 300) return resolve(j.received);
      reject(Object.assign(new Error(j.error || 'Upload failed'), { status: xhr.status, received: j.received }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('Network error'), { status: 0 }));
    xhr.send(blob);
  });
}

/**
 * Upload a file in pieces (48 MB each), so any size works through Cloudflare (which limits single
 * requests to 100 MB), and a dropped connection only re-sends the current piece.
 */
async function uploadInPieces(file, onPercent) {
  const start = await api('POST', '/api/uploads/start', { name: file.name, size: file.size, type: file.type });
  const id = start.id;
  let offset = start.received || 0;
  try {
    while (offset < file.size) {
      const blob = file.slice(offset, offset + start.chunkSize);
      for (let attempt = 1; ; attempt++) {
        try {
          offset = await sendPiece(id, offset, blob, (n) => onPercent(Math.floor(((offset + n) / file.size) * 99)));
          break;
        } catch (e) {
          // Out of step but the server has a different amount: carry on from where it is.
          if (e.status === 409 && e.received != null && e.received !== offset) { offset = e.received; break; }
          // Real errors (wrong file type, too big…) stop; network trouble and "still saving" retry, up to 8 times.
          if ((e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status)) || attempt >= 8) throw e;
          await sleep(Math.min(30000, 1500 * attempt)); // network hiccup: wait, ask where we got to, try again
          try { offset = (await api('GET', '/api/uploads/' + id)).received; } catch {}
        }
      }
    }
    const m = await api('POST', `/api/uploads/${id}/finish`);
    onPercent(100);
    return m;
  } catch (e) {
    api('DELETE', '/api/uploads/' + id).catch(() => {});
    throw new Error(`${file.name}: ${e.message}`);
  }
}

/** A video file's length in seconds, read in this browser (null if it can't tell, e.g. a format it can't play). */
function videoLengthOf(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (x) => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(x); };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => finish(isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 15000);
    v.src = url;
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const box = $('#uploads');
  let ok = 0;
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'upload-row';
    row.innerHTML = `<span class="grow" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file.name)}</span><div class="bar"><i></i></div><span class="pct muted">0%</span>`;
    box && box.appendChild(row);
    try {
      const m = await uploadInPieces(file, (p) => {
        $('i', row).style.width = p + '%';
        $('.pct', row).textContent = p + '%';
      });
      // Record the video's length, so screens can play it in sync from its very first showing.
      if (m && m.type === 'video') { const len = await videoLengthOf(file); if (len) await api('PUT', '/api/media/' + m.id, { name: m.name, length: len }).catch(() => {}); }
      ok++;
      row.remove();
    } catch (e) {
      toast(e.message, 'error');
      row.remove();
    }
  }
  await refresh();
  if (tab === 'media') render();
  if (ok) toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`);
}

function mediaForm(type, m = {}) {
  const images = S.db.media.filter((x) => x.type === 'image');
  const name = `<label class="field"><span>Name in the library</span><input type="text" name="name" value="${esc(m.name || '')}" placeholder="${type === 'text' ? 'e.g. Youth night announcement' : type === 'countdown' ? 'e.g. Sunday 10am countdown' : 'Name'}"></label>`;
  if (type === 'image' || type === 'video') {
    return `<div class="preview-box">${type === 'video' ? `<video src="${mediaSrc(m)}" controls muted style="width:100%;height:100%;background:#000"></video>` : thumb(m)}</div>${name}
      <div class="muted small">${m.folderName ? `📁 From the “${esc(m.folderName)}” drop folder: <code>${esc(m.folderFile)}</code>. Save over that file to update it everywhere.` : `${esc(m.mime || '')} · uploaded ${new Date(m.createdAt).toLocaleDateString()}`} · ${fmtSize(m.size)}</div>`;
  }
  if (type === 'web') {
    return `${name}<label class="field"><span>Web address</span><input type="url" name="url" value="${esc(m.url || '')}" placeholder="https://…" required>
      <div class="hint">YouTube links are turned into a full-screen autoplaying embed. Published Google Slides, Canva and Power BI links work too. Some websites refuse to be shown inside other pages — use “Open player” to check.</div></label>`;
  }
  const slide = `
    <label class="field"><span>${type === 'countdown' ? 'Heading (above the timer)' : 'Heading'}</span><input type="text" name="title" value="${esc(m.title || (type === 'countdown' ? 'Service starts in' : ''))}"></label>
    <label class="field"><span>${type === 'countdown' ? 'Text below the timer' : 'Body text'} <em class="muted">(optional)</em></span><textarea name="body" placeholder="${type === 'countdown' ? 'Please find a seat' : 'Line breaks are kept'}">${esc(m.body || '')}</textarea></label>
    ${type === 'countdown' ? `<div class="grid2">
      <label class="field"><span>Count down to</span><input type="time" name="target" value="${esc(m.target || '10:00')}" required><div class="hint">Time of day, every day it’s shown.</div></label>
      <label class="field"><span>Show after that time</span><input type="text" name="after" value="${esc(m.after ?? 'Welcome!')}"></label>
    </div>` : ''}
    <div class="grid3">
      <div class="field"><span class="field-label">Background</span><input type="color" name="bg" value="${esc(m.bg || '#1b2a4a')}"></div>
      <div class="field"><span class="field-label">Text</span><input type="color" name="fg" value="${esc(m.fg || '#ffffff')}"></div>
      <label class="field"><span>Align</span><select name="align"><option value="center">Centre</option><option value="left" ${m.align === 'left' ? 'selected' : ''}>Left</option></select></label>
    </div>
    <label class="field"><span>Background image <em class="muted">(optional)</em></span><select name="bgImageId"><option value="">None</option>${images.map((i) => `<option value="${i.id}" ${i.id === m.bgImageId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>
      <div class="hint">The image is darkened so text stays readable.</div></label>`;
  return name + slide;
}

/* ---------- Playlists ---------- */

VIEWS.playlists = () => {
  if (selectedPl && !playlist(selectedPl)) { selectedPl = null; plDraft = null; plDirty = false; }
  if (!selectedPl && S.db.playlists.length) selectedPl = S.db.playlists[0].id;
  if (selectedPl && (!plDraft || plDraft.id !== selectedPl)) { plDraft = loadDraft(selectedPl); plDirty = false; }
  return `
  <header class="page-head">
    <div><h1>Playlists</h1><p class="sub">${isAdminUser() ? 'An ordered loop of content. Assign one as a screen’s default, schedule it, or use it for a takeover.' : 'The playlists you’ve been given. Add your uploads, drag to reorder and set how long each shows. Changes appear on the TVs within a few seconds of saving.'}</p></div>
    ${isAdminUser() ? '<button class="btn primary" data-action="pl-new">+ New playlist</button>' : ''}
  </header>
  ${S.db.playlists.length ? `<div class="split">
    <aside class="pl-list">${S.db.playlists.map((p) => `<a href="#playlists" data-action="pl-select" data-id="${p.id}" class="${p.id === selectedPl ? 'active' : ''}"><b>${esc(p.name)}</b><span>${p.items.length} item${p.items.length === 1 ? '' : 's'} · ${playlistLength(p)}${p.playOnce ? ' · ▶ plays once' : ''}${spotifyOn() && p.items.some((it) => pausesMusic(p, it)) ? ' · ♪ pauses music' : ''}${p.folder ? ' · 📁 ' + esc(p.folder.name) : ''}</span></a>`).join('')}</aside>
    <section id="pl-editor">${plEditor()}</section>
  </div>` : `<div class="grid">${isAdminUser() ? emptyBox('No playlists yet', 'Create a playlist, then add images, videos and slides to it.', '<button class="btn primary" data-action="pl-new">+ New playlist</button>') : emptyBox('No playlists to edit yet', 'An administrator hasn’t given you any playlists yet. You can still upload content on the Media page.')}</div>`}`;
};

function playlistLength(p) {
  let sec = 0, videos = 0;
  for (const it of p.items) {
    const m = media(it.mediaId);
    if (!m) continue;
    const d = it.duration != null ? it.duration : DEFAULT_DURATION[m.type];
    if (m.type === 'video' && !d) videos++;
    else sec += d;
  }
  return (sec ? fmtDur(sec) : videos ? '' : '0s') + (videos ? `${sec ? ' + ' : ''}${videos} video${videos > 1 ? 's' : ''}` : '');
}

/* ---------- Drop folders ---------- */

const BS = String.fromCharCode(92); // a backslash, for Windows paths
const UNC = BS + BS;
const folderInfo = (name) => (S.folders && S.folders.folders || []).find((f) => f.name === name);
function folderPath(name) {
  const root = (S.folders && S.folders.root) || '';
  const sep = root.includes(BS) ? BS : '/';
  return root.replace(/[\\/]+$/, '') + sep + name;
}

/** The bar above a playlist's items saying which folder feeds it. Folder files themselves are normal items. */
function folderBar(p) {
  if (!p.folder) return '';
  const fo = p.folder;
  const fi = folderInfo(fo.name);
  let note = '';
  if (S.folders && S.folders.error) note = `<div class="warn-line">⚠ ${esc(S.folders.error)}</div>`;
  else if (!fi) note = `<div class="warn-line">⚠ The folder “${esc(fo.name)}” doesn’t exist at the moment. Its items are skipped until it’s back.</div>`;
  else if (fi.pending) note = `<div class="muted small">⏳ ${fi.pending} file${fi.pending > 1 ? 's are' : ' is'} still copying in, so ${fi.pending > 1 ? 'they’ll' : 'it’ll'} be added when finished.</div>`;
  const server = S.db.playlists.find((x) => x.id === p.id);
  const waiting = plDirty && server ? server.items.filter((it) => it.addedAt > (p._loadedAt || 0) && !p.items.some((x) => x.id === it.id)).length : 0;
  if (waiting) note += `<div class="muted small">📥 ${waiting} new file${waiting > 1 ? 's' : ''} arrived while you were editing. ${waiting > 1 ? 'They’ll' : 'It’ll'} be added when you save.</div>`;
  return `<div class="folder-box">
    <div class="folder-head">
      <div class="grow"><b>📁 Linked to the “${esc(fo.name)}” folder</b>
        <div class="muted small">New images and videos dropped into ${isAdminUser() ? `<code>${esc(folderPath(fo.name))}</code>` : 'that folder'} are added to the <b>${fo.position === 'start' ? 'start' : 'end'}</b> of this playlist (images ${esc(fo.imageSeconds || 10)}s, ${fo.fit === 'cover' ? 'fill' : 'fit'}). Then they’re normal items: drag them, change their time, or remove them. Deleting a file from the folder removes it here too.</div>
        ${note}</div>
      ${isAdminUser() ? `<button class="btn sm" data-action="pl-folder">Settings</button>
      <button class="btn sm ghost danger-text" data-action="pl-folder-stop" title="Stop adding new files from this folder. Items already added stay.">Unlink</button>` : ''}
    </div>
  </div>`;
}

function folderSettingsForm(fo = {}) {
  const list = (S.folders && S.folders.folders) || [];
  return `
    <p class="small" style="margin-top:0">New images and videos dropped into the folder are added to this playlist automatically, along with any already there. They become normal items you can reorder, time and remove individually.</p>
    <label class="field"><span>Folder</span><select name="name">
      ${list.map((f) => `<option value="${esc(f.name)}" ${f.name === fo.name ? 'selected' : ''}>${esc(f.name)} (${f.count} file${f.count === 1 ? '' : 's'})</option>`).join('')}
      <option value="" ${list.length ? '' : 'selected'}>+ New folder…</option>
    </select></label>
    <label class="field" data-newname ${list.length ? 'hidden' : ''}><span>New folder name</span><input type="text" name="newName" placeholder="e.g. ${esc(plDraft.name)}" value="${list.length ? '' : esc(plDraft.name)}"><div class="hint">Created in ${esc(S.folders ? S.folders.root : '')}</div></label>
    <label class="field"><span>Add new files</span><select name="position"><option value="end">At the end of the playlist</option><option value="start" ${fo.position === 'start' ? 'selected' : ''}>At the start of the playlist</option></select>
      <div class="hint">When several arrive at once, they’re added in file-name order (01, 02, … 10).</div></label>
    <div class="grid2">
      <label class="field"><span>New images show for (seconds)</span><input type="number" name="imageSeconds" min="1" max="3600" value="${esc(fo.imageSeconds || 10)}"><div class="hint">Videos play to the end. You can change any item afterwards.</div></label>
      <label class="field"><span>New items’ sizing</span><select name="fit"><option value="contain">Fit (whole picture)</option><option value="cover" ${fo.fit === 'cover' ? 'selected' : ''}>Fill the screen</option></select></label>
    </div>`;
}

function brandingCard() {
  return `<section class="card" id="branding-card">
    <h2 style="margin-bottom:6px">Branding</h2>
    <p class="small">The ENJOY Signage wordmark appears in this admin panel and on the TVs when nothing is scheduled and when a TV is choosing its screen. The browser tab shows the ENJOY badge. To use a different logo instead (for a campus or event, say), upload a <b>PNG with a transparent background</b>; JPG and WebP work too. White or light versions suit the dark backgrounds best.</p>
    <div class="row" style="align-items:center;gap:16px">
      <div class="logo-preview"><img src="${esc(S.logo ? S.logo.url : '/static/brand/wordmark-small.png')}" alt="Current logo"></div>
      <label class="btn ${S.logo ? '' : 'primary'}">⬆ ${S.logo ? 'Replace logo' : 'Use a different logo'}<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
      ${S.logo ? '<button class="btn ghost danger-text" data-action="logo-remove">Back to ENJOY Signage</button>' : ''}
    </div>
  </section>`;
}

function foldersCard() {
  const F = S.folders || { folders: [] };
  const usedBy = (name) => S.db.playlists.filter((p) => p.folder && p.folder.name === name).map((p) => p.name);
  return `<section class="card" id="folders-card">
    <h2 style="margin-bottom:6px">Drop folders</h2>
    <p class="small">Link a playlist to a folder (Playlists → <b>📁 Link a drop folder</b>). Images and videos dropped into it are added to the Media library and to the playlist automatically. They then behave like anything else: reorder them, change their timing, or use them in other playlists. Save over a file to update it, or delete it from the folder to remove it everywhere. Files are checked every few seconds and only used once they’ve finished copying.</p>
    <form id="folders-root-form" class="row" style="align-items:flex-end;margin-bottom:12px">
      <label class="field grow" style="margin:0"><span>Drop folders location on the server</span><input type="text" name="foldersDir" value="${esc(S.db.settings && S.db.settings.foldersDir || '')}" placeholder="${esc(F.isDefault ? F.root : '')} (default)" spellcheck="false"></label>
      <button class="btn" type="submit">Save location</button>
    </form>
    <div class="hint" style="margin:-6px 0 12px">Leave blank for the default inside the data folder. Or enter a folder that OneDrive, Dropbox or Google Drive syncs to this computer, so staff can drop files from anywhere.</div>
    ${F.error ? `<div class="warn-line" style="margin-bottom:10px">⚠ ${esc(F.error)}</div>` : ''}
    <div id="folders-list">${foldersList()}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-action="folder-new">+ New folder</button></div>
    <details style="margin-top:14px"><summary class="small"><b>How staff can drop files in from their own computers</b></summary>
      <div class="small" style="margin-top:8px">
        <p><b>Windows server:</b> in File Explorer, right-click the drop folders location → <i>Properties → Sharing → Share…</i>, add the people who should be able to drop files, and give them <i>Read/Write</i>. They then open <code>${UNC}${esc(S.info.hostname || 'SERVER')}${BS}folders</code> (or whatever share name you chose) and drag files in.</p>
        <p><b>Ubuntu server:</b> run <code>sudo church-signage share-folders</code>. It shares the drop folders on the network, with a password, as <code>${UNC}SERVER-IP${BS}signage</code> (Windows) or <code>smb://SERVER-IP/signage</code> (Mac).</p>
        <p><b>Cloud folder:</b> install OneDrive, Dropbox or Google Drive on the server, sync a shared folder, and enter its path above. On OneDrive, right-click the folder and choose <i>Always keep on this device</i>.</p>
      </div>
    </details>
  </section>`;
  function foldersList() {
    if (!F.folders.length) return '<p class="muted small">No drop folders yet.</p>';
    return `<table class="table"><thead><tr><th>Folder</th><th>Files</th><th class="hide-sm">Used by</th><th class="hide-sm">Where</th></tr></thead><tbody>${F.folders.map((f) => {
      const u = usedBy(f.name);
      return `<tr><td><b>📁 ${esc(f.name)}</b></td><td>${f.count}${f.pending ? ` <span class="muted small">(+${f.pending} copying)</span>` : ''}</td><td class="hide-sm">${u.length ? esc(u.join(', ')) : '<span class="muted">Not used yet</span>'}</td><td class="hide-sm"><code class="small">${esc(folderPath(f.name))}</code></td></tr>`;
    }).join('')}</tbody></table>`;
  }
}

/** A working copy of a playlist for the editor, stamped with the server time it was loaded. */
function loadDraft(id) {
  return Object.assign(JSON.parse(JSON.stringify(playlist(id))), { _loadedAt: S.now });
}

/** After linking/unlinking a folder (already saved on the server), bring the editor up to date without losing unsaved edits. */
function afterFolderChange() {
  const server = playlist(plDraft.id);
  if (!server) return;
  if (!plDirty) plDraft = loadDraft(server.id);
  else plDraft.folder = JSON.parse(JSON.stringify(server.folder || null)); // other edits stay; new files merge in on save
  render();
}

function plEditor() {
  const p = plDraft;
  if (!p) return '';
  const usedDefault = S.db.screens.filter((s) => s.defaultPlaylistId === p.id).map((s) => s.name);
  const usedSched = S.db.schedules.filter((s) => s.playlistId === p.id).map((s) => s.name);
  const used = [usedDefault.length ? 'Default on ' + usedDefault.join(', ') : '', usedSched.length ? 'Scheduled in ' + usedSched.join(', ') : ''].filter(Boolean).join(' · ');
  return `<div class="card">
    <div class="row">
      <input type="text" class="title-input grow" id="pl-name" value="${esc(p.name)}" aria-label="Playlist name">
      <label class="row small muted" style="gap:6px">Transition <select id="pl-transition" style="width:auto"><option value="fade">Crossfade</option><option value="none" ${p.transition === 'none' ? 'selected' : ''}>Cut</option></select></label>
      <label class="row small muted" style="gap:6px" title="${ONCE_HINT}">At the end <select id="pl-end" style="width:auto"><option value="loop">Loop</option><option value="once" ${p.playOnce ? 'selected' : ''}>Play once</option></select></label>
      <label class="row small muted" style="gap:6px" title="${SYNC_HINT}">Screens <select id="pl-sync" style="width:auto"><option value="on">In sync</option><option value="off" ${p.sync === false ? 'selected' : ''}>Each on its own</option></select></label>
      ${spotifyOn() ? `<label class="row small muted" style="gap:6px" title="What the Spotify background music does while this playlist is on a screen with sound">Music <select id="pl-music" style="width:auto">${Object.entries(MUSIC_LABEL).map(([k, v]) => `<option value="${k}" ${(p.music || 'keep') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
    </div>
    ${isAdminUser() ? `<div class="used-by" style="padding-left:6px">${used ? esc(used) : 'Not used by any screen or schedule yet.'}</div>` : ''}
    <div class="hint" id="pl-once-hint" style="padding-left:6px" ${p.playOnce ? '' : 'hidden'}>▶ ${ONCE_HINT}</div>
    <div id="pl-folder-box">${folderBar(p)}</div>
    <ol class="pl-items" id="pl-items">
      ${p.items.map((it, i) => plRow(it, i)).join('') || `<li class="empty" style="list-style:none">${p.folder ? 'Nothing yet. Drop images or videos into the folder and they’ll appear here.' : 'This playlist is empty. Add some content, or link a drop folder.'}</li>`}
    </ol>
    <div class="pl-foot">
      <button class="btn" data-action="pl-add">+ Add content</button>
      ${p.folder || !isAdminUser() ? '' : '<button class="btn" data-action="pl-folder">📁 Link a drop folder…</button>'}
      <span class="muted small" id="pl-total">${lengthLabel(p)}</span>
      <span class="grow"></span>
      ${isAdminUser() ? '<button class="btn ghost danger-text" data-action="pl-delete">Delete</button>' : ''}
      <a class="btn" href="/player?playlist=${p.id}" target="_blank" rel="noopener" data-action="pl-preview">Preview ↗</a>
      ${isAdminUser() ? '<button class="btn" data-action="pl-duplicate">Duplicate</button>' : ''}
      <button class="btn primary" data-action="pl-save" id="pl-save" ${plDirty ? '' : 'disabled'}>${plDirty ? 'Save changes' : 'Saved'}</button>
    </div>
  </div>`;
}

function plRow(it, i) {
  const m = media(it.mediaId);
  const def = DEFAULT_DURATION[m?.type] ?? 10;
  const isVideo = m?.type === 'video';
  return `<li class="pl-item" draggable="true" data-idx="${i}">
    <span class="handle" title="Drag to reorder">⋮⋮</span>
    <span class="num">${i + 1}</span>
    ${thumb(m, 'sm')}
    <div class="grow"><div class="name">${esc(m?.name || 'Missing media')}</div><div class="muted small">${TYPE_LABEL[m?.type] || ''}${m && m.folderName ? ` · <span class="folder-tag" title="${esc(folderPath(m.folderName) + (folderPath('').endsWith(BS) ? BS : '/') + m.folderFile)}">📁 ${esc(m.folderName)}</span>` : ''}${m && m.missing ? ' · <span class="warn-line">folder missing</span>' : ''}${spotifyOn() && pausesMusic(plDraft, it) ? ' · <span class="music-tag">pauses music</span>' : ''}</div></div>
    <div class="pl-ctrls">
    ${spotifyOn() && m ? `<select data-field="music" data-idx="${i}" title="Background music during this item. Auto follows the playlist’s Music setting; Pause always pauses it; Keep never does."><option value="">♪ Auto</option><option value="pause" ${it.music === 'pause' ? 'selected' : ''}>♪ Pause</option><option value="keep" ${it.music === 'keep' ? 'selected' : ''}>♪ Keep</option></select>` : ''}
    ${m && (m.type === 'image' || m.type === 'video') ? `<select data-field="fit" data-idx="${i}" title="How it fills the screen"><option value="contain">Fit</option><option value="cover" ${it.fit === 'cover' ? 'selected' : ''}>Fill</option></select>` : ''}
    <label class="dur" title="${isVideo ? 'Leave blank to play the whole video' : 'Seconds on screen'}"><input type="number" min="0" step="1" data-field="duration" data-idx="${i}" value="${it.duration ?? ''}" placeholder="${isVideo ? 'full' : def}"> sec</label>
    <button class="btn icon ghost" data-action="pl-move" data-idx="${i}" data-dir="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button class="btn icon ghost" data-action="pl-move" data-idx="${i}" data-dir="1" title="Move down" ${i === plDraft.items.length - 1 ? 'disabled' : ''}>↓</button>
    <button class="btn icon ghost danger-text" data-action="pl-remove" data-idx="${i}" title="Remove from playlist">✕</button>
    </div>
  </li>`;
}

function setDirty(v = true) {
  plDirty = v;
  const b = $('#pl-save');
  if (b) { b.disabled = !v; b.textContent = v ? 'Save changes' : 'Saved'; }
  const t = $('#pl-total');
  if (t && plDraft) t.textContent = lengthLabel(plDraft);
}
const lengthLabel = (p) => (p.playOnce ? 'Plays once: ' : 'Loop length: ') + playlistLength(p);
const SYNC_HINT = 'In sync: every screen showing this playlist plays it in step, and screens in the same room change items together. Each on its own: every screen plays it at its own pace, as before.';
const ONCE_HINT = 'Plays through once each time a schedule or takeover starts it, then the screen goes back to what it would otherwise show. Used as a screen’s default playlist, it still loops.';
function rerenderItems() {
  $('#pl-editor').innerHTML = plEditor();
  bindPlEditor();
}

function bindPlEditor() {
  const list = $('#pl-items');
  if (!list) return;
  $('#pl-name').addEventListener('input', (e) => { plDraft.name = e.target.value; setDirty(); });
  $('#pl-transition').addEventListener('change', (e) => { plDraft.transition = e.target.value; setDirty(); });
  $('#pl-sync').addEventListener('change', (e) => { plDraft.sync = e.target.value !== 'off'; setDirty(); });
  $('#pl-end').addEventListener('change', (e) => { plDraft.playOnce = e.target.value === 'once'; $('#pl-once-hint').hidden = !plDraft.playOnce; setDirty(); });
  $('#pl-music')?.addEventListener('change', (e) => { plDraft.music = e.target.value; setDirty(); rerenderItems(); });
  list.addEventListener('input', (e) => {
    const f = e.target.dataset.field;
    if (!f) return;
    const it = plDraft.items[+e.target.dataset.idx];
    it[f] = f === 'duration' ? (e.target.value === '' ? null : Math.max(0, +e.target.value)) : e.target.value;
    setDirty();
    if (f === 'music') rerenderItems();
  });
  // drag to reorder
  let from = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.pl-item');
    if (!li || e.target.closest('input,select')) return;
    from = +li.dataset.idx;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(from));
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('.pl-item');
    if (from == null || !li) return;
    e.preventDefault();
    $$('.pl-item', list).forEach((x) => x.classList.remove('drop-above', 'drop-below'));
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('.pl-item');
    if (from == null || !li) return;
    e.preventDefault();
    let to = +li.dataset.idx;
    if (li.classList.contains('drop-below')) to++;
    const [moved] = plDraft.items.splice(from, 1);
    if (to > from) to--;
    plDraft.items.splice(to, 0, moved);
    from = null;
    setDirty();
    rerenderItems();
  });
  list.addEventListener('dragend', () => { from = null; $$('.pl-item', list).forEach((x) => x.classList.remove('dragging', 'drop-above', 'drop-below')); });
}
AFTER.playlists = bindPlEditor;

window.addEventListener('beforeunload', (e) => { if (plDirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- Schedules ---------- */

VIEWS.schedules = () => `
  <header class="page-head">
    <div><h1>Schedules</h1><p class="sub">While a schedule is active, its playlist takes over the screens it targets. When schedules overlap, the higher priority wins. Outside any schedule, each screen goes back to its default playlist.</p></div>
    <button class="btn primary" data-action="sched-new" ${S.db.playlists.length ? '' : 'disabled title="Create a playlist first"'}>+ Add schedule</button>
  </header>
  <section class="card">
    <div class="card-head"><h2>This week</h2>
      <select id="tl-screen" style="width:auto"><option value="all">All screens</option>${S.db.screens.map((s) => `<option value="${s.id}" ${timelineScreen === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    </div>
    ${weekView()}
  </section>
  <section class="card">
    <div class="card-head"><h2>All schedules</h2></div>
    ${S.db.schedules.length ? `<table class="table">
      <thead><tr><th>Name</th><th>Playlist</th><th class="hide-sm">Screens</th><th>When</th><th class="hide-sm">Dates</th><th class="hide-sm">Priority</th><th>On</th><th></th></tr></thead>
      <tbody>${[...S.db.schedules].sort((a, b) => b.priority - a.priority || toMin(a.startTime) - toMin(b.startTime)).map(schedRow).join('')}</tbody>
    </table>` : emptyBox('No schedules yet', 'Example: “Sunday service” — every Sunday 9:30am–12pm, show the Service playlist on all screens.')}
  </section>`;

AFTER.schedules = () => {
  $('#tl-screen').addEventListener('change', (e) => { timelineScreen = e.target.value; render(); });
};

const schedColor = (s) => COLORS[S.db.schedules.indexOf(s) % COLORS.length];

function schedRow(s) {
  const active = S.activeSchedules.includes(s.id);
  const dates = s.startDate || s.endDate ? (s.startDate === s.endDate ? s.startDate : `${s.startDate || '…'} → ${s.endDate || '…'}`) : 'Ongoing';
  const st = toMin(s.startTime), en = toMin(s.endTime);
  const time = st === en ? 'All day' : `${fmtTime(s.startTime)} – ${fmtTime(s.endTime)}${en < st ? ' (overnight)' : ''}`;
  return `<tr class="${s.enabled ? '' : 'off'}">
    <td><span class="swatch" style="background:${schedColor(s)}"></span><b>${esc(s.name)}</b> ${active ? '<span class="badge live">● Active now</span>' : ''}</td>
    <td>${esc(playlist(s.playlistId)?.name || '—')}${playlist(s.playlistId)?.playOnce ? '<div class="muted small">▶ plays once</div>' : ''}</td>
    <td class="hide-sm">${targetLabel(s)}</td>
    <td>${daysLabel(s.days)}<div class="muted small">${time}</div></td>
    <td class="hide-sm small">${esc(dates)}</td>
    <td class="hide-sm">${s.priority}</td>
    <td><label class="toggle"><input type="checkbox" data-action="sched-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}><span></span></label></td>
    <td class="acts">
      <button class="btn sm" data-action="sched-edit" data-id="${s.id}">Edit</button>
      <button class="btn sm ghost" data-action="sched-dup" data-id="${s.id}" title="Duplicate">⧉</button>
      <button class="btn sm ghost danger-text" data-action="sched-delete" data-id="${s.id}" title="Delete">✕</button>
    </td>
  </tr>`;
}

function appliesOn(s, d) {
  const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(d.getDay())) return false;
  const k = ymd(d);
  if (s.startDate && k < s.startDate) return false;
  if (s.endDate && k > s.endDate) return false;
  return true;
}

function weekView(o = {}) {
  const label = o.label || ((s) => playlist(s.playlistId)?.name || '');
  const colorOf = o.color || schedColor;
  const action = o.action || 'sched-edit';
  const HOUR = 24; // px per hour
  const now = new Date(S.now);
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = [...Array(7)].map((_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; });
  const scheds = o.list || S.db.schedules.filter((s) => s.enabled && s.playlistId && (timelineScreen === 'all' || s.allScreens || s.screenIds.includes(timelineScreen)));

  const cols = days.map((d) => {
    const prev = new Date(d); prev.setDate(prev.getDate() - 1);
    const segs = [];
    for (const s of scheds) {
      const st = toMin(s.startTime), en = toMin(s.endTime);
      if (appliesOn(s, d)) {
        if (st < en) segs.push([s, st, en]);
        else if (st === en) segs.push([s, 0, 1440]);
        else segs.push([s, st, 1440]);
      }
      if (st > en && en > 0 && appliesOn(s, prev)) segs.push([s, 0, en]);
    }
    segs.sort((a, b) => a[0].priority - b[0].priority || a[1] - b[1]);
    const placed = [];
    const blocks = segs.map(([s, a, b]) => {
      const overlap = placed.filter(([pa, pb]) => pa < b && a < pb).length;
      placed.push([a, b]);
      const tip = `${s.name} · ${label(s)} · ${fmtTime(s.startTime)}–${fmtTime(s.endTime)} · priority ${s.priority}`;
      return `<div class="blk" data-action="${action}" data-id="${s.id}" title="${esc(tip)}" style="top:${(a / 60) * HOUR}px;height:${Math.max(14, ((b - a) / 60) * HOUR - 1)}px;background:${colorOf(s)};left:${3 + overlap * 10}px;z-index:${10 + overlap}">
        <b>${esc(s.name)}</b>${(b - a) >= 60 ? esc(label(s)) : ''}</div>`;
    }).join('');
    const isToday = ymd(d) === ymd(now);
    const line = isToday ? `<div class="nowline" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR}px"></div>` : '';
    return { d, isToday, html: `<div class="col ${isToday ? 'today' : ''}" style="height:${24 * HOUR}px">${blocks}${line}</div>` };
  });

  const hours = [...Array(12)].map((_, i) => `<span style="top:${i * 2 * HOUR}px">${i === 0 ? '' : fmtTime(`${i * 2}:00`)}</span>`).join('');
  return `<div class="week" style="--hour:${HOUR}px">
    <div class="hd"></div>
    ${cols.map((c) => `<div class="hd ${c.isToday ? 'today' : ''}">${DAY_NAMES[c.d.getDay()]}<small>${c.d.getDate()}/${c.d.getMonth() + 1}</small></div>`).join('')}
    <div class="hours" style="height:${24 * HOUR}px">${hours}</div>
    ${cols.map((c) => c.html).join('')}
  </div>
  <div class="legend-note">${scheds.length ? 'Blocks further right are higher priority and win where they overlap. Click a block to edit it.' : (o.empty || 'Nothing is scheduled this week — screens will play their default playlists.')}</div>`;
}

function schedForm(s = {}) {
  const days = s.days || [0, 1, 2, 3, 4, 5, 6];
  return `
    <div class="grid2">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(s.name || '')}" placeholder="e.g. Sunday service" required></label>
      <label class="field"><span>Playlist</span><select name="playlistId">${playlistOptions(s.playlistId)}</select></label>
    </div>
    <div class="field"><span class="field-label">Screens</span>${screenChips('screenIds', s.screenIds || [], s.allScreens ?? true)}</div>
    <div class="field"><span class="field-label">Days</span>
      <div class="chips">${WEEK_ORDER.map((d) => `<label class="chip"><input type="checkbox" name="days" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${DAY_NAMES[d]}</span></label>`).join('')}</div>
      <div class="row" style="margin-top:8px;gap:4px">
        <button type="button" class="btn sm ghost" data-days="0,1,2,3,4,5,6">Every day</button>
        <button type="button" class="btn sm ghost" data-days="1,2,3,4,5">Weekdays</button>
        <button type="button" class="btn sm ghost" data-days="0">Sundays</button>
        <button type="button" class="btn sm ghost" data-days="0,6">Weekends</button>
      </div>
    </div>
    <div class="grid2">
      <label class="field"><span>Start time</span><input type="time" name="startTime" value="${esc(s.startTime || '09:00')}" required></label>
      <label class="field"><span>End time</span><input type="time" name="endTime" value="${esc(s.endTime || '12:00')}" required></label>
    </div>
    <div class="hint" style="margin:-8px 0 14px">An end time earlier than the start runs overnight. The same start and end time means all day.</div>
    <div class="grid2">
      <label class="field"><span>From date <em class="muted">(optional)</em></span><input type="date" name="startDate" value="${esc(s.startDate || '')}"></label>
      <label class="field"><span>Until date <em class="muted">(optional)</em></span><input type="date" name="endDate" value="${esc(s.endDate || '')}"></label>
    </div>
    <div class="hint" style="margin:-8px 0 14px">For a one-off event (e.g. Christmas Eve), set both dates to the same day.</div>
    <div class="grid2">
      <label class="field"><span>Priority</span><input type="number" name="priority" value="${s.priority ?? 10}" step="1"><div class="hint">Higher wins when schedules overlap.</div></label>
      <div class="field"><span class="field-label">Status</span><label class="check"><input type="checkbox" name="enabled" ${s.enabled !== false ? 'checked' : ''}> Enabled</label></div>
    </div>`;
}

function schedBody(f) {
  const v = fd(f);
  const days = checkedValues(f, 'days').map(Number);
  if (!days.length) throw new Error('Pick at least one day');
  const allScreens = f.allScreens.checked;
  const screenIds = checkedValues(f, 'screenIds');
  if (!allScreens && !screenIds.length) throw new Error('Pick at least one screen');
  if (v.startDate && v.endDate && v.endDate < v.startDate) throw new Error('The until date is before the from date');
  if (!v.playlistId) throw new Error('Choose a playlist');
  return { name: v.name, playlistId: v.playlistId, allScreens, screenIds, days, startTime: v.startTime, endTime: v.endTime, startDate: v.startDate, endDate: v.endDate, priority: +v.priority || 0, enabled: f.enabled.checked };
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  const want = b.dataset.days.split(',');
  $$('input[name=days]', b.closest('form')).forEach((i) => (i.checked = want.includes(i.value)));
});

/* ---------- Music (Spotify) ---------- */

let spDevices = null;     // Spotify Connect devices (loaded when the Music page opens)
let spLists = null;       // the church account's playlists
let spListErr = '';
let spLoading = false;

async function loadSpotifyLists(fresh) {
  if (spLoading) return;
  spLoading = true;
  const [d, l] = await Promise.allSettled([api('GET', '/api/spotify/devices'), api('GET', '/api/spotify/playlists' + (fresh ? '?fresh=1' : ''))]);
  spDevices = d.status === 'fulfilled' ? d.value.devices : [];
  if (l.status === 'fulfilled') { spLists = l.value.playlists; spListErr = ''; } else { spLists = spLists || []; spListErr = l.reason.message; }
  spLoading = false;
  if (tab === 'music' && !$('.modal-back')) render();
}

const MUSIC_COLORS = ['#1db954', '#0b7285', '#5f3dc4', '#c77700', '#d6336c', '#1098ad', '#862e9c', '#2b8a3e'];
const musicColor = (s) => MUSIC_COLORS[(S.db.musicSchedules || []).indexOf(s) % MUSIC_COLORS.length];

function deviceOptions(selectedName, { any = 'Whichever device is playing' } = {}) {
  const list = spDevices || [];
  const names = new Set(list.map((d) => d.name));
  return `<option value="">${esc(any)}</option>` +
    list.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id)}" ${d.name === selectedName ? 'selected' : ''}>${esc(d.name)}${d.active ? ' (playing now)' : ''}</option>`).join('') +
    (selectedName && !names.has(selectedName) ? `<option value="${esc(selectedName)}" selected>${esc(selectedName)} (offline)</option>` : '');
}

function playlistOptionsSp(selectedUri) {
  const list = spLists || [];
  const known = list.some((p) => p.uri === selectedUri);
  return list.map((p) => `<option value="${esc(p.uri)}" ${p.uri === selectedUri ? 'selected' : ''}>${esc(p.name)}${p.total ? ` · ${p.total} songs` : ''}</option>`).join('') +
    (selectedUri && !known ? `<option value="${esc(selectedUri)}" selected>(current) ${esc(selectedUri)}</option>` : '') +
    `<option value="__link" ${list.length ? '' : 'selected'}>Paste a Spotify link…</option>`;
}

function musicNow() {
  const sp = S.spotify || {};
  const n = sp.now;
  const run = sp.musicRun;
  const status = [];
  if (sp.engaged && sp.engaged.touched) status.push(`<span class="badge takeover">${sp.engaged.mode === 'duck' ? 'Turned down' : 'Paused'} for a video</span>`);
  if (run) status.push(`<span class="badge live">● Schedule “${esc(run.name)}”</span>`);
  return `<div class="music-row big">
      ${n && n.art ? `<img class="art" src="${esc(n.art)}" alt="">` : '<div class="art ph">♪</div>'}
      <div class="grow">
        <div class="row" style="gap:8px">${status.join('')}</div>
        <div class="track">${n && n.track ? `<b>${esc(n.track)}</b>${n.artist ? ' · ' + esc(n.artist) : ''}` : '<span class="muted">Nothing playing</span>'}</div>
        <div class="muted small">${n && n.device ? `${n.isPlaying ? '▶ Playing' : '❚❚ Paused'} on <b>${esc(n.device.name)}</b>` : 'No active Spotify device. Open Spotify on the music computer or speaker.'}</div>
        ${sp.lastAction ? `<div class="muted small">${esc(sp.lastAction)}</div>` : ''}
        ${sp.lastError ? `<div class="warn-line">⚠ ${esc(sp.lastError)}</div>` : ''}
      </div>
    </div>
    <div class="music-controls">
      <button class="btn icon" data-action="sp-control" data-a="previous" title="Previous">⏮</button>
      <button class="btn icon primary" data-action="sp-control" data-a="${n && n.isPlaying ? 'pause' : 'play'}" title="${n && n.isPlaying ? 'Pause' : 'Play'}">${n && n.isPlaying ? '❚❚' : '▶'}</button>
      <button class="btn icon" data-action="sp-control" data-a="next" title="Next">⏭</button>
      <button class="btn icon ${n && n.shuffle ? 'on' : ''}" data-action="m-shuffle" data-state="${n && n.shuffle ? 0 : 1}" title="Shuffle ${n && n.shuffle ? 'on' : 'off'}">🔀</button>
      <button class="btn icon ${n && n.repeat && n.repeat !== 'off' ? 'on' : ''}" data-action="m-repeat" data-state="${n && n.repeat === 'off' ? 'context' : n && n.repeat === 'context' ? 'track' : 'off'}" title="Repeat: ${esc(n ? n.repeat : 'off')}">${n && n.repeat === 'track' ? '🔂' : '🔁'}</button>
      <label class="vol" title="Volume">🔈<input type="range" id="music-vol" min="0" max="100" value="${n && n.device && n.device.volume != null ? n.device.volume : 50}" ${n && n.device && n.device.supportsVolume ? '' : 'disabled'}><span id="music-vol-val">${n && n.device && n.device.volume != null ? n.device.volume + '%' : ''}</span></label>
      <span class="grow"></span>
      <button class="btn sm" data-action="m-stop" title="Fade out and pause">Fade out &amp; stop</button>
      ${sp.engaged ? '<button class="btn sm" data-action="sp-control" data-a="resume-now">Resume music now</button>' : ''}
    </div>
    <div class="row" style="margin-top:12px">
      <span class="small muted">Play on</span>
      <select id="m-device" style="width:auto;min-width:220px">${deviceOptions(n && n.device ? n.device.name : '', { any: 'Choose a speaker or computer…' })}</select>
      <button class="btn sm" data-action="m-transfer">Move music here</button>
      <button class="btn sm ghost" data-action="m-refresh" title="Refresh the lists of devices and playlists">↻ Refresh</button>
    </div>`;
}

function msRow(m) {
  const active = (S.activeMusicSchedules || []).includes(m.id);
  const running = S.spotify && S.spotify.musicRun && S.spotify.musicRun.id === m.id;
  const st = toMin(m.startTime), en = toMin(m.endTime);
  const time = st === en ? 'All day' : `${fmtTime(m.startTime)} – ${fmtTime(m.endTime)}${en < st ? ' (overnight)' : ''}`;
  return `<tr class="${m.enabled ? '' : 'off'}">
    <td><span class="swatch" style="background:${musicColor(m)}"></span><b>${esc(m.name)}</b> ${running ? '<span class="badge live">● Playing</span>' : active ? '<span class="badge schedule">Active</span>' : ''}</td>
    <td>${esc(m.playlistName || '—')}</td>
    <td class="hide-sm">${esc(m.deviceName || 'Whichever is playing')}</td>
    <td>${daysLabel(m.days)}<div class="muted small">${time}</div></td>
    <td class="hide-sm small">${m.volume != null ? m.volume + '%' : '—'}${m.shuffle === 'on' ? ' · shuffle' : ''}${m.atEnd === 'keep' ? ' · keeps playing' : ''}</td>
    <td><label class="toggle"><input type="checkbox" data-action="ms-toggle" data-id="${m.id}" ${m.enabled ? 'checked' : ''}><span></span></label></td>
    <td class="acts">
      <button class="btn sm" data-action="ms-run" data-id="${m.id}" title="Play this now">▶</button>
      <button class="btn sm" data-action="ms-edit" data-id="${m.id}">Edit</button>
      <button class="btn sm ghost" data-action="ms-dup" data-id="${m.id}" title="Duplicate">⧉</button>
      <button class="btn sm ghost danger-text" data-action="ms-delete" data-id="${m.id}" title="Delete">✕</button>
    </td>
  </tr>`;
}

VIEWS.music = () => {
  const sp = S.spotify || {};
  const head = `<header class="page-head"><div><h1>Music</h1><p class="sub">Control the church’s Spotify background music, start a playlist on any speaker, and schedule which playlist plays when. Videos with sound still pause the music automatically.</p></div>
    ${sp.connected ? '<button class="btn primary" data-action="ms-new">+ Schedule music</button>' : ''}</header>`;
  if (!sp.connected) return head + `<div class="grid">${emptyBox('Spotify isn’t connected yet', 'Connect the church’s Spotify account under Setup & backup → Background music (needs Spotify Premium).', '<a class="btn primary" href="#setup">Go to Setup</a>')}</div>`;
  if (spDevices === null) loadSpotifyLists();
  const ms = S.db.musicSchedules || [];
  return head + `
  <section class="card music" id="music-now">${musicNow()}</section>
  <section class="card">
    <div class="card-head"><h2>Play now</h2></div>
    ${spListErr ? `<div class="warn-line" style="margin-bottom:10px">⚠ ${esc(spListErr)}</div>` : ''}
    <form id="play-now" class="play-now">
      <label class="field"><span>Playlist</span><select name="uri">${spLists === null ? '<option>Loading your playlists…</option>' : playlistOptionsSp('')}</select></label>
      <label class="field" data-link ${spLists && spLists.length ? 'hidden' : ''}><span>Spotify link</span><input type="text" name="link" placeholder="https://open.spotify.com/playlist/…"><div class="hint">In Spotify: … → Share → Copy link. Playlists, albums and artists work.</div></label>
      <label class="field"><span>On</span><select name="device">${deviceOptions('')}</select></label>
      <label class="field small-field"><span>Volume</span><input type="number" name="volume" min="0" max="100" placeholder="as is"></label>
      <div class="field"><span class="field-label">&nbsp;</span><label class="check"><input type="checkbox" name="shuffle"> Shuffle</label></div>
      <button class="btn primary" type="submit">▶ Play</button>
    </form>
  </section>
  <section class="card">
    <div class="card-head"><h2>Music schedules this week</h2></div>
    ${weekView({ list: ms.filter((m) => m.enabled && m.uri), label: (m) => m.playlistName || '', color: musicColor, action: 'ms-edit', empty: 'No music is scheduled. Add a schedule to start a playlist automatically, e.g. a pre-service playlist every Sunday from 9:00 to 9:55.' })}
  </section>
  <section class="card">
    <div class="card-head"><h2>All music schedules</h2></div>
    ${ms.length ? `<table class="table"><thead><tr><th>Name</th><th>Playlist</th><th class="hide-sm">Device</th><th>When</th><th class="hide-sm">Volume</th><th>On</th><th></th></tr></thead>
      <tbody>${[...ms].sort((a, b) => b.priority - a.priority || toMin(a.startTime) - toMin(b.startTime)).map(msRow).join('')}</tbody></table>`
      : emptyBox('No music schedules yet', 'Example: “Pre-service”: every Sunday 9:00–9:55am, play the Sunday Welcome playlist on the Sound desk PC at 40%, then fade out.')}
    <p class="muted small" style="margin-top:10px">A schedule starts its playlist when it begins and, unless set to keep playing, fades the music out when it ends. In between, you can still change the music by hand. When schedules overlap, the higher priority wins.</p>
  </section>`;
};

AFTER.music = () => {
  const f = $('#play-now');
  if (f) {
    const sel = f.uri;
    const toggle = () => { $('[data-link]', f).hidden = sel.value !== '__link'; };
    sel.addEventListener('change', toggle);
    toggle();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const uri = sel.value === '__link' ? f.link.value : sel.value;
      const opt = f.device.selectedOptions[0];
      const body = { action: 'play-uri', uri, device: f.device.value ? { name: f.device.value, id: opt.dataset.id || '' } : null, shuffle: f.shuffle.checked, volume: f.volume.value };
      mutate(() => api('POST', '/api/spotify/music', body), 'Playing').catch(() => {});
    });
  }
  bindMusicNow();
};

function bindMusicNow() {
  const vol = $('#music-vol');
  if (!vol) return;
  let t;
  vol.addEventListener('input', () => {
    $('#music-vol-val').textContent = vol.value + '%';
    clearTimeout(t);
    t = setTimeout(() => api('POST', '/api/spotify/music', { action: 'volume', percent: +vol.value }).catch((e) => toast(e.message, 'error')), 250);
  });
}

function musicScheduleForm(m = {}) {
  const days = m.days || [0];
  return `
    <div class="grid2">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(m.name || '')}" placeholder="e.g. Sunday pre-service" required></label>
      <label class="field"><span>Play on</span><select name="device">${deviceOptions(m.deviceName || '')}</select><div class="hint">The device must have Spotify open when the schedule starts.</div></label>
    </div>
    ${spListErr ? `<div class="warn-line" style="margin-bottom:10px">⚠ ${esc(spListErr)}</div>` : ''}
    <label class="field"><span>Playlist</span><select name="uri">${playlistOptionsSp(m.uri || '')}</select></label>
    <label class="field" data-link hidden><span>Spotify link</span><input type="text" name="link" placeholder="https://open.spotify.com/playlist/…"></label>
    <div class="field"><span class="field-label">Days</span>
      <div class="chips">${WEEK_ORDER.map((d) => `<label class="chip"><input type="checkbox" name="days" value="${d}" ${days.includes(d) ? 'checked' : ''}><span>${DAY_NAMES[d]}</span></label>`).join('')}</div>
      <div class="row" style="margin-top:8px;gap:4px">
        <button type="button" class="btn sm ghost" data-days="0,1,2,3,4,5,6">Every day</button>
        <button type="button" class="btn sm ghost" data-days="1,2,3,4,5">Weekdays</button>
        <button type="button" class="btn sm ghost" data-days="0">Sundays</button>
      </div>
    </div>
    <div class="grid2">
      <label class="field"><span>Start time</span><input type="time" name="startTime" value="${esc(m.startTime || '09:00')}" required></label>
      <label class="field"><span>End time</span><input type="time" name="endTime" value="${esc(m.endTime || '09:55')}" required></label>
    </div>
    <div class="grid2">
      <label class="field"><span>From date <em class="muted">(optional)</em></span><input type="date" name="startDate" value="${esc(m.startDate || '')}"></label>
      <label class="field"><span>Until date <em class="muted">(optional)</em></span><input type="date" name="endDate" value="${esc(m.endDate || '')}"></label>
    </div>
    <div class="grid3">
      <label class="field"><span>Volume</span><input type="number" name="volume" min="0" max="100" value="${m.volume != null ? m.volume : ''}" placeholder="leave as is"><div class="hint">Fades in to this.</div></label>
      <label class="field"><span>Shuffle</span><select name="shuffle"><option value="">Leave as is</option><option value="on" ${m.shuffle === 'on' ? 'selected' : ''}>On</option><option value="off" ${m.shuffle === 'off' ? 'selected' : ''}>Off</option></select></label>
      <label class="field"><span>When it ends</span><select name="atEnd"><option value="pause">Fade out and stop</option><option value="keep" ${m.atEnd === 'keep' ? 'selected' : ''}>Keep playing</option></select></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Priority</span><input type="number" name="priority" value="${m.priority ?? 10}" step="1"><div class="hint">Higher wins when music schedules overlap.</div></label>
      <div class="field"><span class="field-label">Status</span><label class="check"><input type="checkbox" name="enabled" ${m.enabled !== false ? 'checked' : ''}> Enabled</label></div>
    </div>`;
}

async function musicScheduleBody(f) {
  const v = fd(f);
  const days = checkedValues(f, 'days').map(Number);
  if (!days.length) throw new Error('Pick at least one day');
  let uri = v.uri, playlistName;
  if (uri === '__link') {
    if (!v.link.trim()) throw new Error('Paste a Spotify link, or choose a playlist');
    const d = await api('POST', '/api/spotify/describe', { uri: v.link });
    uri = d.uri; playlistName = d.name;
  } else {
    const p = (spLists || []).find((x) => x.uri === uri);
    playlistName = p ? p.name : undefined;
  }
  const opt = f.device.selectedOptions[0];
  const body = { name: v.name, uri, deviceName: v.device, deviceId: v.device ? opt.dataset.id || '' : '', days, startTime: v.startTime, endTime: v.endTime, startDate: v.startDate, endDate: v.endDate, volume: v.volume, shuffle: v.shuffle, atEnd: v.atEnd, priority: +v.priority || 0, enabled: f.enabled.checked };
  if (playlistName !== undefined) body.playlistName = playlistName;
  if (v.startDate && v.endDate && v.endDate < v.startDate) throw new Error('The until date is before the from date');
  return body;
}

function openMusicSchedule(m, { copy = false } = {}) {
  const editing = m && m.id && !copy;
  const md = modal({
    title: editing ? 'Edit music schedule' : 'Schedule music', wide: true, body: musicScheduleForm(copy ? { ...m, name: m.name + ' (copy)' } : m || {}), saveLabel: editing ? 'Save' : 'Add schedule',
    onSave: async (f) => {
      const body = await musicScheduleBody(f);
      if (!body.playlistName && !editing) body.playlistName = (spLists || []).find((x) => x.uri === body.uri)?.name || '';
      await mutate(() => (editing ? api('PUT', '/api/musicSchedules/' + m.id, body) : api('POST', '/api/musicSchedules', body)), editing ? 'Saved' : 'Music schedule added');
    },
  });
  const sel = md.form.uri;
  const toggle = () => { $('[data-link]', md.form).hidden = sel.value !== '__link'; };
  sel.addEventListener('change', toggle);
  toggle();
}

/* ---------- Users (administrators only) ---------- */

function fmtWhen(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

VIEWS.users = () => {
  const users = S.users || [];
  return `<header class="page-head">
    <div><h1>Users</h1><p class="sub">Give each person their own sign-in. <b>Administrators</b> can do everything. <b>Editors</b> can only upload and create content, and edit the playlists you tick for them. They can’t see screens, schedules, music, settings or other users.</p></div>
    <button class="btn primary" data-action="user-new">+ Add user</button>
  </header>
  <section class="card">
    <table class="table">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th class="hide-sm">Can edit</th><th class="hide-sm">Last sign-in</th><th></th></tr></thead>
      <tbody>${users.map((u) => {
        const pls = u.role === 'admin' ? 'Everything' : (u.playlists || []).map((id) => playlist(id)?.name).filter(Boolean);
        return `<tr class="${u.disabled ? 'off' : ''}">
          <td><b>${esc(u.name)}</b>${u.id === S.me.id ? ' <span class="badge default">You</span>' : ''}${u.disabled ? ' <span class="badge">Disabled</span>' : ''}</td>
          <td><code>${esc(u.username)}</code></td>
          <td>${u.role === 'admin' ? '<span class="badge role-admin">Administrator</span>' : '<span class="badge live">Editor</span>'}</td>
          <td class="hide-sm small">${Array.isArray(pls) ? (pls.length ? esc(pls.join(', ')) : '<span class="muted">No playlists yet</span>') : pls}</td>
          <td class="hide-sm small muted">${u.builtin ? 'Password set on the server' : fmtWhen(u.lastLogin)}</td>
          <td class="acts">${u.builtin ? '<span class="muted small">Built-in recovery account</span>' : `<button class="btn sm" data-action="user-edit" data-id="${u.id}">Edit</button>${u.id === S.me.id ? '' : `<button class="btn sm ghost danger-text" data-action="user-delete" data-id="${u.id}" title="Delete">✕</button>`}`}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <p class="muted small" style="margin-top:12px">After ${5} wrong passwords in a row, sign-in is paused for 30 seconds. Changing someone’s password, role or disabling them signs them out everywhere straight away.${S.info.builtinAdmin ? ' The built-in <code>admin</code> account uses the password set on the server (ADMIN_PASSWORD). Keep it as a recovery login.' : ''}</p>
  </section>`;
};

function userForm(u = {}) {
  const isNew = !u.id;
  const self = u.id && u.id === S.me.id;
  return `
    <div class="grid2">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(u.name || '')}" placeholder="e.g. Sarah (Kids team)"></label>
      <label class="field"><span>Username</span><input type="text" name="username" value="${esc(u.username || '')}" ${isNew ? '' : 'disabled'} autocapitalize="none" spellcheck="false" placeholder="e.g. sarah" required>${isNew ? '<div class="hint">Letters, numbers, dots or dashes. Can’t be changed later.</div>' : ''}</label>
    </div>
    <div class="grid2">
      <label class="field"><span>${isNew ? 'Password' : 'New password'}</span><input type="password" name="password" autocomplete="new-password" placeholder="${isNew ? 'At least 8 characters' : 'Leave blank to keep the current one'}"></label>
      <label class="field"><span>Role</span><select name="role" ${self ? 'disabled' : ''}>
        <option value="editor">Editor: content and chosen playlists only</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator: everything</option></select>
        ${self ? '<div class="hint">You can’t change your own role.</div>' : ''}</label>
    </div>
    <div class="field" data-playlists ${u.role === 'admin' ? 'hidden' : ''}><span class="field-label">Playlists they can edit</span>
      ${S.db.playlists.length ? `<div class="chips">${S.db.playlists.map((p) => `<label class="chip"><input type="checkbox" name="playlists" value="${p.id}" ${(u.playlists || []).includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('')}</div>` : '<p class="muted small">No playlists yet.</p>'}
      <div class="hint">They can reorder, add and remove items, change timings, and add their own uploads to these. They can’t create or delete playlists.</div></div>
    ${isNew || self ? '' : `<div class="field"><span class="field-label">Status</span><label class="check"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''}> Disabled (can’t sign in)</label></div>`}`;
}

function openUserForm(u) {
  const isNew = !u;
  const m = modal({
    title: isNew ? 'Add user' : `Edit ${u.name}`, wide: true, body: userForm(u || {}), saveLabel: isNew ? 'Add user' : 'Save',
    onSave: async (f) => {
      const body = { name: f.name.value, role: f.role.value, playlists: checkedValues(f, 'playlists') };
      if (f.password.value) body.password = f.password.value;
      if (f.disabled) body.disabled = f.disabled.checked;
      if (isNew) {
        body.username = f.username.value;
        if (!body.password) throw new Error('Give them a password (at least 8 characters)');
        await mutate(() => api('POST', '/api/users', body), `Added ${body.name || body.username}. Give them their username and password.`);
      } else {
        if (u.id === S.me.id) delete body.role;
        await mutate(() => api('PUT', '/api/users/' + u.id, body), 'Saved');
      }
    },
  });
  m.form.role.addEventListener('change', () => { $('[data-playlists]', m.form).hidden = m.form.role.value === 'admin'; });
}

/* ---------- Setup ---------- */

VIEWS.setup = () => {
  const base = serverBase();
  return `
  <header class="page-head"><div><h1>Setup &amp; backup</h1><p class="sub">How to connect TVs, keep the server running, and back up your content.</p></div></header>

  <section class="card">
    <h2 style="margin-bottom:10px">Connect a screen</h2>
    <ol class="steps">
      <li>Add the screen on the <a href="#screens">Screens</a> page.</li>
      <li>On the device driving the TV (mini PC, Raspberry Pi, smart TV browser, Fire Stick with a browser, Chromebox…), open:<pre>${esc(base)}/player</pre>and pick the screen. The device remembers its choice. Or open the screen’s own link directly.</li>
      <li>Make the browser full-screen (F11), or better, use kiosk mode so it starts by itself after a power cut (below).</li>
      <li>Use <b>Identify</b> on the Screens page to check you’ve got the right TV.</li>
    </ol>
    <p class="muted small">The server address must stay the same — give this computer a fixed IP (a “DHCP reservation” on your router). Server addresses found: ${S.info.ips.map((ip) => `<code>${esc(ip)}</code>`).join(', ') || 'none'} · port <code>${S.info.port}</code>.</p>
  </section>

  <section class="card">
    <h2 style="margin-bottom:10px">Kiosk mode (recommended)</h2>
    <p class="small">Starts full-screen with no address bar, and allows video sound to autoplay.</p>
    <b class="small">Windows — make a shortcut in the Startup folder (Win+R → <code>shell:startup</code>) with target:</b>
    <pre>"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble --disable-infobars ${esc(base)}/player</pre>
    <b class="small">Raspberry Pi / Linux:</b>
    <pre>chromium-browser --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble --check-for-update-interval=31536000 ${esc(base)}/player</pre>
    <p class="muted small">Press Alt+F4 to exit kiosk mode. To make a device choose a different screen, open <code>/player?pick</code>.</p>
  </section>

  ${brandingCard()}

  ${foldersCard()}

  ${spotifyCard()}

  <section class="card">
    <h2 style="margin-bottom:10px">Screen links</h2>
    ${S.db.screens.length ? S.db.screens.map((s) => `<div class="row" style="margin-bottom:8px"><b style="min-width:160px">${esc(s.name)}</b><div class="linkbox grow"><code>${esc(playerUrl(s.id))}</code><button class="btn sm ghost" data-action="copy" data-text="${esc(playerUrl(s.id))}">Copy</button></div></div>`).join('') : '<p class="muted">No screens yet.</p>'}
  </section>

  <section class="card">
    <h2 style="margin-bottom:10px">Backup &amp; restore</h2>
    <p class="small">The backup file holds your screens, playlists, schedules and slides. Uploaded images and videos live in the <code>data/uploads</code> folder on the server — copy that folder too for a full backup.</p>
    <div class="row">
      <a class="btn primary" href="/api/export" download>Download backup</a>
      <label class="btn">Restore from backup…<input type="file" id="import-file" accept="application/json,.json" hidden></label>
    </div>
  </section>

  <section class="card">
    <h2 style="margin-bottom:10px">Security</h2>
    <p class="small">Everyone signs in with their own account. Manage accounts on the <a href="#users">Users</a> page. After 5 wrong passwords in a row, sign-in pauses for 30 seconds. ${S.info.builtinAdmin ? 'The built-in <code>admin</code> recovery login is on (its password is set on the server).' : 'There’s no built-in recovery login; set <code>ADMIN_PASSWORD</code> on the server if you want one.'} TV player links never need to sign in.</p>
  </section>`;
};
AFTER.setup = () => {
  $('#logo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    mutate(async () => {
      const r = await fetch('/api/branding/logo', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Signage': '1' }, body: file });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
    }, 'Logo updated. TVs pick it up within a few seconds.').catch(() => {});
  });
  $('#folders-root-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    mutate(() => api('POST', '/api/settings', { foldersDir: e.target.foldersDir.value }), 'Drop folders location saved').catch(() => {});
  });
  $('#sp-connect')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/spotify/settings', { clientId: e.target.clientId.value });
      const { url } = await api('POST', '/api/spotify/login');
      const onServer = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
      if (onServer) { location.href = url; return; }
      window.open(url, '_blank', 'noopener');
      $('#sp-paste').classList.remove('hidden');
      $('#sp-paste-form input').focus();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#sp-paste-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    mutate(() => api('POST', '/api/spotify/paste', { url: e.target.url.value }), 'Spotify connected').catch(() => {});
  });
  $('#sp-settings')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    mutate(() => api('POST', '/api/spotify/settings', { enabled: f.enabled.checked, mode: f.mode.value, duckPercent: f.duckPercent.value, fadeSeconds: f.fadeSeconds.value, resumeDelaySeconds: f.resumeDelaySeconds.value }), 'Music settings saved').catch(() => {});
  });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!(await confirmBox('Restore backup?', 'This replaces all screens, playlists, schedules and slides with the contents of the backup file.', 'Restore'))) return;
    try {
      const data = JSON.parse(await file.text());
      await mutate(() => api('POST', '/api/import', data), 'Backup restored');
    } catch (err) { if (err instanceof SyntaxError) toast('That file is not valid JSON', 'error'); }
  });
};

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ACTIONS = {
  copy: (d) => copy(d.text),

  'screen-new': () => modal({
    title: 'Add screen', body: screenForm({ defaultPlaylistId: S.db.playlists[0]?.id }), saveLabel: 'Add screen',
    onSave: (f) => mutate(() => api('POST', '/api/screens', screenBody(f)), 'Screen added — now open its link on the TV'),
  }),
  'screen-edit': (d) => {
    const s = screen(d.id);
    modal({ title: 'Edit screen', body: screenForm(s), onSave: (f) => mutate(() => api('PUT', '/api/screens/' + s.id, screenBody(f)), 'Saved') });
  },
  'screen-delete': async (d) => {
    const s = screen(d.id);
    if (await confirmBox('Delete screen?', `Delete <b>${esc(s.name)}</b>? The TV showing it will go back to the “Which screen is this?” picker.`)) mutate(() => api('DELETE', '/api/screens/' + s.id), 'Screen deleted');
  },
  'screen-identify': (d) => mutate(() => api('POST', `/api/screens/${d.id}/identify`), 'Showing the screen name on that TV for 15 seconds'),

  'sp-control': (d) => mutate(() => api('POST', '/api/spotify/control', { action: d.a }), d.a === 'test' ? 'Pausing the music for 10 seconds…' : d.a === 'resume-now' ? 'Music resumed' : '').catch(() => {}),
  'sp-disconnect': async () => {
    if (await confirmBox('Disconnect Spotify?', 'The signage will stop pausing the music for videos. You can connect again at any time.', 'Disconnect')) mutate(() => api('POST', '/api/spotify/disconnect'), 'Spotify disconnected');
  },

  'pl-folder': () => {
    const m = modal({
      title: plDraft.folder ? 'Drop folder settings' : 'Fill this playlist from a folder', body: folderSettingsForm(plDraft.folder || {}), saveLabel: 'Use this folder',
      onSave: async (f) => {
        const v = fd(f);
        let name = v.name;
        if (!name) {
          if (!v.newName.trim()) throw new Error('Give the new folder a name');
          name = (await mutate(() => api('POST', '/api/folders', { name: v.newName }))).name;
        }
        // The link is saved straight away (separately from other edits), so leaving the page can't lose it.
        await mutate(() => api('PUT', `/api/playlists/${plDraft.id}/folder`, { folder: { name, position: v.position, imageSeconds: Math.max(1, +v.imageSeconds || 10), fit: v.fit } }), `Linked to the “${name}” folder. Its files are being added.`);
        afterFolderChange();
      },
    });
    const sel = $('select[name=name]', m.form);
    sel.addEventListener('change', () => { $('[data-newname]', m.form).hidden = !!sel.value; if (!sel.value) $('input[name=newName]', m.form).focus(); });
  },
  'pl-folder-stop': async () => {
    if (!(await confirmBox('Unlink the folder?', `New files dropped into “${esc(plDraft.folder.name)}” will no longer be added to this playlist. Items already added stay.`, 'Unlink'))) return;
    await mutate(() => api('PUT', `/api/playlists/${plDraft.id}/folder`, { folder: null }), 'Folder unlinked');
    afterFolderChange();
  },
  'folder-new': () => modal({
    title: 'New drop folder', saveLabel: 'Create folder',
    body: `<label class="field"><span>Folder name</span><input type="text" name="name" placeholder="e.g. Foyer notices" required></label><div class="hint">Created in ${esc(S.folders ? S.folders.root : '')}</div>`,
    onSave: (f) => mutate(() => api('POST', '/api/folders', { name: fd(f).name }), 'Folder created'),
  }),

  'logo-remove': async () => {
    if (await confirmBox('Go back to the ENJOY Signage wordmark?', 'The uploaded logo is removed and the admin panel and TVs show the ENJOY Signage wordmark again.', 'Use ENJOY Signage')) mutate(() => api('DELETE', '/api/branding/logo'), 'Back to the ENJOY Signage wordmark');
  },

  'm-shuffle': (d) => mutate(() => api('POST', '/api/spotify/music', { action: 'shuffle', state: d.state === '1' })).catch(() => {}),
  'm-repeat': (d) => mutate(() => api('POST', '/api/spotify/music', { action: 'repeat', state: d.state })).catch(() => {}),
  'm-stop': () => mutate(() => api('POST', '/api/spotify/music', { action: 'stop' }), 'Music faded out').catch(() => {}),
  'm-transfer': () => {
    const sel = $('#m-device');
    if (!sel.value) return toast('Choose a device first', 'error');
    mutate(() => api('POST', '/api/spotify/music', { action: 'transfer', device: { name: sel.value, id: sel.selectedOptions[0].dataset.id || '' } }), 'Music moved to ' + sel.value).catch(() => {});
  },
  'm-refresh': () => { spDevices = null; loadSpotifyLists(true); toast('Refreshing devices and playlists…'); },
  'ms-new': () => openMusicSchedule(null),
  'ms-edit': (d) => openMusicSchedule((S.db.musicSchedules || []).find((x) => x.id === d.id)),
  'ms-dup': (d) => openMusicSchedule((S.db.musicSchedules || []).find((x) => x.id === d.id), { copy: true }),
  'ms-run': (d) => mutate(() => api('POST', `/api/musicSchedules/${d.id}/run`), 'Playing').catch(() => {}),
  'ms-toggle': (d, el) => mutate(() => api('PUT', '/api/musicSchedules/' + d.id, { enabled: el.checked }), el.checked ? 'Music schedule on' : 'Music schedule off'),
  'ms-delete': async (d) => {
    const m = (S.db.musicSchedules || []).find((x) => x.id === d.id);
    if (await confirmBox('Delete music schedule?', `Delete <b>${esc(m.name)}</b>?`)) mutate(() => api('DELETE', '/api/musicSchedules/' + m.id), 'Deleted');
  },

  'user-new': () => openUserForm(null),
  'user-edit': (d) => openUserForm((S.users || []).find((x) => x.id === d.id)),
  'user-delete': async (d) => {
    const u = (S.users || []).find((x) => x.id === d.id);
    if (await confirmBox('Delete user?', `Delete <b>${esc(u.name)}</b> (${esc(u.username)})? They’ll be signed out straight away. Content they uploaded stays.`)) mutate(() => api('DELETE', '/api/users/' + u.id), 'User deleted');
  },
  'me-signout': async (d, el, e) => {
    e.preventDefault();
    await api('POST', '/api/logout').catch(() => {});
    location.replace('/login');
  },
  'me-password': (d, el, e) => {
    e.preventDefault();
    if (S.me.builtin) return toast('The built-in admin password is set on the server (ADMIN_PASSWORD).', 'error');
    modal({
      title: 'Change your password', saveLabel: 'Change password',
      body: `<label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" placeholder="At least 8 characters" required></label>
        <label class="field"><span>New password again</span><input type="password" name="password2" autocomplete="new-password" required></label>
        <div class="hint">Other devices you’re signed in on will be signed out.</div>`,
      onSave: async (f) => {
        if (f.password.value !== f.password2.value) throw new Error('The new passwords don’t match');
        await api('POST', '/api/me/password', { current: f.current.value, password: f.password.value });
        toast('Password changed');
      },
    });
  },

  'override-stop': (d) => mutate(() => api('DELETE', '/api/overrides/' + d.id), 'Takeover stopped'),

  'media-new': (d) => modal({
    title: { text: 'New text slide', countdown: 'New countdown', web: 'Add web page or YouTube video' }[d.type],
    body: mediaForm(d.type), saveLabel: 'Add to library',
    onSave: (f) => {
      const v = fd(f);
      if (!v.name) v.name = v.title || v.url || TYPE_LABEL[d.type];
      return mutate(() => api('POST', '/api/media', { ...v, type: d.type }), 'Added to media');
    },
  }),
  'media-edit': (d) => {
    const m = media(d.id);
    modal({ title: 'Edit ' + TYPE_LABEL[m.type].toLowerCase(), body: mediaForm(m.type, m), onSave: (f) => mutate(() => api('PUT', '/api/media/' + m.id, fd(f)), 'Saved') });
  },
  'media-delete': async (d) => {
    const m = media(d.id);
    const used = usage(m.id);
    const msg = `Delete <b>${esc(m.name)}</b>?` + (used.length ? ` It will be removed from: ${used.map((p) => esc(p.name)).join(', ')}.` : '') + (m.folderName ? ` <br><br>This also deletes <b>${esc(m.folderFile)}</b> from the “${esc(m.folderName)}” drop folder. To just take it out of one playlist, use ✕ in that playlist instead.` : '');
    if (await confirmBox('Delete media?', msg)) mutate(() => api('DELETE', '/api/media/' + m.id), 'Deleted');
  },

  'pl-new': () => {
    if (plDirty && !confirm('Discard unsaved changes to this playlist?')) return;
    modal({
      title: 'New playlist', body: `<label class="field"><span>Name</span><input type="text" name="name" placeholder="e.g. Foyer loop, Sunday service, Kids" required></label>`, saveLabel: 'Create',
      onSave: async (f) => {
        const p = await mutate(() => api('POST', '/api/playlists', { name: fd(f).name, items: [] }));
        selectedPl = p.id; plDraft = null; plDirty = false;
        render();
      },
    });
  },
  'pl-select': (d, el, e) => {
    e.preventDefault();
    if (d.id === selectedPl) return;
    if (plDirty && !confirm('Discard unsaved changes to this playlist?')) return;
    selectedPl = d.id; plDraft = null; plDirty = false;
    render();
  },
  'pl-move': (d) => {
    const i = +d.idx, j = i + +d.dir;
    const items = plDraft.items;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    setDirty(); rerenderItems();
  },
  'pl-remove': (d) => {
    const m = media(plDraft.items[+d.idx]?.mediaId);
    plDraft.items.splice(+d.idx, 1); setDirty(); rerenderItems();
    if (m && m.folderName && plDraft.folder && plDraft.folder.name === m.folderName) toast('Removed from this playlist only. The file stays in the folder and won’t be added again.');
  },
  'pl-add': () => {
    if (!S.db.media.length) { toast('Your media library is empty — upload or create something first', 'error'); location.hash = 'media'; return; }
    const order = [];
    const list = [...S.db.media].sort((a, b) => b.createdAt - a.createdAt);
    const m = modal({
      title: 'Add content', wide: true, saveLabel: 'Add selected',
      body: `<input type="search" id="pick-q" placeholder="Search…" style="margin-bottom:12px"><div class="picker-grid">${list.map((x) => `<label class="pick" data-name="${esc((x.name + ' ' + (x.title || '')).toLowerCase())}"><input type="checkbox" value="${x.id}"><span class="order"></span>${thumb(x)}<div class="name">${esc(x.name)}</div></label>`).join('')}</div>`,
      onSave: () => {
        if (!order.length) throw new Error('Select at least one item');
        order.forEach((id) => plDraft.items.push({ id: Math.random().toString(36).slice(2, 12), mediaId: id, duration: null, fit: 'contain' }));
        setDirty(); rerenderItems();
      },
    });
    m.form.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.value;
      const k = order.indexOf(id);
      if (e.target.checked && k < 0) order.push(id);
      if (!e.target.checked && k >= 0) order.splice(k, 1);
      $$('.pick', m.form).forEach((p) => { const n = order.indexOf($('input', p).value); $('.order', p).textContent = n >= 0 ? n + 1 : ''; });
    });
    $('#pick-q', m.form).addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('.pick', m.form).forEach((p) => p.classList.toggle('hidden', !!q && !p.dataset.name.includes(q)));
    });
  },
  'pl-save': async () => {
    const id = plDraft.id;
    // loadedAt lets the server keep folder files that arrived after this copy was loaded. The folder link isn't sent:
    // it's only ever changed through the folder dialog.
    await mutate(() => api('PUT', '/api/playlists/' + id, { name: plDraft.name, transition: plDraft.transition, playOnce: !!plDraft.playOnce, sync: plDraft.sync !== false, music: plDraft.music, items: plDraft.items, loadedAt: plDraft._loadedAt }), 'Playlist saved — screens update within a few seconds');
    plDraft = loadDraft(id);
    plDirty = false;
    render();
  },
  'pl-preview': (d, el, e) => {
    if (plDirty) { e.preventDefault(); toast('Save your changes first, then preview', 'error'); }
  },
  'pl-duplicate': async () => {
    if (plDirty) return toast('Save your changes first', 'error');
    const p = await mutate(() => api('POST', '/api/playlists', { name: plDraft.name + ' (copy)', transition: plDraft.transition, playOnce: !!plDraft.playOnce, sync: plDraft.sync !== false, music: plDraft.music, folder: plDraft.folder || null, items: plDraft.items.map((i) => ({ ...i, id: undefined })) }), 'Duplicated');
    selectedPl = p.id; plDraft = null; render();
  },
  'pl-delete': async () => {
    const p = playlist(plDraft.id);
    const sch = S.db.schedules.filter((s) => s.playlistId === p.id).length;
    if (await confirmBox('Delete playlist?', `Delete <b>${esc(p.name)}</b>?${sch ? ` ${sch} schedule${sch > 1 ? 's' : ''} using it will be turned off.` : ''} Your media stays in the library.`)) {
      plDirty = false; plDraft = null; selectedPl = null;
      mutate(() => api('DELETE', '/api/playlists/' + p.id), 'Playlist deleted');
    }
  },

  'sched-new': () => modal({
    title: 'Add schedule', body: schedForm({ playlistId: S.db.playlists[0]?.id, days: [0], startTime: '09:30', endTime: '12:00' }), saveLabel: 'Add schedule',
    onSave: (f) => mutate(() => api('POST', '/api/schedules', schedBody(f)), 'Schedule added'),
  }),
  'sched-edit': (d) => {
    const s = S.db.schedules.find((x) => x.id === d.id);
    modal({ title: 'Edit schedule', body: schedForm(s), onSave: (f) => mutate(() => api('PUT', '/api/schedules/' + s.id, schedBody(f)), 'Saved') });
  },
  'sched-dup': (d) => {
    const s = S.db.schedules.find((x) => x.id === d.id);
    modal({ title: 'Duplicate schedule', body: schedForm({ ...s, name: s.name + ' (copy)' }), saveLabel: 'Create copy', onSave: (f) => mutate(() => api('POST', '/api/schedules', schedBody(f)), 'Schedule added') });
  },
  'sched-delete': async (d) => {
    const s = S.db.schedules.find((x) => x.id === d.id);
    if (await confirmBox('Delete schedule?', `Delete <b>${esc(s.name)}</b>?`)) mutate(() => api('DELETE', '/api/schedules/' + s.id), 'Deleted');
  },
  'sched-toggle': (d, el) => mutate(() => api('PUT', '/api/schedules/' + d.id, { enabled: el.checked }), el.checked ? 'Schedule on' : 'Schedule off'),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.type === 'checkbox') return; // handled on change
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el.dataset, el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('input[type=checkbox][data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el.dataset, el, e);
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'takeover-form') return;
  e.preventDefault();
  const f = e.target;
  const body = { playlistId: f.playlistId.value, allScreens: f.allScreens.checked, screenIds: checkedValues(f, 'screenIds'), minutes: +f.minutes.value };
  mutate(() => api('POST', '/api/overrides', body), 'Takeover started — screens switch within 5 seconds').catch(() => {});
});

window.addEventListener('hashchange', () => {
  const next = (location.hash || '#screens').slice(1);
  if (next === tab) return;
  if (tab === 'playlists' && plDirty && !confirm('Discard unsaved changes to this playlist?')) { location.hash = tab; return; }
  if (tab === 'playlists') { plDirty = false; plDraft = null; }
  tab = next;
  render();
  window.scrollTo(0, 0);
});

/* Live status: refresh the screens page every 5 seconds (only when nobody is typing in a form). */
async function tick() {
  try {
    await refresh();
    applyBranding();
    const busy = $('.modal-back') || (document.activeElement && document.activeElement.closest('form, .takeover-form'));
    if (tab === 'screens' && !busy) render();
    else if (tab === 'music' && !busy && $('#music-now') && !document.activeElement?.closest('#music-now')) {
      $('#music-now').innerHTML = musicNow();
      bindMusicNow();
    }
    else if (tab === 'playlists' && plDraft && !busy) {
      // Files arriving from a drop folder change the saved playlist on the server. Show them straight
      // away if nothing is being edited; otherwise just say they'll be merged on save.
      const server = playlist(plDraft.id);
      const { _loadedAt, ...draftData } = plDraft;
      if (server && !plDirty && JSON.stringify(server) !== JSON.stringify(draftData) && !document.activeElement?.closest('#pl-editor')) {
        plDraft = loadDraft(server.id);
        $('#pl-editor').innerHTML = plEditor();
        bindPlEditor();
        $('.pl-list') && ($('.pl-list').outerHTML = $('.pl-list', (() => { const d = document.createElement('div'); d.innerHTML = VIEWS.playlists(); return d; })()).outerHTML);
      } else if ($('#pl-folder-box')) {
        const html = folderBar(plDraft);
        if ($('#pl-folder-box').innerHTML !== html) $('#pl-folder-box').innerHTML = html;
      }
    } else if (tab === 'setup' && !busy && $('#folders-list')) {
      const tmp = document.createElement('div'); tmp.innerHTML = foldersCard();
      const html = $('#folders-list', tmp).innerHTML;
      if ($('#folders-list').innerHTML !== html) $('#folders-list').innerHTML = html;
    }
    else renderSideFoot();
  } catch {}
  setTimeout(tick, 5000);
}

(async () => {
  try {
    await refresh();
    render();
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><h2>Can’t reach the signage server</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
  setTimeout(tick, 5000);
})();
