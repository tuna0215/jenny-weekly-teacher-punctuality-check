'use strict';
// Zoho Vault access. Secrets come ONLY from environment variables. Nothing here logs secret values.
const Vault = require('./zoho-vault-crypto.cjs');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const cfg = () => ({
  accounts: env('ZOHO_ACCOUNTS_URL', 'https://accounts.zohocloud.ca'),
  vault: env('ZOHO_VAULT_URL', 'https://vault.zohocloud.ca'),
  clientId: env('ZOHO_CLIENT_ID'),
  clientSecret: env('ZOHO_CLIENT_SECRET'),
  refreshToken: env('ZOHO_REFRESH_TOKEN'),
  masterPassword: env('ZOHO_MASTER_PASSWORD'),
  secretName: env('ZOHO_SECRET_NAME', 'Outschool'),
  requestTimeoutMs: Number(env('ZOHO_REQUEST_TIMEOUT_MS', '15000')),
  // Paths are configurable because the .ca endpoints are not confirmed in Zoho's public docs.
  loginPath: env('ZOHO_LOGIN_PATH', '/api/json/login?OPERATION_NAME=GET_LOGIN'),
  openVaultPath: env('ZOHO_OPEN_VAULT_PATH', '/api/json/login?OPERATION_NAME=OPEN_VAULT&startIndex=0&limit=1'),
  orgKeyPath: env('ZOHO_ORGKEY_PATH', '/api/rest/json/v1/user/orgkey'),
  secretsPath: env('ZOHO_SECRETS_PATH', '/api/rest/json/v1/secrets'),
});

const details = (r) => r?.operation?.details || r?.operation?.Details || r?.details || r;

const requestSignal = (c) => AbortSignal.timeout(c.requestTimeoutMs);

const requestFailure = (e, c, destination) => {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new Error(`Request to ${destination} timed out after ${c.requestTimeoutMs}ms`);
  }
  return new Error(`Cannot reach ${destination} (${e?.cause?.code || e?.cause?.message || e?.message || 'unknown error'})`);
};

const operationError = (json) => {
  const result = json?.operation?.result || json?.operation?.Result;
  const status = result?.status ?? result?.STATUS ?? (typeof result === 'string' ? result : undefined);
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : status;
  const failed = normalized === false || normalized === 0 || normalized === '0'
    || ['error', 'fail', 'failed', 'failure'].includes(normalized);
  if (!failed) return undefined;
  return String(result?.message || result?.MESSAGE || 'Zoho operation failed').slice(0, 300);
};

const secretNameOf = (secret) => secret?.SECRETNAME ?? secret?.secretName ?? secret?.secretname
  ?? secret?.PASSWORDNAME ?? secret?.passwordName ?? secret?.NAME ?? secret?.name;

const withQuery = (path, values) => {
  const queryAt = path.indexOf('?');
  const base = queryAt === -1 ? path : path.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? '' : path.slice(queryAt + 1));
  for (const [key, value] of Object.entries(values)) query.set(key, value);
  return `${base}?${query}`;
};

async function accessToken(c) {
  const required = {
    clientId: 'ZOHO_CLIENT_ID',
    clientSecret: 'ZOHO_CLIENT_SECRET',
    refreshToken: 'ZOHO_REFRESH_TOKEN',
    masterPassword: 'ZOHO_MASTER_PASSWORD',
  };
  for (const [key, variable] of Object.entries(required)) {
    if (!c[key]) throw new Error(`Missing environment variable ${variable}`);
  }
  const body = new URLSearchParams({
    refresh_token: c.refreshToken, client_id: c.clientId,
    client_secret: c.clientSecret, grant_type: 'refresh_token',
  });
  let res;
  try {
    res = await fetch(`${c.accounts}/oauth/v2/token`, { method: 'POST', body, signal: requestSignal(c) });
  } catch (e) {
    throw requestFailure(e, c, c.accounts);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`Zoho token refresh failed (HTTP ${res.status}: ${j.error || 'no access_token'})`);
  }
  return j.access_token;
}

async function zget(c, token, path) {
  let res;
  try {
    res = await fetch(`${c.vault}${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      signal: requestSignal(c),
    });
  } catch (e) {
    throw requestFailure(e, c, c.vault);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* keep undefined */ }
  if (!res.ok || !json) {
    const error = new Error(`Zoho request ${path.split('?')[0]} failed (HTTP ${res.status})`);
    error.httpStatus = res.status;
    throw error;
  }
  const failure = operationError(json);
  if (failure) throw new Error(`Zoho request ${path.split('?')[0]} failed: ${failure}`);
  return json;
}

// Runs the whole chain and returns { steps, credentials? }. credentials only when includeSecret is true.
async function run({ includeSecret = false } = {}) {
  const c = cfg();
  const steps = [];
  const mark = (name, ok, note) => steps.push({ step: name, ok, ...(note ? { note } : {}) });
  try {
    if (!Number.isSafeInteger(c.requestTimeoutMs) || c.requestTimeoutMs <= 0) {
      throw new Error('ZOHO_REQUEST_TIMEOUT_MS must be a positive integer');
    }
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
      throw new Error('Master password cannot be validated because PASSPHRASE is missing');
    }

    const listPath = withQuery(c.secretsPath, {
      isAsc: 'true',
      passwordName: c.secretName,
    });
    const list = await zget(c, token, listPath);
    const listDetails = details(list);
    const secrets = Array.isArray(listDetails)
      ? listDetails
      : listDetails?.secrets || listDetails?.SECRETS || list.secrets || [];
    const matches = Array.isArray(secrets)
      ? secrets.filter((secret) => secretNameOf(secret) === c.secretName)
      : [];
    const first = matches.length === 1 ? matches[0] : undefined;
    const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 15) : typeof o);
    const op = list.operation;
    const result = op && (op.result || op.Result);
    const resultSummary = result && typeof result === 'object'
      ? { status: result.status ?? result.STATUS, message: String(result.message || result.MESSAGE || '').slice(0, 200) }
      : result;
    mark('list_shape', true,
      `operation keys: ${JSON.stringify(keysOf(op))}; result: ${JSON.stringify(resultSummary)}; details keys: ${JSON.stringify(keysOf(op && (op.Details || op.details)))}; top-level keys: ${JSON.stringify(keysOf(list))}; count: ${Array.isArray(secrets) ? secrets.length : 'n/a'}`);
    mark('find_secret', !!first, first ? undefined : `Expected exactly one secret named "${c.secretName}"; found ${matches.length} exact matches`);
    if (!first) {
      throw new Error(matches.length > 1 ? 'Multiple secrets have the requested name' : 'Secret not found');
    }

    const id = first.SECRETID || first.secretid || first.secretId;
    const fullDetails = id ? details(await zget(c, token, `${c.secretsPath}/${id}`)) : first;
    const full = Array.isArray(fullDetails) ? fullDetails[0] : fullDetails;
    const secret = full?.secret || full?.SECRET || full;
    const shared = String(secret.ISSHARED ?? secret.isshared ?? 'NO').toUpperCase() === 'YES';
    mark('secret_type', true, shared ? 'shared (org key)' : 'personal (master key)');

    let dataKey = masterKey;
    if (shared) {
      let org;
      try { org = details(await zget(c, token, c.orgKeyPath)); }
      catch (e) {
        if (e.httpStatus !== 404 && e.httpStatus !== 405) throw e;
        org = details(await zget(c, token, c.openVaultPath));
      }
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
