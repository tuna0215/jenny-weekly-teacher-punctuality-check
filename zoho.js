'use strict';
// Zoho Vault access. Secrets come ONLY from environment variables. Nothing here logs secret values.
const Vault = require('./zoho-vault-crypto.cjs');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const cfg = () => ({
  accounts: env('ZOHO_ACCOUNTS_URL', 'https://accounts.zoho.ca'),
  vault: env('ZOHO_VAULT_URL', 'https://vault.zohocloud.ca'),
  clientId: env('ZOHO_CLIENT_ID'),
  clientSecret: env('ZOHO_CLIENT_SECRET'),
  refreshToken: env('ZOHO_REFRESH_TOKEN'),
  masterPassword: env('ZOHO_MASTER_PASSWORD'),
  secretName: env('ZOHO_SECRET_NAME', 'Outschool'),
  // Paths are configurable because the .ca endpoints are not confirmed in Zoho's public docs.
  loginPath: env('ZOHO_LOGIN_PATH', '/api/json/login?OPERATION_NAME=GET_LOGIN'),
  openVaultPath: env('ZOHO_OPEN_VAULT_PATH', '/api/json/login?OPERATION_NAME=OPEN_VAULT&startIndex=0&limit=1'),
  orgKeyPath: env('ZOHO_ORGKEY_PATH', '/api/rest/json/v1/user/orgkey'),
  secretsPath: env('ZOHO_SECRETS_PATH', '/api/rest/json/v1/secrets'),
});

const details = (r) => r?.operation?.details || r?.operation?.Details || r?.details || r;

async function accessToken(c) {
  for (const k of ['clientId', 'clientSecret', 'refreshToken', 'masterPassword']) {
    if (!c[k]) throw new Error(`Missing environment variable for ${k}`);
  }
  const body = new URLSearchParams({
    refresh_token: c.refreshToken, client_id: c.clientId,
    client_secret: c.clientSecret, grant_type: 'refresh_token',
  });
  const res = await fetch(`${c.accounts}/oauth/v2/token`, { method: 'POST', body });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Zoho token refresh failed (HTTP ${res.status}: ${j.error || 'no access_token'})`);
  return j.access_token;
}

async function zget(c, token, path) {
  const res = await fetch(`${c.vault}${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* keep undefined */ }
  if (!res.ok || !json) throw new Error(`Zoho request ${path.split('?')[0]} failed (HTTP ${res.status})`);
  return json;
}

// Runs the whole chain and returns { steps, credentials? }. credentials only when includeSecret is true.
async function run({ includeSecret = false } = {}) {
  const c = cfg();
  const steps = [];
  const mark = (name, ok, note) => steps.push({ step: name, ok, ...(note ? { note } : {}) });
  try {
    const token = await accessToken(c); mark('oauth_token', true);

    const login = details(await zget(c, token, c.loginPath));
    const type = login.LOGIN || login.logtype;
    const salt = login.SALT || login.salt;
    const iter = login.ITERATION || login.iteration;
    mark('get_login', !!(type && salt), `login type ${type}`);
    if (type !== 'PBKDF2_AES') throw new Error(`Unsupported login type ${type} (only PBKDF2_AES is implemented)`);

    const masterKey = Vault.PBKDF2_key(c.masterPassword, salt, iter);
    const enc = login.PASSPHRASE || login.passphrase;
    if (enc) {
      let okAuth = false;
      try { okAuth = !Number.isNaN(Date.parse(JSON.parse(Vault.decrypt(enc, masterKey)).date)); } catch { /* wrong password */ }
      mark('master_password_check', okAuth, okAuth ? undefined : 'Decrypting PASSPHRASE failed: wrong master password or crypto mismatch');
      if (!okAuth) throw new Error('Master password check failed');
    } else {
      mark('master_password_check', false, 'No PASSPHRASE field in GET_LOGIN response; cannot validate');
    }

    const list = await zget(c, token, `${c.secretsPath}?passwordName=${encodeURIComponent(c.secretName)}`);
    const secrets = details(list)?.secrets || details(list)?.SECRETS || list.secrets || [];
    const first = Array.isArray(secrets) ? secrets[0] : undefined;
    mark('find_secret', !!first, first ? undefined : `No secret named "${c.secretName}" returned`);
    if (!first) throw new Error('Secret not found');

    const id = first.SECRETID || first.secretid || first.secretId;
    const full = id ? details(await zget(c, token, `${c.secretsPath}/${id}`)) : first;
    const secret = full?.secret || full?.SECRET || full;
    const shared = String(secret.ISSHARED ?? secret.isshared ?? 'NO').toUpperCase() === 'YES';
    mark('secret_type', true, shared ? 'shared (org key)' : 'personal (master key)');

    let dataKey = masterKey;
    if (shared) {
      let org;
      try { org = details(await zget(c, token, c.orgKeyPath)); }
      catch { org = details(await zget(c, token, c.openVaultPath)); }
      const priv = org.privateKey || org.PRIVATEKEY;
      const sk = org.sharedKey || org.SHARINGKEY;
      const rsaType = org.rsaKeyType || org.RSAKEYTYPE || 'RSA_1024';
      if (!priv || !sk || priv === 'null' || sk === 'null') throw new Error('Org key unavailable: sharing handshake may not be approved');
      dataKey = Vault.RSA_decrypt(sk, Vault.decrypt(priv, masterKey), rsaType);
      mark('org_key', true, `key type ${rsaType}`);
    }

    const raw = secret.secretData || secret.SECRETDATA;
    const fields = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const out = {};
    for (const f of ['username', 'password']) {
      if (typeof fields?.[f] === 'string') out[f] = Vault.decrypt(fields[f], dataKey);
    }
    mark('decrypt_fields', !!(out.username && out.password),
      `username ${out.username ? 'ok' : 'missing'}, password ${out.password ? 'ok' : 'missing'}`);
    if (!out.username || !out.password) throw new Error('Could not decrypt username and password');
    return { ok: true, steps, ...(includeSecret ? { credentials: out } : {}) };
  } catch (e) {
    steps.push({ step: 'error', ok: false, note: String(e.message).slice(0, 300) });
    return { ok: false, steps };
  }
}

module.exports = { run };