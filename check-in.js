'use strict';

// How many days of availability to fetch in one request. The endpoint clamps
// at 31; 14 keeps the payload small while covering a fortnight.
var RANGE_DAYS = 14;

// The verify token lives ONLY here, in a closure variable. Never in any
// browser-side persistence layer or a cookie: it is a 10-minute credential,
// and persisting it would outlive the tab that earned it for no benefit.
var state = {
  verifyToken: '',
  name: '',
  timezone: '',      // the CHECK-IN template's zone, from the availability response
  slotMinutes: 0,
  days: {},          // { 'YYYY-MM-DD': [{start, end}] }
  dayKeys: [],
  selectedDay: '',
  selectedStart: '', // the absolute ISO instant of the chosen slot
  rangeStart: '',    // 'YYYY-MM-DD' the current availability fetch started from
  submitting: false,
};

// The visitor's own zone, used both for display and for what gets stored on
// the booking. Falls back to UTC on an engine that cannot report it.
var visitorTz = (function () {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch (e) { return 'UTC'; }
})();

function $(id) { return document.getElementById(id); }
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 'YYYY-MM-DD' for the visitor's own local date. Used only to know which
// date to ask for first -- never to interpret a slot instant.
function localDateKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// A day-chip label for a CALENDAR DATE, not an instant: the probe is pinned
// to UTC noon and formatted with timeZone:'UTC' so the label always matches
// the key regardless of the visitor's system zone.
function dayLabel(dateKey) {
  var bits = String(dateKey).split('-');
  var probe = new Date(Date.UTC(+bits[0], +bits[1] - 1, +bits[2], 12, 0, 0));
  return {
    weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(probe),
    dayNum: new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' }).format(probe),
  };
}

// The server sends absolute ISO instants precisely so the client only ever
// FORMATS -- never does offset arithmetic of its own.
function formatTime(iso, zone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch (e) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  }
}

function formatFull(iso, zone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, dateStyle: 'full', timeStyle: 'short',
    }).format(new Date(iso));
  } catch (e) {
    return new Date(iso).toISOString();
  }
}

// ── step 1: verify ──────────────────────────────────────────────────────
// ONE generic message for every failure. Deliberate: it must not hint at
// whether the identifier was unknown, malformed, or something else broke.
var GENERIC_FAIL = "We couldn't verify that email or phone. If you're a current client, contact Omar directly.";

function showVerifyError(message) {
  $('verifyError').textContent = message;
  show('verifyError');
}

