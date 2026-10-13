'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithPuppeteerStub(request, parent, isMain) {
  if (request === 'puppeteer-core') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  attachRecordings,
  browserlessEndpoint,
  loginBlocker,
  parseAgendaMeeting,
  parseRecordingLink,
  weekDates,
} = require('./outschool');
Module._load = originalLoad;

test('adds an authenticated profile to the Browserless endpoint', () => {
  assert.equal(
    browserlessEndpoint('https://production-sfo.browserless.io', 'test-token', 'outschool'),
    'wss://production-sfo.browserless.io/stealth?token=test-token&profile=outschool',
  );
});

test('detects Outschool device integrity failures', () => {
  assert.equal(
    loginBlocker('Your device failed an integrity check. Please refresh the page to try again, or login a different way'),
    'LOGIN_INTEGRITY_CHECK_FAILED (Outschool rejected the remote browser; use a Browserless authenticated profile)',
  );
});

test('detects interactive login challenges', () => {
  assert.equal(loginBlocker('Please verify you are human'), 'LOGIN_CHALLENGE (captcha or verification code)');
});

test('returns no blocker for a normal login page', () => {
  assert.equal(loginBlocker('Log In with Email'), undefined);
});

test('validates a bounded seven-day request', () => {
  assert.deepEqual(weekDates('2026-09-21', '2026-09-27'), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
    '2026-09-25', '2026-09-26', '2026-09-27',
  ]);
  assert.throws(() => weekDates('2026-09-21', '2026-09-28'), /must not exceed 7 days/);
});

test('parses an agenda meeting without inferring cancellation', () => {
  assert.deepEqual(
    parseAgendaMeeting({
      date: '2026-09-21',
      href: '/classroom/11111111-2222-4333-8444-555555555555',
      lines: [
        'Example Class',
        '9:00 – 9:50 AM Eastern · 4th meeting of 12',
        'Example Teacher · 3 enrolled · 1 waitlisted',
      ],
    }),
    {
      date: '2026-09-21',
      class_title: 'Example Class',
      scheduled_time_eastern: '9:00 – 9:50 AM',
      scheduled_start: '2026-09-21T21:00:00+08:00',
      scheduled_end: '2026-09-21T21:50:00+08:00',
      teacher: 'Example Teacher',
      active_enrolled: 3,
      meeting_number: 4,
      meeting_count: 12,
      section_id: '11111111-2222-4333-8444-555555555555',
      classroom_url: 'https://outschool.com/classroom/11111111-2222-4333-8444-555555555555',
      section_url: 'https://outschool.com/sections/11111111-2222-4333-8444-555555555555',
      recordings_url: 'https://outschool.com/sections/11111111-2222-4333-8444-555555555555/recordings',
      cancellation_status: 'unverified',
    },
  );
});

test('ignores a leading agenda status when parsing the scheduled time', () => {
  const meeting = parseAgendaMeeting({
    date: '2026-09-21',
    href: '/classroom/11111111-2222-4333-8444-555555555555',
    lines: [
      'Example Class',
      'Updated 3:00 – 3:50 PM Eastern · 4th meeting of 12',
      'Example Teacher · 3 enrolled',
    ],
  });
  assert.equal(meeting.scheduled_time_eastern, '3:00 – 3:50 PM');
  assert.equal(meeting.scheduled_start, '2026-09-22T03:00:00+08:00');
  assert.equal(meeting.scheduled_end, '2026-09-22T03:50:00+08:00');
  assert.equal(meeting.cancellation_status, 'unverified');
});

test('parses and matches a recording to the closest meeting', () => {
  const recording = parseRecordingLink({
    text: 'Mon, Sep 21, 8:58 – 9:51 AM Eastern, Example Teacher',
    href: 'https://outschool.com/classroom/section/recording/recording-id?token=secret',
  }, ['2026-09-21', '2026-09-22']);
  assert.deepEqual(recording, {
    date: '2026-09-21',
    actual_start: '2026-09-21T20:58:00+08:00',
    actual_end: '2026-09-21T21:51:00+08:00',
    recording_url: 'https://outschool.com/classroom/section/recording/recording-id',
  });
  const [result] = attachRecordings([{
    date: '2026-09-21', section_id: 'section', active_enrolled: 1,
    scheduled_start: '2026-09-21T21:00:00+08:00',
  }], new Map([['section', [recording]]]));
  assert.equal(result.recording_status, 'ready');
  assert.equal(result.actual_start, '2026-09-21T20:58:00+08:00');
});

test('marks missing recordings for review and skips zero-enrollment lookup', () => {
  const results = attachRecordings([
    { date: '2026-09-21', section_id: 'missing', active_enrolled: 1, scheduled_start: '2026-09-21T21:00:00+08:00' },
    { date: '2026-09-21', section_id: 'empty', active_enrolled: 0, scheduled_start: '2026-09-21T21:00:00+08:00' },
  ], new Map());
  assert.equal(results[0].recording_status, 'missing_or_processing');
  assert.equal(results[1].recording_status, 'not_applicable');
});
