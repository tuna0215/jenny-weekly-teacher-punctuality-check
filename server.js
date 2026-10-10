'use strict';
const express = require('express');
const zoho = require('./zoho');
const outschool = require('./outschool');

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

app.post('/probe', auth, async (req, res) => {
  const url = String(req.body?.url || '');
  if (!/^https:\/\/([a-z0-9-]+\.)?outschool\.com\//i.test(url)) return res.status(400).json({ error: 'url must be on outschool.com' });
  try { res.json(await outschool.probe(url)); }
  catch (e) { res.status(500).json({ error: String(e.message).slice(0, 300) }); }
});

app.listen(process.env.PORT || 3000, () => console.log('service listening'));