// This script self-initializes immediately (no DOMContentLoaded wrapper),
// exactly as it did as an inline <script> tag at the end of <body> -- every
// element it references already exists in the DOM by the time this file
// runs. The `typeof document !== 'undefined'` guard changes nothing about
// that browser timing (document always exists there); it exists only so
// requiring this file under plain Node (no DOM) doesn't throw before
// reaching the module.exports block below.
if (typeof document !== 'undefined') {
  $('verifyForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    hide('verifyError');

    var email = $('verifyEmail').value.trim();
    var phone = $('verifyPhone').value.trim();
    if (!email && !phone) {
      showVerifyError('Enter an email or a phone number.');
      return;
    }

    $('verifySubmit').disabled = true;
    var res, data;
    try {
      res = await fetch('/api/checkin-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, phone: phone }),
      });
      data = await res.json().catch(function () { return {}; });
    } catch (err) {
      $('verifySubmit').disabled = false;
      showVerifyError('Network error -- try again.');
      return;
    }
    $('verifySubmit').disabled = false;

    if (res.status === 503) {
      showVerifyError('Check-in booking is not set up yet. Message Omar directly.');
      return;
    }
    // 502 means the roster or rate-limit store could not be read -- an infra
    // failure, not a non-match. Distinct from the generic message below so a
    // real client mid-outage isn't told they look like a stranger.
    if (res.status === 502) {
      showVerifyError('Something went wrong checking that -- try again in a moment, or message Omar directly.');
      return;
    }
    // 429 is its own message, not the generic one: unlike a wrong email/phone,
    // this can legitimately happen to a real client who mistyped their own
    // address a few times, and "try again shortly" is honest without telling
    // anyone whether the identifier they guessed is actually on the roster --
    // the same 429 fires either way (see api/checkin-verify.js).
    if (res.status === 429) {
      showVerifyError((data && data.message) || 'Too many attempts. Try again in a few minutes.');
      return;
    }
    // Distinct from the generic message below: reaching this response already
    // required a successful roster match server-side (api/calendar-checkin.js's
    // verifyHandler), so showing the specific reason leaks nothing to a
    // stranger -- it tells a real client their PACKAGE, not their email/phone,
    // is the actual problem, which is exactly why this message exists.
    if (data && data.error === 'ACCESS_INACTIVE') {
      showVerifyError((data && data.message) || GENERIC_FAIL);
      return;
    }
    // Every other non-success, including the deliberate 200 {ok:false},
    // collapses to the one generic message.
    if (!data || data.ok !== true || !data.verifyToken) {
      showVerifyError(GENERIC_FAIL);
      return;
    }

    state.verifyToken = data.verifyToken;
    state.name = data.name || '';
    $('greeting').textContent = state.name
      ? 'Pick a time, ' + state.name
      : 'Pick a time';

    hide('stepVerify');
    show('stepPick');
    await loadAvailability(localDateKey());
  });
}

// ── step 2: pick ────────────────────────────────────────────────────────
function renderDayStrip() {
  var strip = $('dayStrip');
  strip.innerHTML = '';
  state.dayKeys.forEach(function (key) {
    var slots = state.days[key] || [];
    var parts = dayLabel(key);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day' + (key === state.selectedDay ? ' is-selected' : '');
    btn.disabled = slots.length === 0;
    btn.dataset.day = key;
    btn.setAttribute('aria-pressed', key === state.selectedDay ? 'true' : 'false');

    var wd = document.createElement('div');
    wd.className = 'day-weekday';
    wd.textContent = parts.weekday;
    var num = document.createElement('div');
    num.className = 'day-num';
    num.textContent = parts.dayNum;
    btn.append(wd, num);
    strip.appendChild(btn);
  });
}

function renderSlots() {
  var wrap = $('slots');
  wrap.innerHTML = '';
  var slots = state.days[state.selectedDay] || [];
  $('noSlots').hidden = slots.length > 0;

  slots.forEach(function (s) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot' + (s.start === state.selectedStart ? ' is-selected' : '');
    btn.dataset.start = s.start;
    btn.setAttribute('aria-pressed', s.start === state.selectedStart ? 'true' : 'false');
    var span = document.createElement('span');
    span.className = 'slot-time';
    span.textContent = formatTime(s.start, visitorTz);
    btn.appendChild(span);
    wrap.appendChild(btn);
  });

  $('tzNote').textContent = 'Times shown in your time zone (' + visitorTz + ').';
  renderConfirmBar();
}

function renderConfirmBar() {
  if (!state.selectedStart) { hide('confirmBar'); return; }
  $('confirmSummary').innerHTML = '';
  var line = document.createElement('span');
  line.textContent = 'Check-in on ';
  var when = document.createElement('strong');
  when.textContent = formatFull(state.selectedStart, visitorTz);
  var tail = document.createElement('span');
  tail.textContent = ' (' + visitorTz + ')'
    + (state.slotMinutes ? ' · ' + state.slotMinutes + ' minutes' : '');
  $('confirmSummary').append(line, when, tail);
  show('confirmBar');
}

// The first day that actually has openings -- today's hours may already
// have passed, so the answer is not necessarily today. 'YYYY-MM-DD' sorts
// correctly as a plain string.
function firstDayWithOpenings() {
  for (var i = 0; i < state.dayKeys.length; i++) {
    var slots = state.days[state.dayKeys[i]];
    if (slots && slots.length > 0) return state.dayKeys[i];
  }
  return '';
}

