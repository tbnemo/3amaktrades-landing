// Does every booking actually GET its reminder?
//
// Nothing else in the suite answers that. Every other reminder test hands a
// handler an event and checks what it does with it; none of them ask whether
// anything will ever SEE a given booking in the first place.
//
// THE CRON MECHANISM. A cron run at time T lists bookings starting in
// [T, T + lead] and reminds them. So a booking made at B for a call starting at
// S is reminded BY THE CRON iff some tick T satisfies all three of:
//     T >= B          -- the booking has to exist when the run happens
//     T <= S          -- the call has not started yet (startMs < now is skipped)
//     T >= S - lead   -- it is inside the listed window
// i.e. iff a tick lands in the closed interval [max(B, S - lead), S]. That
// interval is exactly min(S - B, lead) long, and S - B >= minNoticeHours, so its
// length is at least min(minNoticeHours, lead).
//
// Cron ticks are one period apart and a booking's phase relative to them is
// arbitrary. A closed interval of length L is guaranteed to contain a tick, for
// EVERY phase, iff L >= period. So the CRON ALONE delivers everything iff
//
//     min(minNoticeHours, REMINDER_LEAD_HOURS) >= cronPeriodHours
//
// ===========================================================================
// WHAT CHANGED, AND WHY THIS FILE WAS REWRITTEN
// ===========================================================================
// That inequality used to be asserted here as THE invariant, measured on the
// DEFAULT template's minNoticeHours. It was never a property of the system,
// though -- only of one configuration of it. minNoticeHours is admin-settable:
// api/_availability.js normalizes it with clamp(0, 720), and the admin page
// POSTs straight through that. A single save of "1 hour" from /admin falsified
// the invariant in production while this file stayed green, because it only ever
// read DEFAULT_TEMPLATE. Every booking made with less than a day's notice then
// got NO reminder at all -- no email, no log line, no trace.
//
// The fix was not to forbid short notice. It was to stop DEPENDING on the cron
// for bookings the cron cannot be relied on for. api/calendar-book.js,
// api/calendar-reschedule.js and both check-in handlers in
// api/calendar-checkin.js now ask remind.needsImmediateReminder(start, now) and,
// when it says yes, send the reminder THEMSELVES at booking time and set
// reminderSent -- which is the same flag the cron skips on, so the event gets
// exactly one reminder, not two.
//
// So the property this file proves is now the stronger, configuration-
// independent one:
//
//     EVERY booking gets a reminder -- from a future cron tick, or from the
//     booking handler itself at booking time -- for ANY minNoticeHours an
//     admin can save.
//
// together with the soundness condition that makes it a guarantee rather than a
// coin flip:
//
//     whenever a handler declines to send immediately, a cron tick provably does
//     send. "Covered by one of the two" is not enough on its own -- a predicate
//     that returned true for everything would satisfy it while emailing every
//     visitor a duplicate reminder days early, so the simulation below asserts
//     BOTH directions of the handoff.
//
// Both halves are asserted here: the arithmetic directly (cheap, readable, and
// loud if any of the numbers move or drift apart across files), and then a
// brute-force simulation over every booking-time x slot-time pair on a
// 15-minute grid, run through the REAL window arithmetic AND the REAL predicate
// exported by api/calendar-reminders.js rather than copies of them -- at the
// shipped minNoticeHours of 24 AND at a lowered 1, which is what proves
// same-day booking is now safe rather than merely allowed.
//
// WHAT WENT WRONG BEFORE, concretely, and why the notice-quality assertions are
// still here. With minNoticeHours 12 and the cron at 13:00 UTC, the simulation
// below reports ~7% of bookings reminded with under 12 hours notice, a worst
// case of ZERO hours notice, and -- once the cron's real sub-minute imprecision
// is modelled -- a few hundred bookings per regime getting no reminder at all.
// 13:00 UTC is the worst hour available: it is 09:00 in the default Toronto
// template, so the first slot of the day came due at the very instant the run
// started. DELIVERY is now unconditional; the QUALITY of a cron-delivered
// reminder still is not, so the notice band stays pinned -- for exactly the
// pairs the cron is actually responsible for.
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
    + 'plan now allows more frequent crons, update this parser, calendar-reminders.js\'s '
    + 'CRON_PERIOD_HOURS, and the invariant together.');
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

