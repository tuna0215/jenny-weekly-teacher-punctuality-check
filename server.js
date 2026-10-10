'use strict';
const express = require('express');
const zoho = require('./zoho');

const app = express();
app.use(express.json({ limit: '1mb' }));

const auth = (req, res, next) => {
  const key = process.env.SERVICE_API_KEY;
  if (!key || req.get('x-api-key') !== key) return res.status(401).json({ error: 'unauthorized' });
  next();
};

app.get('/health', (_req, res) => res.json({ ok: true }));

// Runs the Zoho chain and reports pass/fail per step. Never returns the credentials.
app.get('/selfcheck', auth, async (_req, res) => res.json(await zoho.run({ includeSecret: false })));

// Stage 2 (not enabled until /selfcheck passes and Outschool selectors are tested on a real page).
app.post('/classes', auth, (_req, res) => res.status(501).json({ error: 'not implemented yet' }));

app.listen(process.env.PORT || 3000, () => console.log('service listening'));