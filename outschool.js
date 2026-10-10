'use strict';
const puppeteer = require('puppeteer-core');
const zoho = require('./zoho');

const LOGIN_URL = 'https://outschool.com/users/login';
const AUTHENTICATED_SELECTORS = [
  'a[href="/conversations"]',
  'a[href="/organization"]',
  'a[href^="/parents/"]',
];

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
    return await fn(page, credentials);
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
    for (const secret of [cred?.username, cred?.password].filter(Boolean)) text = text.split(secret).join('[redacted]');
    return { title: await page.title(), finalUrl: page.url(), text: text.slice(0, 4000), links, media };
  });
}

module.exports = { browserlessEndpoint, loginBlocker, probe };
