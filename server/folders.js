'use strict';
/*
 * Drop folders for ENJOY Signage. Zero dependencies.
 *
 * This module only watches the folders and reports what's in them. server.js (syncFolders) turns
 * each finished file into an ordinary media item and playlist item. Each drop folder is a sub-folder of one
 * "drop folders location" (default: <data>/folders), which can be shared on the network or be a
 * OneDrive/Dropbox/Google Drive folder synced to the server.
 *
 * Safety:
 *  - Folders are polled (fs.watch is unreliable on network shares and synced folders).
 *  - A newly seen file is only used once its size and modified time have stopped changing, so a
 *    half-copied video is never sent to a TV.
 *  - Files are only ever served if the scanner listed them: a whitelist of real image/video files
 *    directly inside a drop folder. Nothing else on disk can be reached through it.
 */

const fs = require('fs');
const path = require('path');

const SCAN_MS = 4000;
const BUSY_SCAN_MS = 1500; // re-check sooner while something is still copying
const SETTLE_MS = 5000; // how long a new file must stay unchanged before it's used
const MAX_FILES = 2000;
const TYPES = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.avif': 'image', '.bmp': 'image',
  '.mp4': 'video', '.m4v': 'video', '.webm': 'video', '.mov': 'video', '.ogv': 'video', '.mkv': 'video',
};
// Temp/system files that office machines and sync clients leave lying around.
const IGNORE = /^(\.|~\$|~lock|thumbs\.db$|desktop\.ini$|icon\r?$)|\.(part|partial|tmp|temp|crdownload|download|!ut|sb-[\w-]+)$/i;

