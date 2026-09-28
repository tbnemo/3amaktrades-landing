// Does every booking actually GET its reminder?
//
// Nothing else in the suite answers that. Every other reminder test hands the
// handler an event and checks what it does with it; none of them ask whether a
// daily cron will ever SEE a given booking in the first place. That question is
// decided by three numbers that live in three different files, and they were out
// of agreement: the cron schedule (vercel.json), the lead time
// (REMINDER_LEAD_HOURS, a Vercel env var, currently 36), and the template's
// minNoticeHours (api/_availability.js).
//
// THE MECHANISM. A cron run at time T lists bookings starting in [T, T + lead]
// and reminds them. So a booking made at B for a call starting at S is reminded
// iff some cron tick T satisfies all three of:
//     T >= B          -- the booking has to exist when the run happens
//     T <= S          -- the call has not started yet (startMs < now is skipped)
//     T >= S - lead   -- it is inside the listed window
// i.e. iff a tick lands in the closed interval [max(B, S - lead), S]. That
// interval is exactly min(S - B, lead) long, and S - B >= minNoticeHours, so its
// length is at least min(minNoticeHours, lead).
//
// THE INVARIANT. Cron ticks are one period apart, and the phase of a booking
// relative to them is arbitrary. A closed interval of length L is guaranteed to
// contain a tick, for EVERY phase, iff L >= period. So:
//
//     min(minNoticeHours, REMINDER_LEAD_HOURS) >= cronPeriodHours
//
// That is the whole guarantee, and it is why the fix is what it is. The cron
// period cannot move: Vercel's Hobby plan caps crons at once per day, which is
// why an earlier commit had to go from hourly to daily. lead is 36. So
// minNoticeHours had to come up from 12 to 24 -- at 12 the interval could be 12h
// long, less than the 24h between ticks, and slip between two of them entirely.
//
// WHAT WENT WRONG BEFORE, concretely. With minNoticeHours 12 and the cron at
// 13:00 UTC, the simulation below reports ~7% of bookings reminded with under 12
// hours notice, a worst case of ZERO hours notice, and -- once the cron's real
// sub-minute imprecision is modelled -- a few hundred bookings per regime getting
// no reminder at all, with no log line and no trace. 13:00 UTC is the worst hour
// available: it is 09:00 in the default Toronto template, so the first slot of
// the day came due at the very instant the run started.
//
// Both halves are asserted below: the invariant directly (cheap, readable, and it
// fails loudly if any of the three numbers moves), and then a brute-force
// simulation over every booking-time x slot-time pair on a 15-minute grid, run
// through the REAL window arithmetic exported by api/calendar-reminders.js rather
// than a copy of it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const av = require('../api/_availability');
const remind = require('../api/calendar-reminders');

const HOUR = 3600000;
const DAY = 86400000;
const VERCEL_JSON = path.join(__dirname, '..', 'vercel.json');

// Read the LIVE schedule rather than restating it, so editing vercel.json is what
// re-runs this proof. A non-daily schedule is not merely a different number here:
// it changes the period the invariant is measured against, so it must be read,
// not assumed.
function cronPeriodHours() {
  const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  const jobs = (cfg.crons || []).filter(c => c.path === '/api/calendar-reminders');
  assert.equal(jobs.length, 1,
    'vercel.json must register exactly one cron for /api/calendar-reminders');
  const m = /^(\d+) (\d+) \* \* \*$/.exec(jobs[0].schedule);
  assert.ok(m, `expected a once-daily "M H * * *" schedule, got "${jobs[0].schedule}". `
    + 'A different shape changes the tick period this whole proof rests on -- if the '
    + 'plan now allows more frequent crons, update this parser and the invariant together.');
  return { periodHours: 24, minute: +m[1], hour: +m[2], schedule: jobs[0].schedule };
}

// The deployed lead time (a Vercel env var) and the value the code falls back to
// if that var ever goes missing. The guarantee has to hold for BOTH: a dropped env
// var must not silently downgrade delivery.
const LEAD_HOURS_CASES = [36, 24];