// ---------------------------------------------------------------------------
// The arithmetic half
// ---------------------------------------------------------------------------

// The cron period is now a real constant the PRODUCTION handlers read, not just
// prose in a comment and a helper in this file. Two places therefore hold the
// same number and they must not drift: vercel.json decides when the cron really
// fires, and CRON_PERIOD_HOURS is what the booking handlers compare against when
// deciding whether they can trust it.
//
// The dangerous direction is a real period LONGER than the constant: every
// booking between the constant and the real period would be left to a cron that
// is not coming, which is exactly the silent failure this file exists to
// prevent. A real period SHORTER than the constant is merely wasteful (some
// bookings get an immediate send they did not need), but it is still a
// disagreement worth surfacing, so this is an equality.
test('SOURCE OF TRUTH: CRON_PERIOD_HOURS equals the period of the live cron in vercel.json', () => {
  const cron = cronPeriodHours();
  assert.equal(remind.CRON_PERIOD_HOURS, cron.periodHours,
    `the booking handlers decide whether to send a reminder themselves by comparing against `
    + `CRON_PERIOD_HOURS (=${remind.CRON_PERIOD_HOURS}), but vercel.json's "${cron.schedule}" ticks `
    + `every ${cron.periodHours}h. If the real period is LONGER than the constant, every booking in `
    + `between is left to a tick that never comes -- silently. Change them together.`);
});

// This REPLACES the old `INVARIANT: min(minNoticeHours, REMINDER_LEAD_HOURS) >=
// the cron period` test, which asserted a cron-only guarantee on one hardcoded
// template value. The statement below is the general one: for EVERY
// minNoticeHours an admin can actually save, the worst-case booking that
// configuration permits -- one made at exactly the minimum notice -- is
// provably somebody's responsibility.
//
// It also asserts the handoff is EXACT rather than merely sufficient, in both
// directions:
//   - below the cron-only bar, needsImmediateReminder must fire (otherwise the
//     booking is lost, which is the bug);
//   - at or above it, needsImmediateReminder must NOT fire (otherwise every
//     ordinary booking gets a duplicate reminder, which is a different bug and
//     the one a careless "just always send immediately" fix would introduce).
test('INVARIANT (restated): at the MINIMUM notice any admin can save, exactly one path reminds', () => {
  const cron = cronPeriodHours();

  // The ends of _availability.js's clamp(0, 720) plus the values clustered
  // around the cron-period boundary, which is where the handoff happens and so
  // where an off-by-one would hide. 12 is here on purpose: it is the value this
  // system actually shipped with once, and the one that lost reminders.
  const CANDIDATES = [0, 1, 2, 6, 11, 12, 13, 23, 24, 25, 36, 48, 720];

  for (const requested of CANDIDATES) {
    // Through the REAL normalizer, so this is about what an admin can genuinely
    // save rather than what we wish the range were. If clamp ever narrows, the
    // candidate list stops being a list of reachable configurations and this
    // says so instead of quietly testing fiction.
    const notice = av.normalizeTemplate({ ...av.DEFAULT_TEMPLATE, minNoticeHours: requested })
      .minNoticeHours;
    assert.equal(notice, requested,
      `api/_availability.js must accept minNoticeHours=${requested} unchanged -- `
      + `it normalized to ${notice} instead, so this case no longer describes a real configuration`);

    for (const lead of LEAD_HOURS_CASES) {
      withLead(lead, () => {
        // A booking made right now at exactly the minimum allowed notice: the
        // tightest booking this configuration permits, and therefore the only
        // one worth checking -- every other booking under it has a LONGER
        // eligible interval and is strictly safer.
        const now = Date.UTC(2027, 6, 14, 0, 0, 0);
        const start = now + notice * HOUR;

        const cronIntervalHours = Math.min(notice, lead);
        const cronIsGuaranteed = cronIntervalHours >= cron.periodHours;
        const immediate = remind.needsImmediateReminder(start, now);

        if (cronIsGuaranteed) {
          assert.equal(immediate, false,
            `minNoticeHours=${notice}, lead=${lead}: the eligible interval is ${cronIntervalHours}h, `
            + `at least the ${cron.periodHours}h tick period, so a tick is CERTAIN to land in it. `
            + 'An immediate send here is a duplicate reminder for every single visitor.');
        } else {
          assert.equal(immediate, true,
            `minNoticeHours=${notice}, lead=${lead}: the eligible interval can be as short as `
            + `${cronIntervalHours}h, shorter than the ${cron.periodHours}h between ticks, so it can `
            + 'fall between two of them entirely. needsImmediateReminder MUST catch this or the '
            + 'booking silently gets no reminder at all -- that was the bug.');
        }

        // The union, stated as the only thing that ultimately matters.
        assert.ok(immediate || cronIsGuaranteed,
          `minNoticeHours=${notice}, lead=${lead}: NEITHER path is guaranteed to remind a booking `
          + 'made at the minimum allowed notice');
      });
    }
  }
});

