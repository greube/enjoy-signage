'use strict';
/**
 * TV power: pairing TVs, switching them on and off, and power schedules.
 *
 * The talking-to-the-TV part is in tvpower.js (Google TV remote protocol). This file keeps track of:
 *  - pairings and this server's own certificate, in DATA_DIR/tvs.json (not in backups: a pairing
 *    belongs to this computer, so a restored backup on another computer pairs again)
 *  - what each TV last said (on / standby / can't reach), checked every couple of minutes
 *  - one command at a time per TV, so a schedule and a button press can't cross over
 *  - power schedules. Like music schedules, they only act at their on and off moments, so anyone can
 *    still switch a TV by hand in between. A moment missed while the server was off is caught up when
 *    it starts (only the latest one counts). A TV that can't be reached is retried every minute for an
 *    hour.
 */
const fs = require('fs');
const path = require('path');
const tv = require('./tvpower');

const MIN = 60000;

function createTvs({ dataDir, getScreens, getSchedules, isActive, log = console, now = () => Date.now(), pollMs = 2 * MIN, tickMs = 5000, retryMs = MIN, giveUpMs = 60 * MIN }) {
  const FILE = path.join(dataDir, 'tvs.json');
  let cfg = { identity: null, paired: {}, applied: {} };
  try {
    cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') log.error(`! tvs.json could not be read (${e.message}); the TVs need pairing again.`);
  }
  const save = () => {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };
  const identity = () => {
    if (!cfg.identity) { cfg.identity = tv.createIdentity(); save(); }
    return cfg.identity;
  };

  const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
  const screenById = (id) => getScreens().find((s) => s.id === id);
  const hostOf = (id) => ((screenById(id) || {}).tvHost || '').trim();
  const live = {};     // host -> { on, app, model, vendor, checkedAt, error, busy }
  const last = {};     // screenId -> { text, at, error } : the latest thing that happened, for the admin panel
  const note = (screenId, text, error = false) => { last[screenId] = { text, at: now(), error }; };
  const L = (host) => (live[host] = live[host] || {});

  /* One command at a time per TV. */
  const chains = {};
  function serial(host, fn) {
    const p = (chains[host] || Promise.resolve()).then(fn);
    chains[host] = p.catch(() => {});
    return p;
  }

  async function check(host) {
    return serial(host, async () => {
      try {
        const s = await tv.status(host, identity());
        Object.assign(L(host), s, { checkedAt: now(), error: '' });
        const p = cfg.paired[host];
        const model = [s.vendor, s.model].filter(Boolean).join(' ');
        if (p && model && p.model !== model) { p.model = model; save(); }
      } catch (e) {
        Object.assign(L(host), { on: null, checkedAt: now(), error: e.message });
      }
      return L(host);
    });
  }

  /** Switch one screen's TV on or off. `why` is shown in the admin panel. */
  async function power(screenId, on, why = '') {
    const host = hostOf(screenId);
    if (!host) throw httpErr(400, 'This screen has no TV set up. Edit the screen’s TV power settings first.');
    if (!cfg.paired[host]) throw httpErr(400, 'This TV isn’t paired yet.');
    return serial(host, async () => {
      const st = L(host);
      st.busy = on ? 'on' : 'off';
      try {
        const r = await tv.setPower(host, identity(), on);
        Object.assign(st, { on: r.on, checkedAt: now(), error: '' });
        note(screenId, `${r.changed ? 'Switched' : 'Already'} ${on ? 'on' : 'off'}${why ? ` (${why})` : ''}`);
        return r;
      } catch (e) {
        Object.assign(st, { checkedAt: now(), error: e.message });
        note(screenId, `Couldn’t switch ${on ? 'on' : 'off'}${why ? ` (${why})` : ''}: ${e.message}`, true);
        throw Object.assign(e, { status: e.status || 502 });
      } finally { st.busy = ''; }
    });
  }

  /* ---------------- pairing, across two requests: start (TV shows a code), then the code ---------------- */

  const sessions = {}; // screenId -> { host, giveCode, cancel, notify, done, timer }

  function pairCancel(screenId) {
    const s = sessions[screenId];
    if (!s) return;
    delete sessions[screenId];
    clearTimeout(s.timer);
    if (s.cancel) s.cancel(new tv.Fail('Pairing was cancelled.'));
  }

  async function pairStart(screenId, host) {
    host = String(host || '').trim();
    if (!/^[a-z0-9.\-]{1,253}$/i.test(host)) throw httpErr(400, 'Type the TV’s address, e.g. 192.168.1.50 (Settings → Network on the TV).');
    pairCancel(screenId);
    const s = { host };
    sessions[screenId] = s;
    let shown;
    const codeShown = new Promise((res) => (shown = res));
    const ask = (problem) => new Promise((resolve, reject) => {
      s.giveCode = resolve;
      s.cancel = reject;
      if (problem) { if (s.notify) s.notify({ problem }); } else shown();
    });
    s.done = tv.pair(host, identity(), ask);
    s.done.catch(() => {});
    s.timer = setTimeout(() => pairCancel(screenId), 5 * MIN);
    try {
      await Promise.race([codeShown, s.done]);
    } catch (e) {
      if (sessions[screenId] === s) { delete sessions[screenId]; clearTimeout(s.timer); }
      throw httpErr(502, e.message);
    }
    return { waiting: true };
  }

  async function pairCode(screenId, code) {
    const s = sessions[screenId];
    if (!s || !s.giveCode) throw httpErr(400, 'That pairing has expired. Press Pair again for a new code.');
    const outcome = new Promise((res) => (s.notify = res));
    const give = s.giveCode;
    s.giveCode = null;
    give(String(code || ''));
    let r;
    try {
      r = await Promise.race([outcome, s.done.then(() => ({ ok: true }))]);
    } catch (e) {
      if (sessions[screenId] === s) { delete sessions[screenId]; clearTimeout(s.timer); }
      throw httpErr(400, e.message);
    }
    if (r.problem) return { ok: false, problem: r.problem };
    delete sessions[screenId];
    clearTimeout(s.timer);
    cfg.paired[s.host] = { at: now() };
    delete cfg.applied[screenId]; // schedules act from now on, not on moments before pairing
    save();
    note(screenId, 'Paired');
    await check(s.host);
    return { ok: true };
  }

  /** Forget a screen's TV pairing (when its TV address is cleared or the screen is deleted). */
  function forget(screenId, host = hostOf(screenId)) {
    pairCancel(screenId);
    delete cfg.applied[screenId];
    delete last[screenId];
    const stillUsed = getScreens().some((x) => x.id !== screenId && (x.tvHost || '').trim() === host);
    if (host && !stillUsed) { delete cfg.paired[host]; delete live[host]; }
    save();
  }

  /* ---------------- power schedules ---------------- */

  const targets = (s, screenId) => !!s.allScreens || (s.screenIds || []).includes(screenId);
  const schedulesFor = (screenId) => getSchedules().filter((s) => s.enabled && targets(s, screenId));
  const want = (list, t) => list.some((s) => isActive(s, new Date(t)));
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };

  /** Every moment from `fromDay` to `toDay` (days from today) at which one of these schedules starts or ends. */
  function boundaries(list, fromDay, toDay) {
    const out = [];
    const today = new Date(now());
    for (const s of list) {
      const st = toMin(s.startTime), en = toMin(s.endTime);
      if (st == null || en == null) continue;
      for (let d = fromDay; d <= toDay; d++) {
        const at = (dayOffset, mins) => {
          const h = Math.floor(mins / 60), m = mins % 60;
          const t = new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h, m);
          // A time that doesn't exist on the night the clocks go forward (e.g. 2:30am): the change
          // happens at the moment the clocks jump, the start of the next hour.
          if (t.getHours() !== h % 24 || t.getMinutes() !== m) return new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, h + 1, 0).getTime();
          return t.getTime();
        };
        if (st === en) out.push({ t: at(d, 0), s }, { t: at(d + 1, 0), s });
        else out.push({ t: at(d, st), s }, { t: at(st < en ? d : d + 1, en), s });
      }
    }
    return out;
  }

  /** The latest on/off moment for this screen that hasn't been acted on yet, or null. */
  function pendingChange(screenId) {
    const list = schedulesFor(screenId);
    if (!list.length) return null;
    const host = hostOf(screenId);
    const floor = Math.max((cfg.applied[screenId] || {}).t || 0, (cfg.paired[host] || {}).at || 0);
    const t0 = now();
    let best = null;
    for (const b of boundaries(list, -8, 0)) {
      if (b.t > t0 || b.t <= floor || b.t < (b.s.changedAt || 0)) continue;
      const on = want(list, b.t);
      if (on === want(list, b.t - MIN)) continue; // e.g. one schedule ends as another carries on
      if (!best || b.t > best.t) best = { t: b.t, on, name: b.s.name };
    }
    return best;
  }

  /** The next on/off moment for this screen in the coming week, for the admin panel. */
  function nextChange(screenId) {
    const list = schedulesFor(screenId);
    const t0 = now();
    let best = null;
    for (const b of boundaries(list, -1, 8)) {
      if (b.t <= t0) continue;
      const on = want(list, b.t);
      if (on === want(list, b.t - MIN)) continue;
      if (!best || b.t < best.t) best = { t: b.t, on };
    }
    return best;
  }

  const nextTry = {}; // screenId -> time of the next retry after a failure
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await Promise.all(getScreens().map(async (sc) => {
        const host = hostOf(sc.id);
        if (!host || !cfg.paired[host]) return;
        const ch = pendingChange(sc.id);
        if (!ch || (nextTry[sc.id] && nextTry[sc.id] > now())) return;
        const why = `power schedule “${ch.name}”`;
        try {
          await power(sc.id, ch.on, why);
          cfg.applied[sc.id] = { t: ch.t, on: ch.on, at: now() };
          delete nextTry[sc.id];
          save();
        } catch (e) {
          if (now() - ch.t >= giveUpMs) {
            cfg.applied[sc.id] = { t: ch.t, on: ch.on, at: now(), failed: e.message };
            note(sc.id, `Gave up switching ${ch.on ? 'on' : 'off'} (${why}) after trying for an hour: ${e.message}`, true);
            delete nextTry[sc.id];
            save();
          } else nextTry[sc.id] = now() + retryMs;
          log.error(`TV power: ${sc.name}: ${e.message}`);
        }
      }));
    } finally { ticking = false; }
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const hosts = [...new Set(getScreens().map((s) => (s.tvHost || '').trim()).filter((h) => h && cfg.paired[h]))];
      await Promise.all(hosts.map((h) => (now() - (L(h).checkedAt || 0) > pollMs / 2 && !L(h).busy ? check(h) : null)));
    } finally { polling = false; }
  }

  const timers = [];
  function start() {
    timers.push(setInterval(() => tick().catch((e) => log.error(e)), tickMs), setInterval(() => poll().catch(() => {}), pollMs));
    timers.push(setTimeout(() => { tick().catch(() => {}); poll().catch(() => {}); }, 2000));
    for (const t of timers) t.unref && t.unref();
  }
  function stop() { for (const t of timers) clearInterval(t); }

  /** What the admin panel shows for each screen with a TV. */
  function info() {
    const out = {};
    for (const sc of getScreens()) {
      const host = hostOf(sc.id);
      if (!host) continue;
      const st = live[host] || {};
      const p = cfg.paired[host];
      out[sc.id] = {
        host,
        paired: !!p,
        model: (p && p.model) || [st.vendor, st.model].filter(Boolean).join(' '),
        pairing: !!sessions[sc.id],
        on: p ? (st.on ?? null) : null,
        app: st.app || '',
        checkedAt: st.checkedAt || 0,
        error: p ? st.error || '' : '',
        busy: st.busy || '',
        last: last[sc.id] || null,
        next: p ? nextChange(sc.id) : null,
      };
    }
    return out;
  }

  return { start, stop, tick, poll, check, power, pairStart, pairCode, pairCancel, forget, info, pendingChange, nextChange, _cfg: () => cfg };
}

module.exports = { createTvs };
