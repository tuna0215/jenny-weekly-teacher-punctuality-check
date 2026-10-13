'use strict';
const puppeteer = require('puppeteer-core');
const zoho = require('./zoho');
const { parseEasternRecordingTime } = require('./recordings');

const LOGIN_URL = 'https://outschool.com/users/login';
const AUTHENTICATED_SELECTORS = [
  'a[href="/conversations"]',
  'a[href="/organization"]',
  'a[href^="/parents/"]',
];

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function weekDates(weekStart, weekEnd) {
  if (!ISO_DATE.test(weekStart) || !ISO_DATE.test(weekEnd)) {
    throw new Error('weekStart and weekEnd must use YYYY-MM-DD');
  }
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) {
    throw new Error('weekStart must be on or before weekEnd');
  }
  const dates = [];
  for (let date = start; date <= end; date = new Date(date.valueOf() + 86_400_000)) {
    dates.push(date.toISOString().slice(0, 10));
    if (dates.length > 7) throw new Error('date range must not exceed 7 days');
  }
  return dates;
}

function dateKey(isoDate) {
  const [, month, day] = isoDate.split('-').map(Number);
  return `${month}-${day}`;
}

function parseAgendaMeeting(raw) {
  const lines = Array.isArray(raw.lines) ? raw.lines.map((line) => String(line).trim()).filter(Boolean) : [];
  if (lines.length < 3) throw new Error('agenda meeting is missing expected text');
  const meeting = lines[1].match(/^(.*?)\s+Eastern\s+·\s+(\d+)(?:st|nd|rd|th)\s+meeting\s+of\s+(\d+)$/i);
  const enrolled = lines[2].match(/^(.*?)\s+·\s+(\d+)\s+enrolled\b/i);
  const sectionId = String(raw.href || '').match(/^\/classroom\/([0-9a-f-]+)(?:[/?#]|$)/i)?.[1];
  if (!meeting || !enrolled || !sectionId || !ISO_DATE.test(String(raw.date || ''))) {
    throw new Error('agenda meeting format is unsupported');
  }
  const [year, month, day] = String(raw.date).split('-').map(Number);
  const [scheduledRange] = meeting.slice(1);
  const scheduled = parseEasternRecordingTime(
    `${MONTH_LABELS[month - 1]} ${day}, ${year}, ${scheduledRange} Eastern`,
    year,
  );
  return {
    date: raw.date,
    class_title: lines[0],
    scheduled_time_eastern: scheduledRange,
    scheduled_start: scheduled.actual_start,
    scheduled_end: scheduled.actual_end,
    teacher: enrolled[1].trim(),
    active_enrolled: Number(enrolled[2]),
    meeting_number: Number(meeting[2]),
    meeting_count: Number(meeting[3]),
    section_id: sectionId,
    classroom_url: `https://outschool.com/classroom/${sectionId}`,
    section_url: `https://outschool.com/sections/${sectionId}`,
    recordings_url: `https://outschool.com/sections/${sectionId}/recordings`,
    cancellation_status: 'unverified',
  };
}

function parseRecordingLink(raw, allowedDates) {
  const text = String(raw.text || '').trim();
  const date = text.match(/(?:[A-Za-z]{3,9},\s*)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?,/);
  if (!date) return undefined;
  const month = MONTHS.get(date[1].toLowerCase());
  if (!month) return undefined;
  const candidates = allowedDates.filter((isoDate) => {
    const [year, candidateMonth, day] = isoDate.split('-').map(Number);
    return candidateMonth === month && day === Number(date[2]) && (!date[3] || year === Number(date[3]));
  });
  if (candidates.length !== 1) return undefined;
  try {
    const actual = parseEasternRecordingTime(text, Number(candidates[0].slice(0, 4)));
    return {
      date: candidates[0],
      actual_start: actual.actual_start,
      actual_end: actual.actual_end,
      recording_url: String(raw.href || '').split('?')[0],
    };
  } catch {
    return undefined;
  }
}

function attachRecordings(meetings, recordingsBySection) {
  return meetings.map((meeting) => {
    if (meeting.active_enrolled === 0) return { ...meeting, recording_status: 'not_applicable' };
    const candidates = (recordingsBySection.get(meeting.section_id) || [])
      .filter((recording) => recording.date === meeting.date)
      .sort((a, b) => Math.abs(new Date(a.actual_start) - new Date(meeting.scheduled_start))
        - Math.abs(new Date(b.actual_start) - new Date(meeting.scheduled_start)));
    if (!candidates.length) return { ...meeting, recording_status: 'missing_or_processing' };
    return { ...meeting, ...candidates[0], recording_status: 'ready' };
  });
}

const loginBlocker = (text) => {
  const normalized = String(text || '').toLowerCase();
  if (normalized.includes('your device failed an integrity check')) {
    return 'LOGIN_INTEGRITY_CHECK_FAILED (Outschool rejected the remote browser; use a Browserless authenticated profile)';
  }
  if (/captcha|verify you are human|verification code|two-step|2-step/.test(normalized)) {
    return 'LOGIN_CHALLENGE (captcha or verification code)';
  }
  return undefined;
};

async function hasAuthenticatedSession(page) {
  await page.goto('https://outschool.com/', { waitUntil: 'networkidle2', timeout: 45000 });
  return page.evaluate((selectors) => selectors.some((selector) => document.querySelector(selector)), AUTHENTICATED_SELECTORS);
}

const browserlessEndpoint = (baseUrl, token, profile) => {
  const endpoint = new URL(baseUrl || 'https://production-sfo.browserless.io/stealth');
  if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/stealth';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  endpoint.searchParams.set('token', token);
  if (profile) endpoint.searchParams.set('profile', profile);
  return endpoint.toString();
};

async function loadCredentials() {
  const z = await zoho.run({ includeSecret: true });
  if (!z.ok) throw new Error('Zoho step failed: ' + JSON.stringify(z.steps[z.steps.length - 1]));
  return z.credentials;
}

async function login(page, { username, password }) {
  const configuredLoginUrl = process.env.OUTSCHOOL_LOGIN_URL || LOGIN_URL;
  await page.goto(configuredLoginUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  const emailSel = '[data-test-id="login-form-email"]';
  const passSel = '[data-test-id="login-form-password"]';
  if (!(await page.$(emailSel)) && /^https:\/\/outschool\.com\/login\/?$/i.test(configuredLoginUrl)) {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 45000 });
  }
  await page.waitForSelector(emailSel, { visible: true, timeout: 15000 });
  await page.type(emailSel, username.trim(), { delay: 30 });
  if (!(await page.$(passSel))) {
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector(passSel, { visible: true, timeout: 15000 });
  await page.type(passSel, password, { delay: 30 });
  const submitSel = 'form:has([data-test-id="login-form-email"]) button[type="submit"]';
  await page.waitForSelector(submitSel, { visible: true, timeout: 15000 });
  await page.waitForFunction((selector) => {
    const button = document.querySelector(selector);
    const body = document.body?.innerText?.toLowerCase() || '';
    return body.includes('your device failed an integrity check')
      || /captcha|verify you are human|verification code|two-step|2-step/.test(body)
      || (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  }, { timeout: 30000 }, submitSel).catch(() => {
    throw new Error('LOGIN_CHALLENGE (login form did not become ready)');
  });
  const beforeSubmitBlocker = loginBlocker(await page.evaluate(() => document.body.innerText));
  if (beforeSubmitBlocker) throw new Error(beforeSubmitBlocker);
  await page.click(submitSel);
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText);
  const afterSubmitBlocker = loginBlocker(text);
  if (afterSubmitBlocker) throw new Error(afterSubmitBlocker);
  const stillOnLogin = new URL(page.url()).pathname.replace(/\/+$/, '') === '/users/login';
  if (stillOnLogin && (await page.$(passSel))) {
    const formText = await page.$eval(emailSel, (input) => input.closest('form')?.innerText || '');
    const message = formText.split('\n').map((line) => line.trim()).find((line) =>
      /please check|incorrect|invalid|unable|could not|try again|error|captcha|verify|verification|two-step|2-step/i.test(line));
    throw new Error(`LOGIN_FAILED (${message || 'Outschool rejected the credentials'})`);
  }
}

async function withPage(fn) {
  if (!process.env.BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN is missing');
  const endpoint = browserlessEndpoint(
    process.env.BROWSERLESS_URL,
    process.env.BROWSERLESS_TOKEN,
    process.env.BROWSERLESS_PROFILE,
  );
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone(process.env.OUTSCHOOL_TIMEZONE || 'America/New_York');
    await page.setViewport({ width: 1280, height: 900 });
    let credentials;
    if (!(await hasAuthenticatedSession(page))) {
      credentials = await loadCredentials();
      await login(page, credentials);
    }
    return await fn(page, credentials, browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Logs in, opens one Outschool URL, and returns a redacted text snapshot so we can find the right selectors.
async function probe(url) {
  return withPage(async (page, cred) => {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2000));
    if (new URL(url).pathname === '/organization/schedule') {
      await page.waitForFunction(() =>
        document.querySelectorAll('a[href^="/sections/"], a[href^="/classroom/"]').length > 1,
      { timeout: 15000 }).catch(() => {});
    }
    let text = await page.evaluate(() => document.body.innerText);
    const links = await page.evaluate(() => {
      const all = [...document.querySelectorAll('a[href]')];
      const schedule = all.filter((a) => /^\/(?:sections|classroom)\//.test(a.getAttribute('href') || ''));
      const seen = new Set();
      return [...schedule, ...all]
        .filter((a) => {
          const key = `${a.getAttribute('href')}\n${(a.innerText || '').trim()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 160)
        .map((a) => ({ t: (a.innerText || '').trim().slice(0, 160), h: a.getAttribute('href') }));
    });
    const media = await page.evaluate(() =>
      [...document.querySelectorAll('video source, video, audio')].map((m) => (m.currentSrc || m.src || '').split('?')[0]).filter(Boolean));
    let redactionCredentials = cred;
    if (!redactionCredentials) {
      try { redactionCredentials = await loadCredentials(); } catch { /* keep probing if Zoho is unavailable */ }
    }
    for (const secret of [redactionCredentials?.username, redactionCredentials?.password].filter(Boolean)) {
      text = text.split(secret).join('[redacted]');
    }
    return { title: await page.title(), finalUrl: page.url(), text: text.slice(0, 4000), links, media };
  });
}

async function classesForDates(allowedDates) {
  const weekStart = allowedDates[0];
  const allowedByKey = Object.fromEntries(allowedDates.map((date) => [dateKey(date), date]));
  return withPage(async (page, _credentials, browser) => {
    const scheduleUrl = `https://outschool.com/organization/schedule?view=agenda&date=${weekStart}`;
    await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('a[href^="/classroom/"]')]
        .some((anchor) => /\d{1,2}:\d{2}/.test(anchor.innerText || '')),
    { timeout: 15000 });
    const rawMeetings = await page.evaluate((dateLookup) => {
      const months = {
        jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
        apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
        aug: 8, august: 8, sep: 9, sept: 9, september: 9,
        oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
      };
      return [...document.querySelectorAll('a[href^="/classroom/"]')]
        .filter((anchor) => /\d{1,2}:\d{2}/.test(anchor.innerText || ''))
        .map((anchor) => {
          const eventList = anchor.parentElement;
          const dayContainer = eventList?.parentElement;
          const header = [...(dayContainer?.children || [])].find((child) => child !== eventList);
          const headerParts = String(header?.innerText || '').split('\n').map((part) => part.trim()).filter(Boolean);
          const month = headerParts.map((part) => months[part.toLowerCase()]).find(Boolean);
          const day = headerParts.map(Number).find((value) => Number.isInteger(value) && value >= 1 && value <= 31);
          return {
            date: month && day ? dateLookup[`${month}-${day}`] : undefined,
            href: anchor.getAttribute('href'),
            lines: String(anchor.innerText || '').split('\n'),
          };
        })
        .filter((meeting) => meeting.date);
    }, allowedByKey);

    const meetings = rawMeetings.map(parseAgendaMeeting);
    const uniqueSections = [...new Set(meetings
      .filter((meeting) => meeting.active_enrolled > 0)
      .map((meeting) => meeting.section_id))];
    const recordingsBySection = new Map();
    await page.close();
    async function fetchSections(sectionIds, concurrency, readyTimeout) {
      const failed = [];
      let nextSection = 0;
      const workerCount = Math.min(concurrency, sectionIds.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        const workerPage = await browser.newPage();
        await workerPage.emulateTimezone(process.env.OUTSCHOOL_TIMEZONE || 'America/New_York');
        await workerPage.setRequestInterception(true);
        workerPage.on('request', (request) => {
          if (['font', 'image', 'media'].includes(request.resourceType())) request.abort();
          else request.continue();
        });
        try {
          while (nextSection < sectionIds.length) {
            const sectionId = sectionIds[nextSection];
            nextSection += 1;
            try {
              await workerPage.goto(`https://outschool.com/sections/${sectionId}/recordings`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000,
              });
              await workerPage.waitForFunction(() =>
                document.querySelector('a[href*="/recording/"]')
                || /no recordings|processing/i.test(document.body?.innerText || ''),
              { timeout: readyTimeout }).catch(() => {});
              const pageState = await workerPage.evaluate(() => ({
                recordings: [...document.querySelectorAll('a[href*="/recording/"]')].map((anchor) => ({
                  text: (anchor.innerText || '').trim(),
                  href: anchor.href,
                })),
                hasEmptyState: /no recordings|processing|not available/i.test(document.body?.innerText || ''),
                isLogin: /\/users\/login\/?$/.test(window.location.pathname),
              }));
              if (pageState.isLogin || (!pageState.recordings.length && !pageState.hasEmptyState)) {
                throw new Error('recordings page did not reach a recognized state');
              }
              recordingsBySection.set(sectionId, pageState.recordings
                .map((recording) => parseRecordingLink(recording, allowedDates))
                .filter(Boolean));
            } catch {
              failed.push(sectionId);
              recordingsBySection.set(sectionId, []);
            }
          }
        } finally {
          await workerPage.close().catch(() => {});
        }
      }));
      return failed;
    }

    let failedSections = await fetchSections(uniqueSections, 8, 6000);
    if (failedSections.length) failedSections = await fetchSections(failedSections, 3, 8000);

    return {
      classes: attachRecordings(meetings, recordingsBySection),
      failedSectionCount: failedSections.length,
    };
  });
}

async function classes(weekStart, weekEnd) {
  const allowedDates = weekDates(weekStart, weekEnd);
  const dailyResults = new Array(allowedDates.length);
  for (let index = 0; index < allowedDates.length; index += 1) {
    dailyResults[index] = await classesForDates([allowedDates[index]]);
  }

  const failedSectionCount = dailyResults
    .reduce((total, result) => total + result.failedSectionCount, 0);
  const warnings = ['Cancellation wording is unverified; cancellation_status is not inferred.'];
  if (failedSectionCount) {
    warnings.push(`${failedSectionCount} section recording page(s) could not be loaded; those classes require review.`);
  }
  return {
    source: 'outschool_organization_schedule',
    timeZone: 'America/New_York',
    weekStart,
    weekEnd,
    classes: dailyResults.flatMap((result) => result.classes),
    warnings,
  };
}

module.exports = {
  attachRecordings,
  browserlessEndpoint,
  classes,
  loginBlocker,
  parseAgendaMeeting,
  parseRecordingLink,
  probe,
  weekDates,
};