async function loadAvailability(fromDateKey) {
  hide('pickerError');
  hide('noSlots');
  show('pickerLoading');
  $('slots').innerHTML = '';

  var res, data;
  try {
    res = await fetch('/api/calendar-checkin-availability?date='
      + encodeURIComponent(fromDateKey) + '&days=' + RANGE_DAYS);
    data = await res.json().catch(function () { return {}; });
  } catch (err) {
    hide('pickerLoading');
    $('pickerError').textContent = 'Could not load times -- try again.';
    show('pickerError');
    updateArrows();
    return;
  }
  hide('pickerLoading');

  if (!data || data.ok !== true) {
    $('pickerError').textContent = res.status === 503
      ? 'Booking is temporarily unavailable. Message Omar directly.'
      : 'Could not load times -- try again.';
    show('pickerError');
    updateArrows();
    return;
  }

  state.timezone = data.timezone || '';
  state.slotMinutes = Number(data.slotMinutes) || 0;
  state.days = data.days || {};
  state.dayKeys = Object.keys(state.days).sort();
  state.rangeStart = fromDateKey;

  // Keep the current selection if it survived the refetch; otherwise land on
  // the first day that has anything.
  if (!state.days[state.selectedDay] || state.days[state.selectedDay].length === 0) {
    state.selectedDay = firstDayWithOpenings() || state.dayKeys[0] || '';
    state.selectedStart = '';
  }
  if (state.selectedStart) {
    var still = (state.days[state.selectedDay] || []).some(function (s) {
      return s.start === state.selectedStart;
    });
    if (!still) state.selectedStart = '';
  }

  renderDayStrip();
  renderSlots();
  updateArrows();

  if (state.dayKeys.length > 0 && !firstDayWithOpenings()) {
    $('pickerError').textContent = 'No openings in the next ' + RANGE_DAYS
      + ' days. Try the arrow for later dates, or message Omar.';
    show('pickerError');
  }
}

function shiftDays(delta) {
  var base = state.rangeStart ? state.rangeStart.split('-') : null;
  var from = base
    ? new Date(Date.UTC(+base[0], +base[1] - 1, +base[2]))
    : new Date();
  from.setUTCDate(from.getUTCDate() + delta * RANGE_DAYS);
  var today = localDateKey();
  var key = from.getUTCFullYear() + '-' + pad2(from.getUTCMonth() + 1) + '-' + pad2(from.getUTCDate());
  // Never page back before today: there is nothing bookable there.
  if (key < today) key = today;
  state.selectedDay = '';
  state.selectedStart = '';
  loadAvailability(key);
}

function updateArrows() {
  $('dayPrev').disabled = !state.rangeStart || state.rangeStart <= localDateKey();
}

if (typeof document !== 'undefined') {
  $('dayStrip').addEventListener('click', function (e) {
    var btn = e.target.closest('.day');
    if (!btn || btn.disabled) return;
    state.selectedDay = btn.dataset.day;
    state.selectedStart = '';
    renderDayStrip();
    renderSlots();
  });

  $('slots').addEventListener('click', function (e) {
    var btn = e.target.closest('.slot');
    if (!btn) return;
    state.selectedStart = btn.dataset.start;
    renderSlots();
  });

  $('dayPrev').addEventListener('click', function () { shiftDays(-1); });
  $('dayNext').addEventListener('click', function () { shiftDays(1); });
}

