'use strict';

const EASTERN_TIME_ZONE = 'America/New_York';
const MANILA_OFFSET_MINUTES = 8 * 60;

const MONTHS = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const formatterParts = (date) => Object.fromEntries(
  easternFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]),
);

function easternWallTimeToUtc({ year, month, day, hour, minute }) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = desiredAsUtc;

  // Two passes handle both EST and EDT without hard-coding transition dates.
  for (let i = 0; i < 2; i += 1) {
    const actual = formatterParts(new Date(instant));
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    instant += desiredAsUtc - actualAsUtc;
  }

  const check = formatterParts(new Date(instant));
  if (check.year !== year || check.month !== month || check.day !== day
    || check.hour !== hour || check.minute !== minute) {
    throw new Error('Eastern time falls in a daylight-saving transition gap');
  }
  return instant;
}

function clockMinutes(hour, minute, meridiem) {
  let normalizedHour = hour % 12;
  if (meridiem === 'PM') normalizedHour += 12;
  return normalizedHour * 60 + minute;
}

function inferStartMeridiem(start, end) {
  if (start.meridiem) return start.meridiem;
  const choices = ['AM', 'PM'].map((meridiem) => {
    const startMinutes = clockMinutes(start.hour, start.minute, meridiem);
    let duration = clockMinutes(end.hour, end.minute, end.meridiem) - startMinutes;
    if (duration <= 0) duration += 24 * 60;
    return { meridiem, duration };
  });
  const plausible = choices.filter(({ duration }) => duration <= 12 * 60);
  return (plausible.length ? plausible : choices)
    .sort((a, b) => a.duration - b.duration)[0].meridiem;
}

function parseClock(hour, minute, meridiem) {
  const parsed = {
    hour: Number(hour),
    minute: Number(minute),
    meridiem: meridiem?.toUpperCase(),
  };
  if (parsed.hour < 1 || parsed.hour > 12 || parsed.minute < 0 || parsed.minute > 59) {
    throw new Error('Invalid recording time');
  }
  return parsed;
}

function manilaIso(utcMilliseconds) {
  const local = new Date(utcMilliseconds + MANILA_OFFSET_MINUTES * 60_000);
  return `${local.toISOString().slice(0, 19)}+08:00`;
}

function parseEasternRecordingTime(text, defaultYear) {
  const normalized = String(text || '')
    .replace(/[\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(
    /(?:[A-Za-z]{3,9},\s*)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?,\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*(?:Eastern|ET)?/i,
  );
  if (!match) throw new Error('Unrecognized Eastern recording time');

  const month = MONTHS.get(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3] || defaultYear);
  if (!month || !year || day < 1 || day > 31) throw new Error('Recording date needs a valid year');

  const start = parseClock(match[4], match[5], match[6]);
  const end = parseClock(match[7], match[8], match[9]);
  start.meridiem = inferStartMeridiem(start, end);

  const startMinutes = clockMinutes(start.hour, start.minute, start.meridiem);
  const endMinutes = clockMinutes(end.hour, end.minute, end.meridiem);
  const startUtc = easternWallTimeToUtc({
    year, month, day,
    hour: Math.floor(startMinutes / 60),
    minute: startMinutes % 60,
  });

  const endDate = new Date(Date.UTC(year, month - 1, day));
  if (endMinutes <= startMinutes) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endUtc = easternWallTimeToUtc({
    year: endDate.getUTCFullYear(),
    month: endDate.getUTCMonth() + 1,
    day: endDate.getUTCDate(),
    hour: Math.floor(endMinutes / 60),
    minute: endMinutes % 60,
  });

  return {
    actual_start: manilaIso(startUtc),
    actual_end: manilaIso(endUtc),
  };
}

module.exports = { parseEasternRecordingTime };
