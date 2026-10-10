'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseEasternRecordingTime } = require('./recordings');

test('converts an Eastern daylight-saving recording to Manila time', () => {
  assert.deepEqual(
    parseEasternRecordingTime('Sat, Oct 3, 9:59 – 10:49 AM Eastern', 2026),
    {
      actual_start: '2026-10-03T21:59:00+08:00',
      actual_end: '2026-10-03T22:49:00+08:00',
    },
  );
});

test('uses standard time after the November daylight-saving change', () => {
  assert.deepEqual(
    parseEasternRecordingTime('Sat, Nov 7, 10:00 – 10:50 AM Eastern', 2026),
    {
      actual_start: '2026-11-07T23:00:00+08:00',
      actual_end: '2026-11-07T23:50:00+08:00',
    },
  );
});

test('uses daylight time after the March daylight-saving change', () => {
  assert.deepEqual(
    parseEasternRecordingTime('Sat, Mar 14, 10:00 – 10:50 AM Eastern', 2026),
    {
      actual_start: '2026-03-14T22:00:00+08:00',
      actual_end: '2026-03-14T22:50:00+08:00',
    },
  );
});

test('infers the missing start meridiem across noon', () => {
  assert.deepEqual(
    parseEasternRecordingTime('Sat, Oct 3, 11:30 – 12:20 PM Eastern', 2026),
    {
      actual_start: '2026-10-03T23:30:00+08:00',
      actual_end: '2026-10-04T00:20:00+08:00',
    },
  );
});

test('accepts a year included in the recording text', () => {
  assert.deepEqual(
    parseEasternRecordingTime('Oct 3, 2026, 9:59 - 10:49 AM Eastern'),
    {
      actual_start: '2026-10-03T21:59:00+08:00',
      actual_end: '2026-10-03T22:49:00+08:00',
    },
  );
});