// ── step 3: confirm ─────────────────────────────────────────────────────
// Nothing is collected here: the name came back from checkin-verify, and the
// EMAIL is never in the browser at all -- the server takes it from the
// token. So the body carries only the token, the instant, and display info.
if (typeof document !== 'undefined') {
  $('confirmBtn').addEventListener('click', async function () {
    if (!state.selectedStart || state.submitting) return;
    state.submitting = true;
    $('confirmBtn').disabled = true;
    hide('pickerError');

    var res, data;
    try {
      res = await fetch('/api/calendar-checkin-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verifyToken: state.verifyToken,
          start: state.selectedStart,
          visitorTimeZone: visitorTz,
          lang: 'en',
        }),
      });
      data = await res.json().catch(function () { return {}; });
    } catch (err) {
      state.submitting = false;
      $('confirmBtn').disabled = false;
      $('pickerError').textContent = 'Network error -- try again.';
      show('pickerError');
      return;
    }

    state.submitting = false;
    $('confirmBtn').disabled = false;

    // An expected race, not an error: somebody took the slot between the grid
    // loading and this click. Clear the selection, say so plainly, re-fetch.
    if (res.status === 409 || (data && data.error === 'SLOT_TAKEN')) {
      state.selectedStart = '';
      hide('confirmBar');
      $('pickerError').textContent = 'That time was just taken. Here are the current openings.';
      show('pickerError');
      await loadAvailability(state.rangeStart || localDateKey());
      return;
    }

    // Checked by ERROR CODE, before the status-code-only 403/NOT_VERIFIED
    // branch below: this is the race-window re-check in bookHandler (a
    // client paused or ran out their package between verifying and
    // confirming), and it is ALSO a 403 -- matching on status alone would
    // shadow it with the generic "verify again" message below, which is the
    // wrong follow-up for a client whose package, not whose token, is the
    // problem.
    if (data && data.error === 'ACCESS_INACTIVE') {
      $('pickerError').textContent = (data && data.message) || 'Could not book that time -- try again.';
      show('pickerError');
      return;
    }

    // The 10-minute token ran out (or the roster changed). Back to step 1 --
    // there is nothing the picker can do about it.
    if (res.status === 403 || (data && data.error === 'NOT_VERIFIED')) {
      state.verifyToken = '';
      state.selectedStart = '';
      hide('stepPick');
      show('stepVerify');
      showVerifyError('That took a while, so we need to check who you are again.');
      return;
    }

    if (!data || data.ok !== true) {
      $('pickerError').textContent = res.status === 503
        ? 'Booking is temporarily unavailable. Message Omar directly.'
        : 'Could not book that time -- try again.';
      show('pickerError');
      return;
    }

    // Booked. The token has done its job; drop it.
    state.verifyToken = '';

    $('doneWhen').innerHTML = '';
    var lead = document.createElement('span');
    lead.textContent = 'Your check-in is confirmed for ';
    var when = document.createElement('strong');
    when.textContent = formatFull(data.start, visitorTz);
    var tail = document.createElement('span');
    tail.textContent = ' (' + visitorTz + ').';
    $('doneWhen').append(lead, when, tail);

    if (data.meetLink && /^https?:\/\//i.test(data.meetLink)) {
      $('doneMeet').innerHTML = '';
      var label = document.createElement('span');
      label.textContent = 'Join link: ';
      var a = document.createElement('a');
      a.href = data.meetLink;
      a.textContent = data.meetLink;
      a.rel = 'noopener noreferrer';
      $('doneMeet').append(label, a);
      show('doneMeet');
    }

    hide('stepPick');
    show('stepDone');
  });
}

// Guarded CommonJS export so the pure, DOM-free helpers above are testable
// under plain `node --test` with no browser and no build step. `state` is
// exported too, alongside the pure functions: unlike the applicant widget's
// range-taking equivalent, this page's firstDayWithOpenings() takes no
// argument and reads the picker's day/slot map straight out of this
// closure -- exporting the same object reference (not a copy) lets a test
// set up `days`/`dayKeys` and then call the function exactly as the page
// itself does, with no change to the function's own logic.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    __test: {
      pad2: pad2,
      localDateKey: localDateKey,
      dayLabel: dayLabel,
      formatTime: formatTime,
      formatFull: formatFull,
      firstDayWithOpenings: firstDayWithOpenings,
      state: state,
    },
  };
}