// A CHARACTERIZATION of what ships today, not a correctness requirement any
// more -- and the distinction matters, so read the failure message before
// "fixing" this.
//
// The old invariant test was this assertion, and it was the thing standing
// between a 24h default and a silent loss of reminders. It no longer is: the
// immediate path makes any default safe. What it still pins is the promise the
// fix was sold on -- that NOTHING changes for ordinary bookings. While the
// shipped default clears the cron-only bar, every normal booking takes exactly
// the path it took before this feature existed, and the simulation below can
// assert zero immediate sends at the default as a hard number.
test('CHARACTERIZATION: the SHIPPED default still clears the cron-only bar, so normal bookings are untouched', () => {
  const cron = cronPeriodHours();
  const notice = av.normalizeTemplate(av.DEFAULT_TEMPLATE).minNoticeHours;

  for (const lead of LEAD_HOURS_CASES) {
    assert.ok(Math.min(notice, lead) >= cron.periodHours,
      `the shipped default now has min(minNoticeHours=${notice}, lead=${lead}) `
      + `= ${Math.min(notice, lead)}h, below the ${cron.periodHours}h cron period. `
      + 'This is NO LONGER a delivery bug -- api/calendar-book.js and friends send short-notice '
      + 'reminders themselves. But it does mean the shipped default now routes ordinary bookings '
      + 'through the immediate path, so: (1) confirm the DELIVERY simulation below still reports '
      + 'uncovered === 0 for the new value, and (2) update that simulation\'s "zero immediate sends '
      + 'at the default" expectation, which exists to prove normal bookings were left alone.');
  }
});

// ---------------------------------------------------------------------------
// The brute-force half
// ---------------------------------------------------------------------------

// Every bookable slot start over `days` from the anchor, with the minimum-notice
// filter effectively switched off (nowMs far enough in the past that `earliest`
// precedes the whole range). This is the real computeSlotsForRange, so the real
// template, the real 30-minute grid, the real DST handling and the real
// end-of-window clamping all apply.
//
// Notice is applied per (booking, slot) PAIR in simulate() instead, as
// S >= B + minNoticeHours. That is exactly equivalent to what production does --
// a visitor booking at B is shown precisely the slots satisfying it -- and it is
// what lets one slot universe serve several minNoticeHours values.
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

