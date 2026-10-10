'use strict';
const puppeteer = require('puppeteer-core');
const zoho = require('./zoho');

async function login(page, { username, password }) {
  const canonicalLoginUrl = 'https://outschool.com/users/login';
  const configuredLoginUrl = process.env.OUTSCHOOL_LOGIN_URL || canonicalLoginUrl;
  await page.goto(configuredLoginUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  const emailSel = '[data-test-id="login-form-email"]';
  const passSel = '[data-test-id="login-form-password"]';
  if (!(await page.$(emailSel)) && /^https:\/\/outschool\.com\/login\/?$/i.test(configuredLoginUrl)) {
    await page.goto(canonicalLoginUrl, { waitUntil: 'networkidle2', timeout: 45000 });
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
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, { timeout: 30000 }, submitSel).catch(() => {
    throw new Error('LOGIN_CHALLENGE (login form did not become ready)');
  });
  await page.click(submitSel);
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
  const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  if (/captcha|verify you are human|verification code|two-step|2-step/.test(text)) throw new Error('LOGIN_CHALLENGE (captcha or verification code)');
  const stillOnLogin = new URL(page.url()).pathname.replace(/\/+$/, '') === '/users/login';
  if (stillOnLogin && (await page.$(passSel))) {
    const formText = await page.$eval(emailSel, (input) => input.closest('form')?.innerText || '');
    const message = formText.split('\n').map((line) => line.trim()).find((line) =>
      /please check|incorrect|invalid|unable|could not|try again|error|captcha|verify|verification|two-step|2-step/i.test(line));
    throw new Error(`LOGIN_FAILED (${message || 'Outschool rejected the credentials'})`);
  }
}

async function withPage(fn) {
  const z = await zoho.run({ includeSecret: true });
  if (!z.ok) throw new Error('Zoho step failed: ' + JSON.stringify(z.steps[z.steps.length - 1]));
  if (!process.env.BROWSERLESS_TOKEN) throw new Error('BROWSERLESS_TOKEN is missing');
  const endpoint = new URL(process.env.BROWSERLESS_URL || 'https://production-sfo.browserless.io/stealth');
  if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/stealth';
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  endpoint.searchParams.set('token', process.env.BROWSERLESS_TOKEN);
  const browser = await puppeteer.connect({ browserWSEndpoint: endpoint.toString() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await login(page, z.credentials);
    return await fn(page, z.credentials);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Logs in, opens one Outschool URL, and returns a redacted text snapshot so we can find the right selectors.
async function probe(url) {
  return withPage(async (page, cred) => {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    let text = await page.evaluate(() => document.body.innerText);
    for (const secret of [cred.username, cred.password]) text = text.split(secret).join('[redacted]');
    return { title: await page.title(), finalUrl: page.url(), text: text.slice(0, 4000) };
  });
}

module.exports = { probe };
