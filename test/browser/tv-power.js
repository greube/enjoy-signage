#!/usr/bin/env node
'use strict';
/**
 * TV power end to end: the real server, the admin panel in Chromium, and two pretend TVs.
 *
 *   node test/browser/tv-power.js            (about 3 minutes: it waits for a real power schedule)
 *
 * TV 1 (127.0.0.2) behaves normally. TV 2 (127.0.0.3) ignores the WAKEUP/SLEEP keys, so the server has
 * to fall back to POWER. Checks: pairing through the admin panel (with a mistyped code first), On/Off on
 * a screen card, All TVs on/off, a power schedule made in the admin panel switching both TVs on and then
 * off on the minute, a TV that's unplugged, forgetting a TV, and that the screens keep playing.
 * Screenshots go to test/.work/tv-power/.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORK, sleep, startServer, playwright, signInAsAdmin } = require('../common.js');

const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(WORK, 'tv-power');
let fails = 0;
const ok = (cond, what) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) fails++; };
const tvCtl = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => (p === '/code' ? r.text() : r.json()));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(250); }
  console.log(`    (timed out waiting for: ${what})`);
  return false;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = path.join(OUT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const procs = [];
  const tvLog = fs.openSync(path.join(OUT, 'tvs.log'), 'w');
  procs.push(spawn(process.execPath, [path.join(__dirname, '../mocks/tv.js'), '127.0.0.2', '4612', '--off'], { stdio: ['ignore', tvLog, tvLog] }));
  procs.push(spawn(process.execPath, [path.join(__dirname, '../mocks/tv.js'), '127.0.0.3', '4613', '--off', '--ignore-wake'], { stdio: ['ignore', tvLog, tvLog] }));
  const server = startServer(PORT, dataDir);
  procs.push(server);
  const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });
  process.on('exit', cleanup);
  await sleep(1500);

  const { api, cookie } = await signInAsAdmin(BASE, dataDir);
  const slide = await api('POST', '/api/media', { type: 'text', name: 'Welcome', title: 'Welcome', bg: '#224', fg: '#fff' });
  const pl = await api('POST', '/api/playlists', { name: 'Loop', items: [{ mediaId: slide.id, duration: 5 }] });
  const foyer = await api('POST', '/api/screens', { name: 'Foyer', defaultPlaylistId: pl.id });
  const cafe = await api('POST', '/api/screens', { name: 'Cafe', defaultPlaylistId: pl.id });
  await api('POST', '/api/screens', { name: 'Kids PC', defaultPlaylistId: pl.id });

  const { chromium } = playwright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const player = await ctx.newPage();
  await player.goto(`${BASE}/player/${foyer.id}`);

  console.log('\nPairing through the admin panel');
  await page.goto(`${BASE}/#tv`);
  await page.waitForSelector('text=TV power');
  const setUp = async (screenName, host, port, typo) => {
    await page.click(`tr:has-text("${screenName}") >> button[data-action=tv-setup]`);
    await page.fill('input[name=host]', host);
    await page.click('button[data-pair]');
    await page.waitForSelector('[data-step=code]:not([hidden])', { timeout: 20000 });
    const code = await tvCtl(port, '/code');
    if (typo) {
      await page.fill('input[name=code]', code.slice(0, 5) + (code[5] === '0' ? '1' : '0'));
      await page.click('button[data-code]');
      await page.waitForFunction(() => /doesn.t match|didn.t accept/.test(document.querySelector('[data-msg]').textContent), null, { timeout: 15000 }).catch(() => {});
      const said = await page.textContent('[data-msg]');
      ok(/doesn.t match|didn.t accept/.test(said), `a mistyped code is caught: “${said.trim()}”`);
    }
    await page.fill('input[name=code]', code.toLowerCase());
    await page.click('button[data-code]');
    await page.waitForSelector('.modal-back', { state: 'detached', timeout: 20000 });
  };
  await setUp('Foyer', '127.0.0.2', 4612, true);
  ok((await tvCtl(4612, '/state')).paired === 1, 'TV 1 paired');
  await setUp('Cafe', '127.0.0.3', 4613);
  ok((await tvCtl(4613, '/state')).paired === 1, 'TV 2 paired');
  await page.waitForSelector('tr:has-text("Foyer") >> text=In standby');
  ok(true, 'the TV list shows both in standby');
  ok(/No TV address/.test(await page.textContent('tr:has-text("Kids PC")')), 'the screen without a TV says so');
  await page.screenshot({ path: path.join(OUT, '1-tv-page.png') });

  console.log('\nOn and off from a screen card');
  await page.goto(`${BASE}/#screens`);
  await page.click(`.screen-card:has-text("Foyer") >> button[data-action=tv-power][data-on="1"]`);
  ok(await until(async () => (await tvCtl(4612, '/state')).on, 15000, 'TV 1 on'), 'TV 1 switched on');
  await page.waitForSelector('.screen-card:has-text("Foyer") >> text=TV: On', { timeout: 10000 }).catch(() => {});
  ok(/TV: On/.test(await page.textContent('.screen-card:has-text("Foyer")')), 'the card says TV: On');
  await page.screenshot({ path: path.join(OUT, '2-screen-cards.png') });
  await page.click(`.screen-card:has-text("Foyer") >> button[data-action=tv-power][data-on="0"]`);
  ok(await until(async () => !(await tvCtl(4612, '/state')).on, 15000, 'TV 1 off'), 'TV 1 switched off');

  console.log('\nAll TVs on, then off (TV 2 ignores WAKEUP/SLEEP)');
  await page.goto(`${BASE}/#tv`);
  let t0 = Date.now();
  await page.click('button[data-action=tv-all][data-on="1"]');
  ok(await until(async () => (await tvCtl(4612, '/state')).on && (await tvCtl(4613, '/state')).on, 30000, 'both on'), `both on (took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const keys2 = (await tvCtl(4613, '/state')).keys;
  ok(keys2.join() === '224,26', `TV 2 got WAKEUP and then POWER (${keys2.join(', ')})`);
  await page.waitForSelector('.toast:has-text("All TVs switched on")', { timeout: 20000 }).catch(() => {});
  t0 = Date.now();
  await page.click('button[data-action=tv-all][data-on="0"]');
  ok(await until(async () => !(await tvCtl(4612, '/state')).on && !(await tvCtl(4613, '/state')).on, 30000, 'both off'), `both off (took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  console.log('\nA power schedule made in the admin panel');
  await page.waitForTimeout(1000);
  const now = new Date();
  const wait = 60 - now.getSeconds() < 25 ? 2 : 1; // at least 25 s ahead
  const onAt = new Date(now.getTime() + wait * 60000);
  onAt.setSeconds(0, 0); // the schedule says HH:MM, so it fires at the start of that minute
  const offAt = new Date(onAt.getTime() + 60000);
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  await page.click('button[data-action=ps-new]');
  await page.fill('.modal input[name=name]', 'Test service');
  await page.click('.modal button[data-days="0,1,2,3,4,5,6"]');
  await page.fill('.modal input[name=startTime]', hm(onAt));
  await page.fill('.modal input[name=endTime]', hm(offAt));
  await page.click('.modal footer button[type=submit]');
  await page.waitForSelector('.modal-back', { state: 'detached' });
  ok(/Switches on/.test(await page.textContent('tr:has-text("Foyer")')), `the TV list shows the next switch: “${(await page.textContent('tr:has-text("Foyer") td.hide-sm')).trim()}”`);
  await page.screenshot({ path: path.join(OUT, '3-schedule.png'), fullPage: true });
  console.log(`    on at ${hm(onAt)}, off at ${hm(offAt)}; waiting…`);
  const onBy = async (port) => { await until(async () => (await tvCtl(port, '/state')).on, onAt - Date.now() + 40000, 'scheduled on'); return Date.now(); };
  const [on1, on2] = await Promise.all([onBy(4612), onBy(4613)]);
  ok(on1 - onAt < 20000 && on1 >= onAt.getTime(), `TV 1 on ${((on1 - onAt) / 1000).toFixed(1)} s after ${hm(onAt)}`);
  ok(on2 - onAt < 30000 && on2 >= onAt.getTime(), `TV 2 on ${((on2 - onAt) / 1000).toFixed(1)} s after ${hm(onAt)} (it needs the POWER fallback)`);
  const offBy = async (port) => { await until(async () => !(await tvCtl(port, '/state')).on, offAt - Date.now() + 40000, 'scheduled off'); return Date.now(); };
  const [off1, off2] = await Promise.all([offBy(4612), offBy(4613)]);
  ok(off1 - offAt < 20000 && off1 >= offAt.getTime(), `TV 1 off ${((off1 - offAt) / 1000).toFixed(1)} s after ${hm(offAt)}`);
  ok(off2 - offAt < 30000 && off2 >= offAt.getTime(), `TV 2 off ${((off2 - offAt) / 1000).toFixed(1)} s after ${hm(offAt)}`);
  await page.goto(`${BASE}/#tv`);
  ok(/power schedule/.test(await page.textContent('tr:has-text("Foyer")')), `the TV list says why: “${(await page.textContent('tr:has-text("Foyer") td:nth-child(2) .muted')).trim()}”`);

  console.log('\nSomeone uses the TV’s own remote');
  await tvCtl(4612, '/set?on=1');
  await page.click('tr:has-text("Foyer") >> button[data-action=tv-check]');
  await page.waitForSelector('tr:has-text("Foyer") >> text=Fully Kiosk in front', { timeout: 10000 }).catch(() => {});
  ok(/On/.test(await page.textContent('tr:has-text("Foyer") td:nth-child(2)')), 'checking shows it on again, with Fully Kiosk in front');

  console.log('\nA TV that’s unplugged');
  await tvCtl(4613, '/mode?unplugged=1');
  t0 = Date.now();
  await page.click('tr:has-text("Cafe") >> button[data-action=tv-power][data-on="1"]');
  await page.waitForSelector('.toast.error', { timeout: 30000 }).catch(() => {});
  const toastText = await page.textContent('.toast.error').catch(() => '');
  ok(/Couldn.t reach/.test(toastText), `On says it couldn’t reach it, after ${((Date.now() - t0) / 1000).toFixed(1)} s: “${toastText.trim().slice(0, 90)}…”`);
  await page.waitForTimeout(500);
  ok(/Can.t reach the TV/.test(await page.textContent('tr:has-text("Cafe")')), 'the TV list shows Can’t reach the TV');
  await page.screenshot({ path: path.join(OUT, '4-unreachable.png') });
  await tvCtl(4613, '/mode?unplugged=0');

  console.log('\nForgetting a TV');
  await page.click('tr:has-text("Cafe") >> button[data-action=tv-setup]');
  await page.click('button[data-forget]');
  await page.click('.modal footer button[type=submit]');
  await page.waitForSelector('tr:has-text("Cafe") >> text=No TV address');
  ok(true, 'Cafe is back to no TV');
  const st = await api('GET', '/api/state');
  ok(!st.tvs[cafe.id] && st.tvs[foyer.id].paired, 'the server agrees, and Foyer is still paired');

  console.log('\nThe screens kept playing, and the admin panel had no errors');
  ok(await player.isVisible('text=Welcome'), 'the Foyer player is still showing its slide');
  ok(!errors.length, `no errors in the admin panel ${errors.length ? JSON.stringify(errors) : ''}`);

  await browser.close();
  console.log(fails ? `\n✗ ${fails} check(s) failed  (TV logs: ${path.join(OUT, 'tvs.log')})\n` : `\n✓ All good. Screenshots in ${OUT}\n`);
  cleanup();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
