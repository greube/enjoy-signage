#!/usr/bin/env node
'use strict';
/**
 * Power schedule timing, with a pretend clock and pretend TVs, so days of schedules run in a second.
 *
 *   node test/mocks/tv-schedules.js
 *
 * Runs server/tvs.js (the real code) with the TV calls in server/tvpower.js swapped for stand-ins that
 * record every on/off and can be made to fail. Prints ✓ or ✗ for each check; exits non-zero on any ✗.
 */
const path = require('path');
const fs = require('fs');
// Run in Melbourne time, so the daylight-saving checks mean something.
if (process.env.TZ !== 'Australia/Melbourne') {
  const r = require('child_process').spawnSync(process.execPath, [__filename], { env: { ...process.env, TZ: 'Australia/Melbourne' }, stdio: 'inherit' });
  process.exit(r.status);
}
const { WORK } = require('../common.js');
process.env.DATA_DIR = path.join(WORK, 'tv-sched-server'); // server.js is loaded only for its schedule rules
const tvpower = require('../../server/tvpower.js');
const { createTvs } = require('../../server/tvs.js');
const { scheduleActive } = require('../../server/server.js');

let clock = 0;
const calls = [];
const tvState = {};          // host -> on
const unreachable = new Set();
tvpower.setPower = async (host, id, on) => {
  if (unreachable.has(host)) throw new tvpower.Fail(`Couldn't reach the TV at ${host}.`);
  calls.push({ at: clock, host, on });
  const changed = tvState[host] !== on;
  tvState[host] = on;
  return { on, changed, how: on ? 'WAKEUP' : 'SLEEP' };
};
tvpower.status = async (host) => { if (unreachable.has(host)) throw new tvpower.Fail('unreachable'); return { on: !!tvState[host], app: '', model: '', vendor: '' }; };

