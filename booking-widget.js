/*!
 * booking-widget.js -- self-contained, zero-dependency calendar-booking widget.
 *
 * window.BookingWidget.mount(container, options) -> { destroy() }
 *
 * options: { lang, dir, extraFields:{name,email,phone}, texts, rangeDays,
 *            apiBase, mode, onBooked, onDuplicate, onUnavailable }
 *
 * No build step, no imports, no framework. Renders via innerHTML and keeps
 * every value that must survive a re-render (typed field text, the day-strip
 * scroll position) OUTSIDE the DOM, in a plain `state` object -- see the
 * "STATE / RENDER DISCIPLINE" note below for why.
 */
(function () {
  'use strict';

  var STYLE_ID = 'booking-widget-styles';

  // ---------------------------------------------------------------------
  // Pure helpers -- no `document`/`window` reference anywhere in this
  // section, so every one of these is callable (and unit-testable) under
  // plain Node with no DOM at all. See the CommonJS export at the bottom.
  // ---------------------------------------------------------------------

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // 'YYYY-MM-DD' from the visitor's own local date. Only used to know which
  // date to request initially and which day chip gets the "today" badge --
  // never used to interpret slot instants (those are absolute ISO and are
  // only ever formatted, never date-mathed, per the time-formatting rule).
  function localDateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // The single source of truth for "which day auto-selects on load."
  // Today's hours may already have passed, so the answer is NOT today --
  // it's the first date key (sorted ascending; 'YYYY-MM-DD' sorts correctly
  // as a plain string) whose slot array is non-empty. Returns null when the
  // entire fetched range has no openings at all (the no_slots_range case).
  function firstDayWithOpenings(range) {
    if (!range) return null;
    var keys = Object.keys(range).sort();
    for (var i = 0; i < keys.length; i++) {
      var slots = range[keys[i]];
      if (Array.isArray(slots) && slots.length > 0) return keys[i];
    }
    return null;
  }

  function localeForLang(lang) {
    return lang === 'ar' ? 'ar' : 'en-GB';
  }

  // Weekday/day-number for a day-strip chip, derived from Intl at runtime
  // (never from the texts map -- the browser localises these correctly for
  // both locales). The probe date is pinned to UTC noon on the requested
  // calendar date and formatted with timeZone:'UTC', so the label always
  // matches the 'YYYY-MM-DD' key regardless of the visitor's own system
  // timezone -- this is a label for a calendar date, not an instant.
  function dayLabelParts(dateKey, locale) {
    var bits = String(dateKey).split('-');
    var y = parseInt(bits[0], 10);
    var m = parseInt(bits[1], 10);
    var d = parseInt(bits[2], 10);
    var probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    var weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(probe);
    var dayNum = new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' }).format(probe);
    return { weekday: weekday, dayNum: dayNum };
  }

  // Formats an absolute ISO instant for display in the visitor's chosen
  // timezone. The server sends absolute instants precisely so the client
  // only ever formats -- never manual offset arithmetic here.
  function formatSlotTime(iso, locale, timeZone) {
    var d = new Date(iso);
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: timeZone, hour: '2-digit', minute: '2-digit' }).format(d);
    } catch (e) {
      // An invalid/unsupported IANA zone name must never throw and blank
      // the widget -- fall back to UTC rather than propagating the error.
      return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }).format(d);
    }
  }

  var FALLBACK_TIMEZONES = [
    'UTC', 'America/Toronto', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'America/Vancouver', 'America/Sao_Paulo', 'Europe/London',
    'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul', 'Africa/Cairo', 'Asia/Beirut',
    'Asia/Amman', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai',
    'Asia/Tokyo', 'Australia/Sydney',
  ];

  // Seeds the timezone <select>. Always the short curated list -- the full
  // ~400-zone IANA set via Intl.supportedValuesOf is technically available in
  // every modern engine, which is exactly the problem: visitors got that
  // whole list instead of a handful of major zones to pick from. The
  // auto-detected zone (resolved from the visitor's own browser/OS, the
  // closest this can get to "their IP") is always present and first,
  // distinguished from the rest of the list by getTimezoneLabel below rather
  // than silently sitting wherever it happens to fall alphabetically.
  function getTimezoneOptions(detectedTz) {
    var list = FALLBACK_TIMEZONES.slice();
    if (detectedTz && list.indexOf(detectedTz) === -1) {
      list = [detectedTz].concat(list);
    } else if (detectedTz) {
      list.splice(list.indexOf(detectedTz), 1);
      list.unshift(detectedTz);
    }
    return list;
  }

  // "America/New_York" -> "America/New_York (detected)" for the one entry
  // that came from the visitor's own browser, so it reads as the specific,
  // auto-detected zone rather than just another item in a list of cities.
  function getTimezoneLabel(tzName, detectedTz, detectedSuffix) {
    return tzName === detectedTz && detectedSuffix ? (tzName + ' ' + detectedSuffix) : tzName;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  // ---------------------------------------------------------------------
  // Scoped styles, injected once regardless of how many widgets are
  // mounted. border-radius: 0 everywhere -- this site has no rounded
  // corners. Colours come from the host page's own custom properties so
  // the widget inherits the visual system rather than restating hex values.
  // ---------------------------------------------------------------------

  var STYLE_CSS = [
    '.bw-widget { color: var(--bone); }',
    '.bw-widget * { box-sizing: border-box; }',
    '.bw-widget button { font: inherit; }',
    '',
    '.bw-heading {',
    '  font-family: "Big Shoulders Display", sans-serif; font-weight: 800;',
    '  text-transform: uppercase; letter-spacing: .04em;',
    '  font-size: clamp(13px,1.4vw,15px); color: var(--dim); margin: 0 0 10px;',
    '}',
    '[dir="rtl"] .bw-heading { font-family: "Changa", sans-serif; text-transform: none; letter-spacing: 0; }',
    '',
    '.bw-section { margin-block-end: 22px; }',
    '.bw-notice {',
    '  font-size: 13px; line-height: 1.6; color: var(--gold); background: transparent;',
    '  border: 0; border-inline-start: 2px solid var(--gold); padding-inline-start: 12px;',
    '  border-radius: 0; margin: 0 0 16px;',
    '}',
    '.bw-loading, .bw-unavailable, .bw-range-empty, .bw-no-slots {',
    '  color: var(--dim); font-size: 14px; line-height: 1.6; padding-block: 6px; margin: 0;',
    '}',
    '',
    '.bw-day-row { display: flex; align-items: center; gap: 6px; }',
    '.bw-day-strip {',
    '  display: flex; gap: 8px; overflow-x: auto; flex: 1; scroll-behavior: smooth;',
    '  padding-block: 2px; scrollbar-width: thin; scrollbar-color: var(--gold-lo) transparent;',
    '}',
    '.bw-day-strip::-webkit-scrollbar { height: 4px; }',
    '.bw-day-strip::-webkit-scrollbar-track { background: transparent; }',
    '.bw-day-strip::-webkit-scrollbar-thumb { background: var(--gold-lo); border-radius: 0; }',
    '.bw-day-strip::-webkit-scrollbar-thumb:hover { background: var(--gold); }',
    '.bw-day {',
    '  flex: 0 0 auto; display: flex; flex-direction: column; align-items: center;',
    '  justify-content: center; min-width: 56px; padding: 10px 8px;',
    '  background: var(--band-2); border: 1px solid transparent; border-radius: 0;',
    '  color: var(--bone); cursor: pointer;',
    '}',
    '.bw-day-weekday { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }',
    '.bw-day-num { font-size: 18px; font-weight: 700; margin-block-start: 2px; }',
    '.bw-day-today { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: var(--gold); margin-block-start: 3px; }',
    '.bw-day.is-selected { background: var(--gold); color: var(--ink); }',
    '.bw-day.is-selected .bw-day-weekday, .bw-day.is-selected .bw-day-today { color: var(--ink); }',
    '.bw-day:hover:not(.is-selected) { background: #221F14; }',
    '.bw-day:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '.bw-day:disabled { opacity: .35; cursor: not-allowed; }',
    '',
    '.bw-arrow-btn {',
    '  flex-shrink: 0; width: 28px; height: 28px; display: flex; align-items: center;',
    '  justify-content: center; background: transparent; border: 1px solid var(--gold-lo);',
    '  color: var(--gold); border-radius: 0; cursor: pointer; font-size: 14px; line-height: 1;',
    '}',
    '.bw-arrow-btn:disabled { opacity: .3; cursor: not-allowed; }',
    '.bw-arrow-btn:hover:not(:disabled) { border-color: var(--gold); }',
    '.bw-arrow-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '.bw-arrow { display: inline-block; }',
    '[dir="rtl"] .bw-arrow { transform: scaleX(-1); }',
    '',
    '.bw-slots { display: flex; flex-wrap: wrap; gap: 8px; }',
    '.bw-slot {',
    '  background: var(--band-2); border: 1px solid var(--gold-lo); color: var(--bone);',
    '  border-radius: 0; padding: 9px 14px; cursor: pointer; font-size: 14px;',
    '}',
    '.bw-slot:hover { border-color: var(--gold); }',
    '.bw-slot.is-selected { background: var(--gold); border-color: var(--gold); color: var(--ink); }',
    '.bw-slot:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '.bw-slot-time { unicode-bidi: isolate; }',
    '',
    // display:flex + gap, not a margin on the <label> -- a <label> is an
    // INLINE element by default, so a bottom margin on it (the .bw-heading
    // rule's margin: 0 0 10px) has no effect on the gap to its next sibling.
    // Every other .bw-heading use is an <h4> (block by default), which is why
    // only this row rendered with the label and the <select> touching.
    '.bw-tz-row { display: flex; flex-direction: column; gap: 8px; margin-block: 4px 22px; }',
    '.bw-tz-select {',
    '  background: var(--void); color: var(--bone); border: 1px solid var(--gold-lo);',
    '  border-radius: 0; padding: 8px 10px; font-size: 13px; width: 100%; max-width: 320px;',
    '}',
    '.bw-tz-select:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '',
    '.bw-fields-summary { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }',
    '.bw-field-row { display: flex; gap: 10px; }',
    '.bw-field-label { color: var(--dim); min-width: 72px; flex-shrink: 0; }',
    '.bw-field-value { color: var(--bone); word-break: break-word; }',
    '.bw-field-label-inline { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin-block-end: 4px; }',
    '[dir="rtl"] .bw-field-label-inline { letter-spacing: 0; text-transform: none; }',
    '.bw-field-input {',
    '  width: 100%; background: transparent; color: var(--bone); font: inherit;',
    '  font-size: 15px; font-weight: 600; border: 0; border-block-end: 1px solid var(--gold-lo);',
    '  border-radius: 0; padding: 8px 2px 10px; outline: none; margin-block-end: 14px;',
    '}',
    '.bw-field-input:focus { border-block-end-color: var(--gold); }',
    '.bw-field-input:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '.bw-change-btn {',
    '  background: transparent; border: 0; border-radius: 0; color: var(--gold);',
    '  font-size: 12px; text-transform: uppercase; letter-spacing: .1em; cursor: pointer;',
    '  padding: 4px 0; margin-block-start: 4px;',
    '}',
    '[dir="rtl"] .bw-change-btn { letter-spacing: 0; text-transform: none; }',
    '.bw-change-btn:hover { color: var(--bone); }',
    '.bw-change-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '',
    '.bw-confirm-btn {',
    '  background: var(--gold); color: var(--ink); border: none; border-radius: 0;',
    '  font-family: "Big Shoulders Display", sans-serif; font-weight: 800; text-transform: uppercase;',
    '  padding: 13px 26px; font-size: 15px; letter-spacing: .05em; cursor: pointer;',
    '}',
    '[dir="rtl"] .bw-confirm-btn { font-family: "Changa", sans-serif; text-transform: none; }',
    '.bw-confirm-btn:disabled { opacity: .4; cursor: not-allowed; }',
    '.bw-confirm-btn:hover:not(:disabled) { background: var(--bone); }',
    '.bw-confirm-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }',
    '',
    '.bw-booked h4 {',
    '  font-family: "Big Shoulders Display", sans-serif; font-weight: 800; text-transform: uppercase;',
    '  font-size: 20px; color: var(--bone); margin: 0 0 8px;',
    '}',
    '[dir="rtl"] .bw-booked h4 { font-family: "Changa", sans-serif; text-transform: none; }',
    '.bw-booked p { color: var(--dim); font-size: 14px; line-height: 1.6; margin: 0; }',
  ].join('\n');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  var mountCounter = 0;

  function mount(container, options) {
    if (!container) throw new Error('BookingWidget.mount: container is required');
    options = options || {};
    injectStyles();

    var instanceId = 'bw' + (++mountCounter);
    var lang = options.lang === 'ar' ? 'ar' : 'en';
    var dir = options.dir === 'rtl' ? 'rtl' : (options.dir === 'ltr' ? 'ltr' : (lang === 'ar' ? 'rtl' : 'ltr'));
    var locale = localeForLang(lang);
    var texts = options.texts || {};
    var apiBase = options.apiBase || '';
    var rangeDays = (Number(options.rangeDays) > 0) ? Math.floor(Number(options.rangeDays)) : 14;
    var extraFields = options.extraFields || {};
    var onBooked = typeof options.onBooked === 'function' ? options.onBooked : function () {};
    var onDuplicate = typeof options.onDuplicate === 'function' ? options.onDuplicate : function () {};
    var onUnavailable = typeof options.onUnavailable === 'function' ? options.onUnavailable : function () {};

    var detectedTz = 'UTC';
    try {
      detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) { /* keep 'UTC' */ }

    // ---------------------------------------------------------------
    // STATE / RENDER DISCIPLINE: every render() rebuilds the container's
    // innerHTML from scratch, which would normally destroy whatever the
    // visitor is mid-typing. So typed values live ONLY here, mirrored on
    // every keystroke by the delegated 'input' listener below, and render()
    // reads them back out of `state` -- never out of the live DOM. The
    // day-strip's scrollLeft is saved/restored verbatim across every
    // render() for the same reason (see renderStrip/restoreScroll below).
    // ---------------------------------------------------------------
    var initialFieldsComplete = !!(extraFields.name && extraFields.email && extraFields.phone);
    var state = {
      range: {},
      orderedDayKeys: [],
      rangeEmpty: false,
      selectedDate: null,
      selectedStart: null,
      visitorTz: detectedTz,
      fields: {
        name: extraFields.name || '',
        email: extraFields.email || '',
        phone: extraFields.phone || '',
      },
      // If the Apply form already collected all three, show them read-only
      // (requirement: never re-ask). If any are missing, start in edit mode
      // so the visitor sees real inputs instead of a blank "summary".
      editingFields: !initialFieldsComplete,
      status: 'loading', // loading | ready | confirming | booked | unavailable
      notice: '',
      todayKey: localDateKey(),
      scrollToSelected: false,
      destroyed: false,
    };

    function render() {
      if (state.destroyed) return;
      var prevStrip = container.querySelector('.bw-day-strip');
      var savedScroll = prevStrip ? prevStrip.scrollLeft : 0;

      container.innerHTML = buildHTML();

      var newStrip = container.querySelector('.bw-day-strip');
      if (newStrip) newStrip.scrollLeft = savedScroll;

      if (state.scrollToSelected) {
        var selected = container.querySelector('.bw-day.is-selected');
        if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        state.scrollToSelected = false;
      }
    }

    function buildHTML() {
      var inner;
      if (state.status === 'loading') {
        inner = '<p class="bw-loading">' + escapeHtml(texts.loading) + '</p>';
      } else if (state.status === 'unavailable') {
        inner = '<p class="bw-unavailable">' + escapeHtml(texts.unavailable) + '</p>';
      } else if (state.status === 'booked') {
        inner = renderBooked();
      } else {
        inner = renderNotice();
        if (state.rangeEmpty) {
          inner += '<p class="bw-range-empty">' + escapeHtml(texts.no_slots_range) + '</p>';
        } else {
          inner += renderDaySection();
          if (state.selectedDate) {
            inner += renderTzSection();
            inner += renderTimeSection();
            if (state.selectedStart) {
              inner += renderContactSection();
              inner += renderConfirmSection();
            }
          }
        }
      }
      return '<div class="bw-widget" dir="' + dir + '">' + inner + '</div>';
    }

    function renderNotice() {
      if (!state.notice) return '';
      return '<p class="bw-notice" role="status" aria-live="polite">' + escapeHtml(state.notice) + '</p>';
    }

    function renderDaySection() {
      var idx = state.orderedDayKeys.indexOf(state.selectedDate);
      var prevDisabled = idx <= 0;
      var nextDisabled = idx === -1 || idx >= state.orderedDayKeys.length - 1;
      var out = '<div class="bw-section bw-section-day">';
      out += '<h4 class="bw-heading">' + escapeHtml(texts.pick_day) + '</h4>';
      out += '<div class="bw-day-row">';
      out += '<button type="button" class="bw-arrow-btn" data-bw-action="prev-day"' +
        (prevDisabled ? ' disabled' : '') + ' aria-label="prev"><span class="bw-arrow">‹</span></button>';
      out += '<div class="bw-day-strip">';
      for (var i = 0; i < state.orderedDayKeys.length; i++) {
        var key = state.orderedDayKeys[i];
        var selected = key === state.selectedDate;
        var isToday = key === state.todayKey;
        var label = dayLabelParts(key, locale);
        out += '<button type="button" class="bw-day' + (selected ? ' is-selected' : '') +
          '" data-bw-action="select-day" data-bw-day="' + escapeHtml(key) +
          '" aria-pressed="' + (selected ? 'true' : 'false') + '">';
        out += '<span class="bw-day-weekday">' + escapeHtml(label.weekday) + '</span>';
        out += '<span class="bw-day-num" dir="ltr">' + escapeHtml(label.dayNum) + '</span>';
        if (isToday) out += '<span class="bw-day-today">' + escapeHtml(texts.today) + '</span>';
        out += '</button>';
      }
      out += '</div>';
      out += '<button type="button" class="bw-arrow-btn" data-bw-action="next-day"' +
        (nextDisabled ? ' disabled' : '') + ' aria-label="next"><span class="bw-arrow">›</span></button>';
      out += '</div></div>';
      return out;
    }

    function renderTzSection() {
      var options = getTimezoneOptions(detectedTz);
      var out = '<div class="bw-section bw-tz-row">';
      out += '<label class="bw-heading" for="' + instanceId + '-tz">' + escapeHtml(texts.tz_label) + '</label>';
      out += '<select class="bw-tz-select" id="' + instanceId + '-tz" dir="ltr">';
      for (var i = 0; i < options.length; i++) {
        var tzName = options[i];
        var sel = tzName === state.visitorTz;
        var label = getTimezoneLabel(tzName, detectedTz, texts.tz_detected_suffix);
        out += '<option value="' + escapeHtml(tzName) + '"' + (sel ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }
      out += '</select></div>';
      return out;
    }

    function renderTimeSection() {
      var out = '<div class="bw-section bw-section-time">';
      out += '<h4 class="bw-heading">' + escapeHtml(texts.pick_time) + '</h4>';
      var slots = (state.range[state.selectedDate] || []).slice().sort(function (a, b) {
        return Date.parse(a.start) - Date.parse(b.start);
      });
      if (!slots.length) {
        out += '<p class="bw-no-slots">' + escapeHtml(texts.no_slots_day) + '</p>';
      } else {
        out += '<div class="bw-slots">';
        for (var i = 0; i < slots.length; i++) {
          var slot = slots[i];
          var selected = slot.start === state.selectedStart;
          var label = formatSlotTime(slot.start, locale, state.visitorTz);
          out += '<button type="button" class="bw-slot' + (selected ? ' is-selected' : '') +
            '" data-bw-action="select-slot" data-bw-start="' + escapeHtml(slot.start) +
            '" aria-pressed="' + (selected ? 'true' : 'false') + '">';
          out += '<span class="bw-slot-time" dir="ltr">' + escapeHtml(label) + '</span>';
          out += '</button>';
        }
        out += '</div>';
      }
      out += '</div>';
      return out;
    }

    // email/phone are technical latin strings (like the site's phone field
    // and .bl-num) and are forced dir="ltr" even in Arabic; a visitor's name
    // may itself be Arabic script, so it keeps the ambient direction.
    function forcesLtr(key) {
      return key === 'phone' || key === 'email';
    }

    function fieldInput(key, labelText) {
      var value = state.fields[key] || '';
      return '<label class="bw-field-label-inline" for="' + instanceId + '-' + key + '">' + escapeHtml(labelText) + '</label>' +
        '<input class="bw-field-input" type="text" id="' + instanceId + '-' + key + '" data-bw-field="' + key +
        '" value="' + escapeHtml(value) + '"' + (forcesLtr(key) ? ' dir="ltr"' : '') + '>';
    }

    function summaryRow(key, labelText) {
      var value = state.fields[key] || '';
      return '<div class="bw-field-row"><span class="bw-field-label">' + escapeHtml(labelText) + '</span>' +
        '<span class="bw-field-value"' + (forcesLtr(key) ? ' dir="ltr"' : '') + '>' + escapeHtml(value) + '</span></div>';
    }

    function renderContactSection() {
      var out = '<div class="bw-section bw-section-contact">';
      out += '<h4 class="bw-heading">' + escapeHtml(texts.your_details) + '</h4>';
      if (state.editingFields) {
        out += fieldInput('name', texts.name_label);
        out += fieldInput('email', texts.email_label);
        out += fieldInput('phone', texts.phone_label);
      } else {
        out += '<div class="bw-fields-summary">';
        out += summaryRow('name', texts.name_label);
        out += summaryRow('email', texts.email_label);
        out += summaryRow('phone', texts.phone_label);
        out += '</div>';
      }
      out += '<button type="button" class="bw-change-btn" data-bw-action="toggle-fields">' + escapeHtml(texts.change) + '</button>';
      out += '</div>';
      return out;
    }

    function fieldsComplete() {
      return !!((state.fields.name || '').trim() && (state.fields.email || '').trim() && (state.fields.phone || '').trim());
    }

    function renderConfirmSection() {
      var disabled = state.status === 'confirming' || !fieldsComplete() || !state.selectedStart;
      var label = state.status === 'confirming' ? texts.confirming : texts.confirm_btn;
      return '<div class="bw-section bw-section-confirm">' +
        '<button type="button" class="bw-confirm-btn" data-bw-action="confirm"' + (disabled ? ' disabled' : '') + '>' +
        escapeHtml(label) + '</button></div>';
    }

    function renderBooked() {
      return '<div class="bw-booked">' +
        '<h4>' + escapeHtml(texts.booked_title) + '</h4>' +
        '<p>' + escapeHtml(texts.booked_body) + '</p></div>';
    }

    // Toggles the confirm button's disabled state directly (no render()),
    // so a keystroke never rebuilds the DOM and steals focus/cursor
    // position out from under the visitor while they're mid-word.
    function syncConfirmButton() {
      var btn = container.querySelector('.bw-confirm-btn');
      if (!btn) return;
      btn.disabled = state.status === 'confirming' || !fieldsComplete() || !state.selectedStart;
    }

    function selectDay(key) {
      if (!key || key === state.selectedDate) return;
      state.selectedDate = key;
      state.selectedStart = null;
      state.notice = '';
      state.scrollToSelected = true;
      render();
    }

    function stepDay(delta) {
      var idx = state.orderedDayKeys.indexOf(state.selectedDate);
      if (idx === -1) return;
      var next = state.orderedDayKeys[idx + delta];
      if (next) selectDay(next);
    }

    function selectSlot(startIso) {
      state.selectedStart = startIso;
      render();
    }

    function toggleEditingFields() {
      state.editingFields = !state.editingFields;
      render();
    }

    function buildRangeUrl() {
      return apiBase + '/api/calendar-availability?date=' + encodeURIComponent(state.todayKey) +
        '&days=' + encodeURIComponent(String(rangeDays));
    }

    // isInitial gates the auto-select-first-open-day behaviour: the very
    // first fetch picks a day for the visitor (today's hours may have
    // already passed), but a silent refetch after a 409 race must NOT
    // re-run that logic -- requirement 4 says the day selection must
    // survive the race, not be recomputed out from under the visitor.
    function handleRangeResult(data, isInitial) {
      if (state.destroyed) return;
      if (!data || data.ok !== true) {
        var reason = (data && data.error) || 'UPSTREAM';
        state.status = 'unavailable';
        render();
        onUnavailable(reason);
        return;
      }
      state.range = data.days || {};
      state.orderedDayKeys = Object.keys(state.range).sort();
      var firstOpen = firstDayWithOpenings(state.range);
      state.rangeEmpty = firstOpen === null;
      if (isInitial) {
        state.selectedDate = firstOpen;
        state.scrollToSelected = !!firstOpen;
      }
      state.status = 'ready';
      render();
    }

    function fetchRange(isInitial) {
      if (isInitial) {
        state.status = 'loading';
        render();
      }
      return fetch(buildRangeUrl())
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (data) {
            return { httpStatus: res.status, data: data };
          });
        })
        .then(function (result) {
          handleRangeResult(result.data, isInitial);
        })
        .catch(function () {
          if (state.destroyed) return;
          state.status = 'unavailable';
          render();
          onUnavailable('UPSTREAM');
        });
    }

    function onConfirmClick() {
      // Guard against double-submit: a rapid second click/Enter before the
      // disabled attribute from the last render takes effect. Treated as a
      // duplicate submission attempt, not a new booking request.
      if (state.status === 'confirming') {
        onDuplicate();
        return;
      }
      if (!fieldsComplete() || !state.selectedStart) return;

      state.status = 'confirming';
      state.notice = '';
      render();

      var body = {
        name: state.fields.name.trim(),
        email: state.fields.email.trim(),
        phone: state.fields.phone.trim(),
        start: state.selectedStart,
        visitorTimeZone: state.visitorTz,
        lang: lang,
      };

      fetch(apiBase + '/api/calendar-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        if (state.destroyed) return;
        if (res.status === 200) {
          return res.json().then(function (data) {
            if (state.destroyed) return;
            state.status = 'booked';
            render();
            onBooked(data);
          });
        }
        if (res.status === 409) {
          // The expected race, not an error: another visitor took the slot
          // first. Clear only the slot selection, say so plainly, and
          // silently refetch that day -- the day itself stays selected.
          state.selectedStart = null;
          state.notice = texts.slot_taken || '';
          state.status = 'ready';
          render();
          return fetchRange(false);
        }
        state.status = 'ready';
        state.notice = texts.generic_error || '';
        render();
      }).catch(function () {
        if (state.destroyed) return;
        state.status = 'ready';
        state.notice = texts.generic_error || '';
        render();
      });
    }

    function onContainerClick(e) {
      var el = e.target.closest && e.target.closest('[data-bw-action]');
      if (!el) return;
      var action = el.getAttribute('data-bw-action');
      if (action === 'select-day') selectDay(el.getAttribute('data-bw-day'));
      else if (action === 'select-slot') selectSlot(el.getAttribute('data-bw-start'));
      else if (action === 'prev-day') stepDay(-1);
      else if (action === 'next-day') stepDay(1);
      else if (action === 'toggle-fields') toggleEditingFields();
      else if (action === 'confirm') onConfirmClick();
    }

    // Live input is mirrored into state on every keystroke (never read back
    // out of the DOM at render time) but deliberately does NOT trigger a
    // render() itself -- only syncConfirmButton()'s direct DOM write, so the
    // input element the visitor is typing into is never replaced mid-word.
    function onContainerInput(e) {
      var key = e.target.getAttribute && e.target.getAttribute('data-bw-field');
      if (!key) return;
      state.fields[key] = e.target.value;
      syncConfirmButton();
    }

    // The timezone <select> is the one exception: changing it is a discrete,
    // completed action (not an in-progress keystroke), so a full render() is
    // fine here and is in fact required -- it re-renders the slot LABELS
    // only, deliberately WITHOUT refetching (slots are absolute instants;
    // only their presentation changes).
    function onContainerChange(e) {
      if (e.target && e.target.classList && e.target.classList.contains('bw-tz-select')) {
        state.visitorTz = e.target.value;
        render();
      }
    }

    container.addEventListener('click', onContainerClick);
    container.addEventListener('input', onContainerInput);
    container.addEventListener('change', onContainerChange);

    render();
    fetchRange(true);

    return {
      destroy: function () {
        state.destroyed = true;
        container.removeEventListener('click', onContainerClick);
        container.removeEventListener('input', onContainerInput);
        container.removeEventListener('change', onContainerChange);
        container.innerHTML = '';
      },
    };
  }

  if (typeof window !== 'undefined') {
    window.BookingWidget = { mount: mount };
  }

  // Guarded CommonJS export so the pure, DOM-free helpers above are
  // testable under plain `node --test` with no browser and no build step.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __test: {
        firstDayWithOpenings: firstDayWithOpenings,
        formatSlotTime: formatSlotTime,
        localeForLang: localeForLang,
        dayLabelParts: dayLabelParts,
        localDateKey: localDateKey,
        getTimezoneOptions: getTimezoneOptions,
        getTimezoneLabel: getTimezoneLabel,
        escapeHtml: escapeHtml,
        FALLBACK_TIMEZONES: FALLBACK_TIMEZONES,
      },
    };
  }
})();
