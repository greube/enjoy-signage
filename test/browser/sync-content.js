'use strict';
// Test content for the sync tests: playlist "Main" (slide 4 s, video 7 s, slide 3 s, video 5 s) on TV 1–3,
// and playlist "Other" (slide 6 s, slide 2 s, video 5 s) on TV 4. With lengths: false, videos start unmeasured
// (as after upgrading), and the TVs measure them on first play.
const fs = require('fs');
const path = require('path');
const { writeDb, textSlide, media } = require('../common');

module.exports = function syncContent(dataDir, { lengths = true } = {}) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  writeDb(dataDir, {
    media: [
      textSlide('t1', 'Slide A', '#224'), textSlide('t2', 'Slide B', '#422'), textSlide('t3', 'Room X1', '#242'), textSlide('t4', 'Room X2', '#244'),
      { id: 'm7', type: 'video', name: 'Video 7s', file: 'v7.webm', createdAt: 1, ...(lengths ? { length: 7 } : {}) },
      { id: 'm5', type: 'video', name: 'Video 5s', file: 'v5.webm', createdAt: 1, ...(lengths ? { length: 5 } : {}) },
    ],
    playlists: [
      { id: 'P', name: 'Main', transition: 'fade', items: [{ id: 'i1', mediaId: 't1', duration: 4 }, { id: 'i2', mediaId: 'm7' }, { id: 'i3', mediaId: 't2', duration: 3 }, { id: 'i4', mediaId: 'm5' }] },
      { id: 'Q', name: 'Other', transition: 'fade', items: [{ id: 'q1', mediaId: 't3', duration: 6 }, { id: 'q2', mediaId: 't4', duration: 2 }, { id: 'q3', mediaId: 'm5' }] },
    ],
    screens: [
      { id: 's1', name: 'TV 1', defaultPlaylistId: 'P' }, { id: 's2', name: 'TV 2', defaultPlaylistId: 'P' },
      { id: 's3', name: 'TV 3', defaultPlaylistId: 'P' }, { id: 's4', name: 'TV 4', defaultPlaylistId: 'Q' },
    ],
  });
  for (const f of ['v7.webm', 'v5.webm']) fs.copyFileSync(media(f), path.join(dataDir, 'uploads', f));
};

/** Injected into each player page: records [wall time, what appeared] for every change, and video positions. */
module.exports.INSTRUMENT = () => {
  window.__ev = []; window.__vs = [];
  const label = (l) => { const v = l.querySelector('video'); if (v) return 'video:' + (v.currentSrc || v.src).split('/').pop().split('?')[0]; const h = l.querySelector('h1'); return h ? h.textContent : (l.textContent || '?').trim().slice(0, 20); };
  const start = () => new MutationObserver((ms) => {
    for (const m of ms) if (m.target.classList && m.target.classList.contains('layer') && m.target.classList.contains('show') && !m.target.__seen) { m.target.__seen = 1; window.__ev.push([Date.now(), label(m.target)]); }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  setInterval(() => {
    const l = [...document.querySelectorAll('.layer.show')].sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0];
    const v = l && l.querySelector('video');
    if (v && !v.paused) window.__vs.push([Date.now(), label(l), v.currentTime]);
    if (v && /retry=/.test(v.currentSrc)) window.__retried = true;
  }, 100);
};