let fails = 0;
const ok = (cond, what) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) fails++; };
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const hhmm = (t) => { const d = new Date(t); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const show = (list) => list.map((c) => `${hhmm(c.at)} ${c.on ? 'on' : 'off'}`).join(', ') || '(none)';

/** A fresh setup: screens, schedules, one paired TV per screen. */
function setup({ screens, schedules, pairedAt, dataDir = path.join(WORK, 'tv-sched-' + Math.random().toString(36).slice(2)) }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgFile = path.join(dataDir, 'tvs.json');
  if (!fs.existsSync(cfgFile)) {
    const paired = {};
    for (const s of screens) paired[s.tvHost] = { at: pairedAt };
    fs.writeFileSync(cfgFile, JSON.stringify({ identity: { key: 'x', cert: 'x' }, paired, applied: {} }));
  }
  const tvs = createTvs({ dataDir, getScreens: () => screens, getSchedules: () => schedules, isActive: scheduleActive, now: () => clock, log: { error() {} }, retryMs: 60000, giveUpMs: 3600000 });
  return { tvs, dataDir };
}

/** Moves the clock forward in 15-second steps (the server's tick), running the scheduler each time. */
async function run(tvs, until) {
  while (clock < until) { clock += 15000; await tvs.tick(); }
}

(async () => {
  const sunday = (h, m) => at(2026, 11, 22, h, m); // 22 Nov 2026 is a Sunday
  const screens = [{ id: 'a', name: 'Foyer', tvHost: '10.0.0.1' }, { id: 'b', name: 'Cafe', tvHost: '10.0.0.2' }];
  const sched = (o) => ({ id: Math.random().toString(36).slice(2), name: 'S', enabled: true, allScreens: true, screenIds: [], days: [0], startDate: '', endDate: '', changedAt: 0, ...o });

  console.log('\nA normal Sunday: on 8:00, off 13:30');
  {
    calls.length = 0; clock = sunday(6, 0);
    const { tvs } = setup({ screens, schedules: [sched({ startTime: '08:00', endTime: '13:30' })], pairedAt: sunday(5, 0) });
    await run(tvs, sunday(23, 0));
    const a = calls.filter((c) => c.host === '10.0.0.1');
    console.log('    Foyer:', show(a));
    ok(a.length === 2 && a[0].on && !a[1].on, 'on once, then off once');
    ok(a[0].at - sunday(8, 0) < 20000 && a[1].at - sunday(13, 30) < 20000, 'each within 20 seconds of the minute');
    ok(calls.filter((c) => c.host === '10.0.0.2').length === 2, 'the other TV too');
    ok(tvs.nextChange('a') && tvs.nextChange('a').on && hhmm(tvs.nextChange('a').t) === 'Sun 08:00', `next change shown: ${tvs.nextChange('a') && hhmm(tvs.nextChange('a').t)} on (a week later)`);
  }

  console.log('\nOnly acts at the moments: switching by hand in between is left alone');
  {
    calls.length = 0; clock = sunday(6, 0);
    const { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '13:30' })], pairedAt: sunday(5, 0) });
    await run(tvs, sunday(9, 0));
    await tvs.power('a', false, 'by hand'); calls.pop();
    await run(tvs, sunday(13, 0));
    ok(calls.length === 1, `nothing between 9:00 and 13:00 after a person switched it off (${show(calls)})`);
    await run(tvs, sunday(14, 0));
    ok(calls.length === 2 && !calls[1].on, 'still switched off at 13:30 as planned');
  }

  console.log('\nOverlapping schedules: on at the first start, off at the last end');
  {
    calls.length = 0; clock = sunday(6, 0);
    const { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '12:00' }), sched({ startTime: '10:00', endTime: '14:00' }), sched({ startTime: '14:00', endTime: '15:00' })], pairedAt: sunday(5, 0) });
    await run(tvs, sunday(23, 0));
    console.log('    ', show(calls));
    ok(calls.length === 2 && hhmm(calls[0].at) === 'Sun 08:00' && hhmm(calls[1].at) === 'Sun 15:00', 'on 8:00, off 15:00, nothing at 10:00, 12:00 or 14:00');
  }

  console.log('\nOvernight (on 22:00, off 02:00) and a weekday-only schedule across a week');
  {
    calls.length = 0; clock = at(2026, 11, 21, 12, 0);
    const { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '22:00', endTime: '02:00', days: [6] }), sched({ startTime: '09:00', endTime: '17:00', days: [1, 2, 3, 4, 5] })], pairedAt: clock });
    await run(tvs, at(2026, 11, 28, 12, 0));
    console.log('    ', show(calls));
    ok(show(calls) === 'Sat 22:00 on, Sun 02:00 off, Mon 09:00 on, Mon 17:00 off, Tue 09:00 on, Tue 17:00 off, Wed 09:00 on, Wed 17:00 off, Thu 09:00 on, Thu 17:00 off, Fri 09:00 on, Fri 17:00 off', 'exactly the expected switches');
  }

  console.log('\nServer off at the moment: catches up with the latest one only');
  {
    calls.length = 0; clock = sunday(7, 0);
    const scheds = [sched({ startTime: '08:00', endTime: '13:30' })];
    const dataDir = path.join(WORK, 'tv-sched-restart');
    fs.rmSync(dataDir, { recursive: true, force: true });
    let { tvs } = setup({ screens: [screens[0]], schedules: scheds, pairedAt: sunday(5, 0), dataDir });
    await run(tvs, sunday(7, 30));
    clock = sunday(9, 10); // the server was off from 7:30 to 9:10, missing 8:00
    ({ tvs } = setup({ screens: [screens[0]], schedules: scheds, dataDir }));
    await run(tvs, sunday(9, 11));
    ok(calls.length === 1 && calls[0].on, `switched on when the server started at 9:10 (${show(calls)})`);
    clock = sunday(16, 0); // off again from 9:11 to 16:00, missing 13:30
    ({ tvs } = setup({ screens: [screens[0]], schedules: scheds, dataDir }));
    await run(tvs, sunday(16, 1));
    ok(calls.length === 2 && !calls[1].on, `switched off when it started at 16:00 (${show(calls)})`);
    ({ tvs } = setup({ screens: [screens[0]], schedules: scheds, dataDir }));
    await run(tvs, sunday(17, 0));
    ok(calls.length === 2, 'a further restart does nothing (it remembers what it already did)');
  }

  console.log('\nA new or edited schedule doesn’t act on moments before it was saved');
  {
    calls.length = 0; clock = sunday(15, 0);
    const scheds = [sched({ startTime: '08:00', endTime: '13:30', changedAt: sunday(15, 0) })];
    const { tvs } = setup({ screens: [screens[0]], schedules: scheds, pairedAt: sunday(5, 0) });
    await run(tvs, sunday(20, 0));
    ok(calls.length === 0, 'created at 15:00 for 8:00–13:30: TVs are not switched off at 15:00');
    scheds.push(sched({ startTime: '16:00', endTime: '18:00', changedAt: sunday(20, 0) })); // added later; the 18:00 off is in the past
    await run(tvs, sunday(21, 0));
    ok(calls.length === 0, 'adding a schedule at 20:00 for 16:00–18:00 doesn’t switch anything');
  }

  console.log('\nPairing at 15:00 doesn’t switch off a TV whose schedule ended at 13:30');
  {
    calls.length = 0; clock = sunday(15, 0);
    const { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '13:30' })], pairedAt: sunday(15, 0) });
    await run(tvs, sunday(16, 0));
    ok(calls.length === 0, 'nothing happens until the next moment');
  }

  console.log('\nA TV that can’t be reached: tried every minute, then given up after an hour');
  {
    calls.length = 0; clock = sunday(7, 59);
    unreachable.add('10.0.0.1');
    let tries = 0;
    const orig = tvpower.setPower;
    tvpower.setPower = async (...a) => { if (a[0] === '10.0.0.1') tries++; return orig(...a); };
    const { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '13:30' })], pairedAt: sunday(5, 0) });
    await run(tvs, sunday(8, 20));
    ok(tries >= 20 && tries <= 22, `about one try a minute (${tries} tries in 20 minutes)`);
    unreachable.delete('10.0.0.1');
    await run(tvs, sunday(8, 22));
    ok(calls.length === 1 && calls[0].on, `switched on as soon as it could be reached, at ${hhmm(calls[0].at)}`);
    calls.length = 0; tries = 0;
    unreachable.add('10.0.0.1');
    await run(tvs, sunday(15, 0));
    ok(tries >= 59 && tries <= 62, `the 13:30 off was tried for an hour (${tries} tries), then given up`);
    const info = tvs.info().a;
    ok(info.last && info.last.error && /Gave up/.test(info.last.text), `the admin panel says so: “${info.last && info.last.text}”`);
    unreachable.delete('10.0.0.1');
    tvpower.setPower = orig;
    await run(tvs, sunday(16, 0));
    ok(calls.length === 0, 'and it doesn’t suddenly switch later once the TV is back');
  }

  console.log('\nDaylight saving (Melbourne): the clocks go back on Sun 5 Apr 2026 and forward on Sun 4 Oct 2026');
  {
    calls.length = 0; clock = at(2026, 4, 3, 12, 0);
    let { tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '13:30', days: [0, 1, 2, 3, 4, 5, 6] })], pairedAt: clock });
    await run(tvs, at(2026, 4, 7, 0, 0));
    console.log('    April:  ', show(calls));
    ok(show(calls) === 'Fri 13:30 off, Sat 08:00 on, Sat 13:30 off, Sun 08:00 on, Sun 13:30 off, Mon 08:00 on, Mon 13:30 off', 'April: on and off at the right local times, before and after the clocks go back (starting Fri 12:00, so Friday\u2019s 13:30 off comes first)');
    calls.length = 0; clock = at(2026, 10, 2, 12, 0);
    ({ tvs } = setup({ screens: [screens[0]], schedules: [sched({ startTime: '08:00', endTime: '13:30', days: [0, 1, 2, 3, 4, 5, 6] }), sched({ startTime: '22:00', endTime: '02:30', days: [6] })], pairedAt: clock }));
    await run(tvs, at(2026, 10, 6, 0, 0));
    console.log('    October:', show(calls));
    const sunOff = calls.find((c) => !c.on && new Date(c.at).getDate() === 4 && new Date(c.at).getHours() < 8);
    ok(!!sunOff, `October: the overnight schedule still switches off, even though 2:30am doesn\u2019t exist that night (${sunOff ? hhmm(sunOff.at) : 'never'})`);
    ok(show(calls) === 'Fri 13:30 off, Sat 08:00 on, Sat 13:30 off, Sat 22:00 on, Sun 03:00 off, Sun 08:00 on, Sun 13:30 off, Mon 08:00 on, Mon 13:30 off', 'October: no extra or missing switches');
  }

  console.log(fails ? `\n✗ ${fails} check(s) failed\n` : '\n✓ All good\n');
  process.exit(fails ? 1 : 0);
})();