/** Natural sort: "2 Notice" before "10 Notice". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function cleanFolderName(v) {
  const name = String(v == null ? '' : v)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, ''); // Windows doesn't allow trailing dots/spaces
  if (!name || name.startsWith('.') || name === '..') return '';
  return name;
}

function createFolders({ defaultRoot, getRoot, onChange = () => {}, log = console }) {
  const folders = new Map(); // name -> { files: [...ready], present: Set(all names incl. still copying), pending: n, sig }
  const seen = new Map(); // full path -> { size, mtimeMs, since }
  let firstScan = true; // files found on the first scan of a location are trusted (already complete)
  let lastRoot = '';
  let rootError = '';
  let lastScan = 0;

  const root = () => path.resolve(getRoot() || defaultRoot);

  /** Scan now. If a scan is already running, wait for it and then scan again, so callers see fresh results. */
  let inflight = null;
  function scan() {
    if (inflight) return inflight.then(() => scan());
    inflight = doScan().finally(() => { inflight = null; });
    return inflight;
  }

  async function doScan() {
    let changed = false;
    try {
      const r = root();
      if (r !== lastRoot) { firstScan = true; seen.clear(); lastRoot = r; }
      if (r === path.resolve(defaultRoot)) await fs.promises.mkdir(r, { recursive: true }).catch(() => {});
      let dirents;
      try {
        dirents = await fs.promises.readdir(r, { withFileTypes: true });
        if (rootError) changed = true;
        rootError = '';
      } catch (e) {
        const msg = e.code === 'ENOENT' ? `The drop folders location ${r} doesn't exist` : e.code === 'EACCES' || e.code === 'EPERM' ? `The server isn't allowed to read ${r}` : `Can't read ${r}: ${e.message}`;
        if (msg !== rootError) { rootError = msg; changed = true; log.error('! ' + msg); }
        if (folders.size) { folders.clear(); changed = true; }
        return;
      }
      const names = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.') && cleanFolderName(d.name) === d.name).map((d) => d.name);
      const now = Date.now();
      const alive = new Set();
      const next = new Map();
      for (const name of names) {
        const dir = path.join(r, name);
        let entries = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { /* unreadable: treat as empty */ }
        const files = [];
        const present = new Set();
        let pending = 0;
        for (const d of entries) {
          if (files.length >= MAX_FILES) break;
          if (!d.isFile() || IGNORE.test(d.name)) continue;
          const type = TYPES[path.extname(d.name).toLowerCase()];
          if (!type) continue;
          const full = path.join(dir, d.name);
          let st;
          try { st = await fs.promises.stat(full); } catch { continue; }
          if (!st.isFile()) continue;
          present.add(d.name);
          if (st.size === 0) { pending++; continue; }
          alive.add(full);
          const prev = seen.get(full);
          if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
            // New or still changing. Files already there when the server starts are trusted straight away.
            seen.set(full, { size: st.size, mtimeMs: st.mtimeMs, since: firstScan ? 0 : now });
            if (!firstScan) { pending++; continue; }
          } else if (now - prev.since < SETTLE_MS) { pending++; continue; }
          files.push({ file: d.name, type, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
        const sig = files.map((f) => `${f.file}|${f.size}|${f.mtime}`).sort().join('\n') + '\n--\n' + [...present].sort().join('\n');
        const old = folders.get(name);
        if (!old || old.sig !== sig || old.pending !== pending) changed = true;
        next.set(name, { files, present, pending, sig });
      }
      for (const k of seen.keys()) if (!alive.has(k)) seen.delete(k);
      if (folders.size !== next.size || [...folders.keys()].some((k) => !next.has(k))) changed = true;
      folders.clear();
      for (const [k, v] of next) folders.set(k, v);
      firstScan = false;
    } catch (e) {
      log.error('! Folder scan failed: ' + e.message);
    } finally {
      lastScan = Date.now();
      if (changed) onChange();
    }
  }

  /**
   * What's in a folder: `ready` = finished files (natural name order), `present` = every media file
   * name there, including ones still being copied. null if the folder doesn't exist.
   */
  function get(name) {
    const f = folders.get(name);
    if (!f) return null;
    return { ready: [...f.files].sort((a, b) => collator.compare(a.file, b.file)), present: f.present, pending: f.pending };
  }

  /** True once the location has been read successfully, so missing files really are missing. */
  const ok = () => !rootError && lastScan > 0;

  const readyFile = (name, file) => { const f = folders.get(name); return f ? f.files.find((x) => x.file === file) || null : null; };

  /** Absolute path for a finished file the scanner has listed, or null. The only way files are served. */
  function resolve(name, file) {
    return readyFile(name, file) ? path.join(root(), name, file) : null;
  }

  /** Delete a file the scanner has listed (used when its media item is deleted in the admin panel). */
  async function remove(name, file) {
    const f = folders.get(name);
    if (!f || !f.present.has(file)) return;
    await fs.promises.unlink(path.join(root(), name, file));
    await scan();
  }

  async function create(v) {
    const name = cleanFolderName(v);
    if (!name) throw Object.assign(new Error('Give the folder a name (letters, numbers and spaces)'), { status: 400 });
    if (rootError) throw Object.assign(new Error(rootError), { status: 400 });
    await fs.promises.mkdir(path.join(root(), name), { recursive: true });
    await scan();
    return name;
  }

  function info() {
    return {
      root: root(),
      isDefault: root() === path.resolve(defaultRoot),
      error: rootError,
      lastScan,
      folders: [...folders.entries()]
        .sort((a, b) => collator.compare(a[0], b[0]))
        .map(([name, f]) => ({ name, count: f.files.length, pending: f.pending })),
    };
  }

  // Scan loop: quicker while files are mid-copy, so new content shows up within ~5-10 seconds.
  const loop = async () => {
    await scan();
    const busy = [...folders.values()].some((f) => f.pending);
    setTimeout(loop, busy ? BUSY_SCAN_MS : SCAN_MS).unref();
  };
  loop();

  return { scan, get, ok, resolve, readyFile, remove, create, info, has: (n) => folders.has(n), cleanFolderName };
}

module.exports = { createFolders, cleanFolderName };
