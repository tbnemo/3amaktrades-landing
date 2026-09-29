const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const slack = require('../api/_slack');
const email = require('../api/_email');
const audience = require('../api/_checkin-audience');

test('the check-in blob names are exported with their exact spec values', () => {
  assert.equal(store.CHECKIN_AVAILABILITY_BLOB, 'checkin-availability-template.json');
  assert.equal(store.CHECKIN_CLIENTS_BLOB, 'checkin-clients.json');
  assert.equal(store.CHECKIN_VERIFY_ATTEMPTS_BLOB, 'checkin-verify-attempts.json');
});

test('the check-in blob names do not collide with the existing three', () => {
  const all = [
    store.AVAILABILITY_BLOB, store.OAUTH_BLOB, store.LOGIN_ATTEMPTS_BLOB,
    store.CHECKIN_AVAILABILITY_BLOB, store.CHECKIN_CLIENTS_BLOB, store.CHECKIN_VERIFY_ATTEMPTS_BLOB,
  ];
  assert.equal(new Set(all).size, all.length, `blob names must be unique: ${all.join(', ')}`);
});

// The IDs themselves are workspace data this test cannot know, but their SHAPE
// and their distinctness are exactly the two ways a copy-paste goes wrong: a
// placeholder left in, or the same channel pasted twice.
test('the three check-in Slack channel constants are real, distinct Slack channel IDs', () => {
  const ids = [
    slack.CHANNEL_CHECKIN_BOOKED,
    slack.CHANNEL_CHECKIN_RESCHEDULED,
    slack.CHANNEL_CHECKIN_CANCELLED,
  ];
  for (const id of ids) {
    assert.equal(typeof id, 'string');
    assert.match(id, /^C[A-Z0-9]{7,}$/, `"${id}" is not a Slack channel ID`);
  }
  assert.equal(new Set(ids).size, 3, 'the three check-in channels must be three different channels');
});

test('the check-in channels are distinct from all seven existing channels', () => {
  const existing = [
    slack.CHANNEL_NEW_APPLICATIONS, slack.CHANNEL_INCOMPLETE_LEADS, slack.CHANNEL_WARM_LEADS,
    slack.CHANNEL_NEW_CALLS_BOOKED, slack.CHANNEL_RESCHEDULED_CALLS,
    slack.CHANNEL_CANCELLED_CALLS, slack.CHANNEL_SYSTEM_ALERTS,
  ];
  const added = [
    slack.CHANNEL_CHECKIN_BOOKED, slack.CHANNEL_CHECKIN_RESCHEDULED, slack.CHANNEL_CHECKIN_CANCELLED,
  ];
  for (const id of added) {
    assert.ok(!existing.includes(id), `${id} is already one of the applicant/system channels`);
  }
});

test('_email exports send so the check-in senders can reuse the Resend transport', () => {
  assert.equal(typeof email.send, 'function');
  assert.equal(typeof email.formatWhen, 'function');
});

test('send with no RESEND_API_KEY resolves to {ok:false} rather than throwing', async () => {
  const had = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const r = await email.send({ to: 'a@b.co', subject: 's', html: '<p>h</p>' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /RESEND_API_KEY/);
  } finally {
    if (had !== undefined) process.env.RESEND_API_KEY = had;
  }
});

test('AUDIENCE_CHECKIN is the exact string "checkin"', () => {
  assert.equal(audience.AUDIENCE_CHECKIN, 'checkin');
});

test('isCheckinEvent is true only for meta tagged checkin', () => {
  assert.equal(audience.isCheckinEvent({ audience: 'checkin' }), true);
  assert.equal(audience.isCheckinEvent({ audience: 'applicant' }), false);
  // The applicant flow sets no audience field at all -- absence means applicant.
  assert.equal(audience.isCheckinEvent({ bookingSource: '3amak-booking' }), false);
  assert.equal(audience.isCheckinEvent({}), false);
  assert.equal(audience.isCheckinEvent(null), false);
  assert.equal(audience.isCheckinEvent(undefined), false);
});