function withLead(hours, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  process.env.REMINDER_LEAD_HOURS = String(hours);
  try {
    assert.equal(remind.leadHours(), hours, 'the module must be reading the env var live');
    return fn();
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
}

test('INVARIANT: min(minNoticeHours, REMINDER_LEAD_HOURS) >= the cron period', () => {
  const cron = cronPeriodHours();
  const notice = av.normalizeTemplate(av.DEFAULT_TEMPLATE).minNoticeHours;

  for (const lead of LEAD_HOURS_CASES) {
    const slack = Math.min(notice, lead) - cron.periodHours;
    assert.ok(slack >= 0,
      `delivery is NOT guaranteed: cron "${cron.schedule}" ticks every ${cron.periodHours}h, `
      + `but the eligible window can be as short as min(minNoticeHours=${notice}, lead=${lead}) `
      + `= ${Math.min(notice, lead)}h. A window shorter than the tick period can fall between two `
      + 'ticks, and that booking gets no reminder at all -- silently. Raise minNoticeHours in '
      + 'api/_availability.js, raise REMINDER_LEAD_HOURS, or shorten the cron period.');
  }
});

// Every bookable slot start over `days` from the anchor, with the minimum-notice
// filter effectively switched off (nowMs far enough in the past that `earliest`
// precedes the whole range). This is the real computeSlotsForRange, so the real
// template, the real 30-minute grid, the real DST handling and the real
// end-of-window clamping all apply.
function slotUniverse(anchor, days) {
  const farPast = Date.UTC(anchor.y, anchor.mo - 1, anchor.d) - 60 * DAY;
  const byDate = av.computeSlotsForRange({
    template: av.DEFAULT_TEMPLATE, startYmd: anchor, days, busy: [], nowMs: farPast,
  });
  const out = [];
  for (const day of Object.values(byDate)) for (const s of day) out.push(s.startMs);
  return out.sort((a, b) => a - b);
}

// Vercel does not promise to invoke a cron at the exact minute of its schedule,
// and on the Hobby plan (which this project is on) a daily job is only guaranteed
// to fire somewhere within its scheduled hour. A guarantee that depended on
// to-the-second punctuality would not be a guarantee at all, so the worst case is
// modelled explicitly.
//
// Lateness does NOT affect delivery: shifting every tick by the same amount keeps
// them 24h apart, and a >=24h eligible interval still contains one. It shifts the
// NOTICE band down hour for hour, which is why 0h and ~1h are both here -- the
// notice floor is (13h - lateness), so it clears 12h for any lateness under an
// hour, and that is the actual margin this system has.
const JITTER_MS_CASES = [0, 60 * 1000, 47 * 60 * 1000, 59 * 60 * 1000];

function simulate({ anchor, leadHours, jitterMs }) {
  const cron = cronPeriodHours();
  const noticeHours = av.normalizeTemplate(av.DEFAULT_TEMPLATE).minNoticeHours;
  const leadMs = leadHours * HOUR;
  const anchorMs = Date.UTC(anchor.y, anchor.mo - 1, anchor.d);
  const tick0 = Date.UTC(anchor.y, anchor.mo - 1, anchor.d, cron.hour, cron.minute);

  // Slots are capped well inside the universe so no result is an artefact of the
  // horizon running out of ticks. Anything further out than ~2 days behaves
  // identically anyway: past that, S - lead binds before B does.
  const slots = slotUniverse(anchor, 20).filter(s => s <= anchorMs + 10 * DAY);

  const worst = { missed: 0, under12: 0, pairs: 0 };
  let minNotice = Infinity, maxNotice = -Infinity;
  const examples = [];

  // A 15-minute grid of booking times spanning a full week: that covers every
  // phase relative to a daily tick and every weekday, which together are the only
  // things the outcome can depend on.
  for (let B = anchorMs; B <= anchorMs + 7 * DAY; B += 15 * 60000) {
    const earliest = B + noticeHours * HOUR;
    for (const S of slots) {
      if (S < earliest) continue;     // the visitor could not have booked this
      worst.pairs++;

      // Every tick that could possibly be in the window. wouldRemind requires
      // S <= runNow + lead, so no tick earlier than kLo can ever qualify.
      let firedAt = null;
      const kLo = Math.max(0, Math.floor((S - leadMs - jitterMs - tick0) / DAY));
      const kHi = Math.floor((S - tick0) / DAY) + 1;
      for (let k = kLo; k <= kHi; k++) {
        const runNow = tick0 + k * DAY + jitterMs;
        if (runNow < B) continue;                        // booking did not exist yet
        if (remind.wouldRemind(S, runNow)) { firedAt = runNow; break; }
      }

      if (firedAt === null) {
        worst.missed++;
        if (examples.length < 3) {
          examples.push(`booked ${new Date(B).toISOString()} for ${new Date(S).toISOString()}`);
        }
        continue;
      }
      const notice = (S - firedAt) / HOUR;
      if (notice < minNotice) minNotice = notice;
      if (notice > maxNotice) maxNotice = notice;
      if (notice < 12) worst.under12++;
    }
  }
  return { ...worst, minNotice, maxNotice, examples };
}

// Four regimes, because the template's hours are wall times in America/Toronto
// while the cron ticks in UTC: the offset between them is what sets the notice
// time, and it changes with DST. The two transition weeks are included because a
// 23- or 25-hour local day is where an off-by-one would hide.
const REGIMES = [
  { label: 'EDT, midsummer', anchor: { y: 2027, mo: 7, d: 5 } },
  { label: 'EST, midwinter', anchor: { y: 2027, mo: 1, d: 4 } },
  { label: 'the spring-forward week', anchor: { y: 2027, mo: 3, d: 8 } },
  { label: 'the fall-back week', anchor: { y: 2027, mo: 11, d: 1 } },
];

for (const regime of REGIMES) {
  test(`DELIVERY in ${regime.label}: every bookable slot gets a reminder, with real notice`, () => {
    for (const leadHours of LEAD_HOURS_CASES) {
      withLead(leadHours, () => {
        for (const jitterMs of JITTER_MS_CASES) {
          const r = simulate({ anchor: regime.anchor, leadHours, jitterMs });
          const where = `${regime.label}, lead=${leadHours}h, cron jitter=${jitterMs / 1000}s`;

          assert.ok(r.pairs > 20000,
            `${where}: only ${r.pairs} booking/slot pairs examined -- too few to mean anything, `
            + 'the grid or the slot universe has collapsed');

          // The one that matters. A missed booking is a visitor who never hears
          // from us again about a call they scheduled.
          assert.equal(r.missed, 0,
            `${where}: ${r.missed} of ${r.pairs} bookings would get NO reminder at all, silently. `
            + `e.g. ${r.examples.join(' | ')}`);

          // A reminder that lands as the call starts is indistinguishable from
          // none. This is the assertion the old 13:00 cron failed hardest: it
          // produced a worst case of zero hours notice.
          assert.equal(r.under12, 0,
            `${where}: ${r.under12} of ${r.pairs} bookings get under 12h notice `
            + `(worst ${r.minNotice.toFixed(2)}h) -- too late to be useful`);

          assert.ok(r.minNotice >= 12 && r.maxNotice <= 36,
            `${where}: notice band [${r.minNotice.toFixed(2)}h, ${r.maxNotice.toFixed(2)}h] `
            + 'left the expected 12h-36h envelope');

          // The floor is the earliest slot's UTC hour-of-day minus however late
          // the cron ran. Stated as an equality-ish bound so that if the template's
          // opening hour or the cron hour ever moves, this says so rather than
          // quietly eating the margin down toward zero.
          const expectedFloor = 13 - jitterMs / HOUR;
          assert.ok(Math.abs(r.minNotice - expectedFloor) < 1.01,
            `${where}: expected a notice floor near ${expectedFloor.toFixed(2)}h `
            + `(09:00 Toronto in UTC, minus cron lateness) but got ${r.minNotice.toFixed(2)}h`);
        }
      });
    }
  });
}

// Pins the mechanism rather than just the outcome, so the numbers above cannot
// drift into meaninglessness without something saying so. Derived by hand, not
// measured: with the cron at 00:00 UTC, the ONLY eligible tick for a slot is the
// midnight that opens its own UTC day -- the previous midnight sits 24h+ earlier,
// which is more than lead=36h minus the slot's own offset into the day only for
// slots before 12:00 UTC, and the template has none of those. So notice equals
// the slot's UTC hour-of-day exactly: 09:00-16:30 Toronto is 13:00-20:30 UTC in
// EDT and 14:00-21:30 UTC in EST.
test('MECHANISM: notice equals the slot start\'s UTC hour-of-day, so the band is 13h-21.5h', () => {
  const cron = cronPeriodHours();
  assert.equal(cron.hour, 0, 'this derivation assumes a midnight-UTC cron');
  assert.equal(cron.minute, 0);

  withLead(36, () => {
    for (const regime of REGIMES) {
      const r = simulate({ anchor: regime.anchor, leadHours: 36, jitterMs: 0 });
      // 13:00 UTC (09:00 EDT) is the earliest slot of any day, 21:30 UTC
      // (16:30 EST) the latest.
      assert.ok(r.minNotice >= 13 && r.maxNotice <= 21.5,
        `${regime.label}: band [${r.minNotice}, ${r.maxNotice}] is not the hour-of-day band`);
    }
  });
});
