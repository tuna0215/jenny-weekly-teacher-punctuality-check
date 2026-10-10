'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithPuppeteerStub(request, parent, isMain) {
  if (request === 'puppeteer-core') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { browserlessEndpoint, loginBlocker } = require('./outschool');
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