// Walks every (booking time B, slot start S) pair the configuration permits and
// records which of the two delivery paths -- if either -- would have reminded it.
//
// The two paths are mutually exclusive by construction, and that is the point:
// when needsImmediateReminder is true the handler sends at booking time and sets
// reminderSent, so the cron later SKIPS the event. There is no double-send to
// account for, and no pair may be left with nobody.
function simulate({ anchor, leadHours, jitterMs, noticeHours }) {
  const cron = cronPeriodHours();
  const leadMs = leadHours * HOUR;
  const anchorMs = Date.UTC(anchor.y, anchor.mo - 1, anchor.d);
  const tick0 = Date.UTC(anchor.y, anchor.mo - 1, anchor.d, cron.hour, cron.minute);

  // Slots are capped well inside the universe so no result is an artefact of the
  // horizon running out of ticks. Anything further out than ~2 days behaves
  // identically anyway: past that, S - lead binds before B does.
  const slots = slotUniverse(anchor, 20).filter(s => s <= anchorMs + 10 * DAY);

  const r = {
    pairs: 0,
    // THE number. ¬immediate AND no tick ever fires: a visitor who scheduled a
    // call and never hears from us again about it.
    uncovered: 0,
    // What the OLD, cron-only guarantee counted. Now expected to be zero only
    // when the configuration clears the cron-only bar; above zero is precisely
    // the hole the immediate path exists to fill, so it is asserted to be
    // non-zero for a lowered minNoticeHours -- otherwise `uncovered === 0`
    // would be proving nothing new.
    cronOnlyMisses: 0,
    immediateCount: 0,
    cronResponsible: 0,
    cronUnder12: 0,
    cronMinNotice: Infinity, cronMaxNotice: -Infinity,
    // The booking notice (S - B), not the reminder notice, on each side of the
    // handoff. These are what prove the predicate split the work sensibly
    // rather than just covering everything.
    immediateMaxBookingNotice: -Infinity,
    cronMinBookingNotice: Infinity,
    examples: [],
  };

  // A 15-minute grid of booking times spanning a full week: that covers every
  // phase relative to a daily tick and every weekday, which together are the only
  // things the outcome can depend on.
  for (let B = anchorMs; B <= anchorMs + 7 * DAY; B += 15 * 60000) {
    const earliest = B + noticeHours * HOUR;
    for (const S of slots) {
      if (S < earliest) continue;     // the visitor could not have booked this
      r.pairs++;

      const bookingNotice = (S - B) / HOUR;

      // THE decision the four booking/reschedule handlers really make, through
      // the real exported predicate, with the real booking instant as "now".
      const immediate = remind.needsImmediateReminder(S, B);

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
      if (firedAt === null) r.cronOnlyMisses++;

      if (immediate) {
        // The handler sent the reminder itself, at B, and marked the event --
        // so the cron skips it and firedAt is irrelevant here.
        r.immediateCount++;
        if (bookingNotice > r.immediateMaxBookingNotice) r.immediateMaxBookingNotice = bookingNotice;
        continue;
      }

      // From here the handler has decided to TRUST the cron with this booking.
      // Everything below is about whether that trust was warranted.
      r.cronResponsible++;
      if (bookingNotice < r.cronMinBookingNotice) r.cronMinBookingNotice = bookingNotice;

      if (firedAt === null) {
        r.uncovered++;
        if (r.examples.length < 3) {
          r.examples.push(`booked ${new Date(B).toISOString()} for ${new Date(S).toISOString()}`);
        }
        continue;
      }
      const notice = (S - firedAt) / HOUR;
      if (notice < r.cronMinNotice) r.cronMinNotice = notice;
      if (notice > r.cronMaxNotice) r.cronMaxNotice = notice;
      if (notice < 12) r.cronUnder12++;
    }
  }
  return r;
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

// The two configurations that matter. 24 is what ships; 1 is what the site owner
// asked for and what the old invariant forbade outright. Running BOTH is the
// whole point of the rewrite: the first proves nothing regressed, the second
// proves same-day booking is genuinely safe rather than merely permitted.
const NOTICE_REGIMES = [
  {
    minNoticeHours: 24,
    label: 'the shipped 24h minimum notice',
    // At 24h notice with any lead >= 24, min(notice, lead) is never below the
    // cron period, so the immediate path must never trigger. A non-zero count
    // here means ordinary visitors are getting duplicate reminders.
    expectImmediate: false,
  },
  {
    minNoticeHours: 1,
    label: 'a lowered 1h minimum notice (same-day booking)',
    expectImmediate: true,
  },
];

for (const regime of REGIMES) {
  for (const notice of NOTICE_REGIMES) {
    test(`DELIVERY in ${regime.label} with ${notice.label}: every bookable slot gets a reminder`, () => {
      for (const leadHours of LEAD_HOURS_CASES) {
        withLead(leadHours, () => {
          for (const jitterMs of JITTER_MS_CASES) {
            const r = simulate({
              anchor: regime.anchor, leadHours, jitterMs, noticeHours: notice.minNoticeHours,
            });
            const where = `${regime.label}, minNotice=${notice.minNoticeHours}h, `
              + `lead=${leadHours}h, cron jitter=${jitterMs / 1000}s`;

            assert.ok(r.pairs > 20000,
              `${where}: only ${r.pairs} booking/slot pairs examined -- too few to mean anything, `
              + 'the grid or the slot universe has collapsed');

            // ---- The one that matters ------------------------------------
            // A booking nobody reminds is a visitor who never hears from us
            // again about a call they scheduled.
            assert.equal(r.uncovered, 0,
              `${where}: ${r.uncovered} of ${r.pairs} bookings would get NO reminder at all, `
              + `silently -- neither a cron tick nor an immediate send at booking time. `
              + `e.g. ${r.examples.join(' | ')}`);

            // ---- Soundness of the handoff, both directions ---------------
            // Declining to send immediately is a claim that the cron will
            // handle it. uncovered === 0 above already proves no such claim was
            // wrong; these two bound WHICH bookings each path takes, so a
            // predicate that simply said "yes" to everything -- satisfying the
            // assertion above while spamming every visitor -- cannot pass.
            if (r.immediateCount > 0) {
              assert.ok(r.immediateMaxBookingNotice < remind.CRON_PERIOD_HOURS,
                `${where}: a booking with ${r.immediateMaxBookingNotice.toFixed(2)}h of notice was `
                + `sent immediately, but anything at or above ${remind.CRON_PERIOD_HOURS}h is `
                + 'guaranteed a cron tick -- that visitor gets two reminders');
            }
            if (r.cronResponsible > 0) {
              assert.ok(r.cronMinBookingNotice >= remind.CRON_PERIOD_HOURS,
                `${where}: a booking with only ${r.cronMinBookingNotice.toFixed(2)}h of notice was `
                + `left to the cron, under the ${remind.CRON_PERIOD_HOURS}h that makes a tick `
                + 'certain -- it survived here by luck of phase, not by guarantee');
            }

            // ---- Which path each configuration actually uses --------------
            if (notice.expectImmediate) {
              assert.ok(r.immediateCount > 0,
                `${where}: the immediate path was never taken, so this run exercises nothing new`);
              // Without this, `uncovered === 0` would be satisfiable by the old
              // cron-only system and would prove nothing about the fix. This is
              // the count of bookings the cron ALONE would have dropped: the
              // hole, measured, at a configuration that used to be forbidden.
              assert.ok(r.cronOnlyMisses > 0,
                `${where}: the cron alone would have missed nothing, so the lowered minimum notice `
                + 'is not actually reaching the gap this fix closes -- the simulation has stopped '
                + 'testing the thing it claims to test');
              assert.ok(r.cronOnlyMisses <= r.immediateCount,
                `${where}: ${r.cronOnlyMisses} bookings the cron would have dropped but only `
                + `${r.immediateCount} immediate sends -- the arithmetic does not close`);
            } else {
              assert.equal(r.immediateCount, 0,
                `${where}: ${r.immediateCount} of ${r.pairs} ordinary bookings took the immediate `
                + 'path. At the shipped minimum notice every booking is guaranteed a cron tick, so '
                + 'each of these is a duplicate reminder a visitor did not have before this feature');
              assert.equal(r.cronOnlyMisses, 0,
                `${where}: ${r.cronOnlyMisses} bookings the cron alone would miss, at the shipped `
                + 'minimum notice. The immediate path covers them, so this is not a delivery bug -- '
                + 'but it means the cron-only guarantee the default was chosen for has broken, and '
                + 'the CHARACTERIZATION test above should have said so first');
            }

            // ---- Quality of CRON-delivered reminders, unchanged -----------
            // Scoped to the pairs the cron is responsible for. An immediate
            // send has, by definition, the most notice physically available
            // (it goes out the instant the booking is made), so holding it to a
            // 12h floor would be holding it to something no system could meet.
            assert.equal(r.cronUnder12, 0,
              `${where}: ${r.cronUnder12} of ${r.cronResponsible} cron-delivered reminders arrive `
              + `with under 12h notice (worst ${r.cronMinNotice.toFixed(2)}h) -- too late to be useful`);

            assert.ok(r.cronMinNotice >= 12 && r.cronMaxNotice <= leadHours,
              `${where}: cron notice band [${r.cronMinNotice.toFixed(2)}h, `
              + `${r.cronMaxNotice.toFixed(2)}h] left the expected 12h-${leadHours}h envelope`);

            // The floor is the earliest slot's UTC hour-of-day minus however late
            // the cron ran. Stated as an equality-ish bound so that if the template's
            // opening hour or the cron hour ever moves, this says so rather than
            // quietly eating the margin down toward zero.
            const expectedFloor = 13 - jitterMs / HOUR;
            assert.ok(Math.abs(r.cronMinNotice - expectedFloor) < 1.01,
              `${where}: expected a cron notice floor near ${expectedFloor.toFixed(2)}h `
              + `(09:00 Toronto in UTC, minus cron lateness) but got ${r.cronMinNotice.toFixed(2)}h`);
          }
        });
      }
    });
  }
}

// Pins the mechanism rather than just the outcome, so the numbers above cannot
// drift into meaninglessness without something saying so. Derived by hand, not
// measured: with the cron at 00:00 UTC, the ONLY eligible tick for a slot is the
// midnight that opens its own UTC day -- the previous midnight sits 24h+ earlier,
// which is more than lead=36h minus the slot's own offset into the day only for
// slots before 12:00 UTC, and the template has none of those. So notice equals
// the slot's UTC hour-of-day exactly: 09:00-16:30 Toronto is 13:00-20:30 UTC in
// EDT and 14:00-21:30 UTC in EST.
//
// The derivation survives a lowered minimum notice untouched, which is worth
// stating because it is not obvious. Dropping minNoticeHours admits pairs whose
// own-day midnight falls BEFORE the booking instant -- but those are precisely
// the pairs with under 24h of notice, which needsImmediateReminder takes off the
// cron's hands entirely. Among the pairs the cron is still responsible for, the
// own-day midnight is always available, so the band is the same at
// minNoticeHours=1 as at 24. Both are asserted.
test('MECHANISM: cron notice equals the slot start\'s UTC hour-of-day, so the band is 13h-21.5h', () => {
  const cron = cronPeriodHours();
  assert.equal(cron.hour, 0, 'this derivation assumes a midnight-UTC cron');
  assert.equal(cron.minute, 0);

  withLead(36, () => {
    for (const regime of REGIMES) {
      for (const noticeHours of [24, 1]) {
        const r = simulate({ anchor: regime.anchor, leadHours: 36, jitterMs: 0, noticeHours });
        // 13:00 UTC (09:00 EDT) is the earliest slot of any day, 21:30 UTC
        // (16:30 EST) the latest.
        assert.ok(r.cronMinNotice >= 13 && r.cronMaxNotice <= 21.5,
          `${regime.label} at minNotice=${noticeHours}h: band `
          + `[${r.cronMinNotice}, ${r.cronMaxNotice}] is not the hour-of-day band`);
      }
    }
  });
});
