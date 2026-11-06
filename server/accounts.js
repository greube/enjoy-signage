'use strict';
/*
 * User accounts, sign-in sessions and lockout for ENJOY Signage. Zero dependencies.
 *
 *  - Roles: "admin" (everything) and "editor" (upload/create content; edit only the playlists an
 *    admin has ticked for them). Permissions are enforced by server.js on every request.
 *  - Passwords are stored as scrypt hashes (Node's built-in crypto) in data/users.json, which is NOT
 *    part of the backup download, so restoring a backup can't change who can sign in.
 *  - Built-in recovery admin: if ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE) is set, username "admin"
 *    with that password always signs in as an administrator. That's also how older installs upgrade.
 *  - First run with no administrator at all: a one-time setup code is printed in the server window
 *    (and saved to data/setup-code.txt); it's needed to create the first administrator account.
 *  - Sessions: random token in an HttpOnly cookie; only a hash of it is stored on the server.
 *  - Lockout: after 5 wrong attempts, sign-in is refused for 30 seconds, counted both per username
 *    and per device (IP address).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TRIES = 5;
const LOCK_MS = 30 * 1000;
const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;   // signed out after a week without use
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000;   // and after 30 days regardless
const BUILTIN_ID = 'builtin-admin';
const MIN_PASSWORD = 8;

const scryptAsync = (pw, salt, len) => new Promise((ok, bad) => crypto.scrypt(pw, salt, len, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? bad(e) : ok(k))));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

function cleanUsername(v) {
  const u = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(u)) throw err(400, 'Usernames are 2–40 letters, numbers, dots, dashes or underscores (no spaces)');
  return u;
}
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw err(400, `Passwords need at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw err(400, 'That password is too long');
}

function createAccounts({ dataDir, builtinPassword = '', log = console }) {
  const USERS = path.join(dataDir, 'users.json');
  const SESSIONS = path.join(dataDir, 'sessions.json');
  const SETUP_FILE = path.join(dataDir, 'setup-code.txt');
  const writeJson = (file, data) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };

  let users = readJson(USERS, []);
  if (!Array.isArray(users)) users = [];
  const saveUsers = () => writeJson(USERS, users);

  const builtin = builtinPassword ? { id: BUILTIN_ID, username: 'admin', name: 'Administrator (built-in)', role: 'admin', playlists: [], builtin: true } : null;

  /* ---------- First-run setup ---------- */
  const hasAdmin = () => !!builtin || users.some((u) => u.role === 'admin' && !u.disabled);
  let setupCode = null;
  function ensureSetupCode() {
    if (hasAdmin()) { setupCode = null; fs.unlink(SETUP_FILE, () => {}); return; }
    if (!setupCode) {
      setupCode = String(crypto.randomInt(100000, 1000000));
      try { fs.writeFileSync(SETUP_FILE, `ENJOY Signage first-time setup code: ${setupCode}\n`, { mode: 0o600 }); } catch {}
    }
  }
  ensureSetupCode();

  /* ---------- Lockout ---------- */
  const fails = new Map(); // key -> { count, until }
  const lockKeys = (username, ip) => [`u:${String(username || '').toLowerCase()}`, `ip:${ip || '?'}`];
  function lockedFor(keys) {
    const now = Date.now();
    return Math.max(0, ...keys.map((k) => ((fails.get(k) || {}).until || 0) - now));
  }
  function recordFail(keys) {
    for (const k of keys) {
      const f = fails.get(k) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= MAX_TRIES) { f.until = Date.now() + LOCK_MS; f.count = 0; }
      fails.set(k, f);
    }
  }
  const clearFails = (keys) => keys.forEach((k) => fails.delete(k));
  setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (f.until < now && !f.count) fails.delete(k); }, 10 * 60000).unref();
  const lockError = (ms) => err(429, `Too many wrong attempts. Try again in ${Math.ceil(ms / 1000)} seconds.`, { retryAfter: Math.ceil(ms / 1000) });

  /* ---------- Sessions ---------- */
  let sessions = readJson(SESSIONS, {});
  if (!sessions || typeof sessions !== 'object') sessions = {};
  let sessionsDirty = false;
  const saveSessions = () => { writeJson(SESSIONS, sessions); sessionsDirty = false; };
  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of Object.entries(sessions)) if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { delete sessions[k]; sessionsDirty = true; }
    if (sessionsDirty) saveSessions();
  }, 5 * 60000).unref();

  function startSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    sessions[sha256(token)] = { userId: user.id, created: now, seen: now };
    saveSessions();
    return token;
  }
  function endSession(token) {
    if (token && sessions[sha256(token)]) { delete sessions[sha256(token)]; saveSessions(); }
  }
  function endSessionsFor(userId, exceptToken) {
    const keep = exceptToken ? sha256(exceptToken) : null;
    for (const [k, s] of Object.entries(sessions)) if (s.userId === userId && k !== keep) delete sessions[k];
    saveSessions();
  }
  const byId = (id) => (id === BUILTIN_ID ? builtin : users.find((u) => u.id === id)) || null;

  /** The signed-in user for a session token, or null. */
  function userForToken(token) {
    if (!token) return null;
    const s = sessions[sha256(token)];
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { delete sessions[sha256(token)]; sessionsDirty = true; return null; }
    const u = byId(s.userId);
    if (!u || u.disabled) return null;
    if (now - s.seen > 60000) { s.seen = now; sessionsDirty = true; }
    return u;
  }

  /* ---------- Sign in ---------- */
  async function login(usernameIn, password, ip) {
    const username = String(usernameIn || '').trim().toLowerCase();
    const keys = lockKeys(username, ip);
    const wait = lockedFor(keys);
    if (wait) throw lockError(wait);
    let user = null;
    if (builtin && username === 'admin') {
      const a = Buffer.from(sha256(String(password || ''))), b = Buffer.from(sha256(builtinPassword));
      if (crypto.timingSafeEqual(a, b)) user = builtin;
    } else {
      const u = users.find((x) => x.username === username);
      const ok = await checkPassword(String(password || ''), u ? u.hash : DUMMY_HASH); // same work whether or not the user exists
      if (u && ok && !u.disabled) user = u;
    }
    if (!user) {
      recordFail(keys);
      const w = lockedFor(keys);
      if (w) throw lockError(w);
      throw err(401, 'Wrong username or password');
    }
    clearFails(keys);
    if (!user.builtin) { user.lastLogin = Date.now(); saveUsers(); }
    return { user, token: startSession(user) };
  }

  /** Create the first administrator (only while no administrator exists, and only with the setup code). */
  async function setup({ code, username, name, password }, ip) {
    if (hasAdmin()) throw err(409, 'Setup has already been done. Sign in instead.');
    const keys = lockKeys('__setup__', ip);
    const wait = lockedFor(keys);
    if (wait) throw lockError(wait);
    if (String(code || '').trim() !== setupCode) {
      recordFail(keys);
      const w = lockedFor(keys);
      if (w) throw lockError(w);
      throw err(401, 'That setup code is wrong. It’s shown in the server window, and saved in data/setup-code.txt.');
    }
    clearFails(keys);
    const u = await createUser({ username, name, password, role: 'admin', playlists: [] });
    ensureSetupCode();
    return { user: u, token: startSession(u) };
  }

  /* ---------- Managing users ---------- */
  const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name || u.username, role: u.role, playlists: u.playlists || [], disabled: !!u.disabled, builtin: !!u.builtin, lastLogin: u.lastLogin || null, createdAt: u.createdAt || null };
  const list = () => (builtin ? [builtin] : []).concat(users).map(publicUser);

  async function createUser(b) {
    const username = cleanUsername(b.username);
    if (username === 'admin') throw err(400, '“admin” is reserved for the built-in recovery account. Choose another username.');
    if (users.some((u) => u.username === username)) throw err(409, `There’s already a user called “${username}”`);
    checkNewPassword(b.password);
    const u = {
      id: crypto.randomBytes(6).toString('hex'),
      username,
      name: String(b.name || '').trim().slice(0, 80) || username,
      role: b.role === 'admin' ? 'admin' : 'editor',
      playlists: Array.isArray(b.playlists) ? b.playlists.filter((x) => typeof x === 'string').slice(0, 500) : [],
      disabled: !!b.disabled,
      hash: await hashPassword(b.password),
      createdAt: Date.now(),
    };
    users.push(u);
    saveUsers();
    ensureSetupCode();
    return u;
  }

  async function updateUser(id, b, actor) {
    const u = users.find((x) => x.id === id);
    if (!u) throw err(id === BUILTIN_ID ? 400 : 404, id === BUILTIN_ID ? 'The built-in admin is set on the server (ADMIN_PASSWORD), not here.' : 'No such user');
    const next = { ...u };
    if (b.name !== undefined) next.name = String(b.name || '').trim().slice(0, 80) || u.username;
    if (b.role !== undefined) next.role = b.role === 'admin' ? 'admin' : 'editor';
    if (b.playlists !== undefined) next.playlists = Array.isArray(b.playlists) ? b.playlists.filter((x) => typeof x === 'string').slice(0, 500) : [];
    if (b.disabled !== undefined) next.disabled = !!b.disabled;
    // Never let an admin lock everyone (including themselves) out.
    if (u.id === actor.id && (next.role !== 'admin' || next.disabled)) throw err(400, 'You can’t remove your own administrator access or disable yourself.');
    const adminsAfter = (builtin ? 1 : 0) + users.filter((x) => (x.id === u.id ? next : x).role === 'admin' && !(x.id === u.id ? next : x).disabled).length;
    if (!adminsAfter) throw err(400, 'There must always be at least one administrator.');
    let pwChanged = false;
    if (b.password) { checkNewPassword(b.password); next.hash = await hashPassword(b.password); pwChanged = true; }
    Object.assign(u, next);
    saveUsers();
    if (pwChanged || u.disabled || b.role !== undefined) endSessionsFor(u.id); // changes take effect immediately
    return u;
  }

  function removeUser(id, actor) {
    const u = users.find((x) => x.id === id);
    if (!u) throw err(id === BUILTIN_ID ? 400 : 404, id === BUILTIN_ID ? 'The built-in admin can be turned off by removing ADMIN_PASSWORD on the server.' : 'No such user');
    if (u.id === actor.id) throw err(400, 'You can’t delete your own account.');
    const admins = (builtin ? 1 : 0) + users.filter((x) => x.id !== id && x.role === 'admin' && !x.disabled).length;
    if (!admins) throw err(400, 'There must always be at least one administrator.');
    users = users.filter((x) => x.id !== id);
    saveUsers();
    endSessionsFor(id);
  }

  async function changeOwnPassword(user, current, next, token) {
    if (user.builtin) throw err(400, 'The built-in admin’s password is set on the server (ADMIN_PASSWORD, or “sudo church-signage password” on Ubuntu).');
    const u = users.find((x) => x.id === user.id);
    if (!u || !(await checkPassword(String(current || ''), u.hash))) throw err(401, 'Your current password is wrong');
    checkNewPassword(next);
    u.hash = await hashPassword(next);
    saveUsers();
    endSessionsFor(u.id, token); // sign out other devices, keep this one
  }

  /** Forget a deleted playlist in everyone's permissions. */
  function dropPlaylist(id) {
    let changed = false;
    for (const u of users) if ((u.playlists || []).includes(id)) { u.playlists = u.playlists.filter((x) => x !== id); changed = true; }
    if (changed) saveUsers();
  }

  return {
    login, setup, list, publicUser, createUser, updateUser, removeUser, changeOwnPassword, dropPlaylist,
    userForToken, endSession, needsSetup: () => !hasAdmin(), setupCode: () => setupCode,
    flush: () => sessionsDirty && saveSessions(),
  };
}

module.exports = { createAccounts, MAX_TRIES, LOCK_MS };
