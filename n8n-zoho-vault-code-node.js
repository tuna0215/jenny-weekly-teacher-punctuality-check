// n8n Code node: "Run Once for All Items"
//
// Expected input JSON:
// {
//   "getLogin": <GET_LOGIN response>,
//   "secret": <one Zoho secret object>,
//   "orgKeyResponse": <GET /api/rest/json/v1/user/orgkey response, shared secrets only>,
//   "fieldNames": ["username", "password"]
// }
//
// Preferred secret source on self-hosted n8n:
//   process.env.ZOHO_VAULT_MASTER_PASSWORD
// For n8n Cloud, inject masterPassword from an approved secret manager only
// after disabling saved execution data. Never put it literally in this code.

const crypto = require('crypto');
const source = $input.first().json;
let masterPassword;
try {
  masterPassword = process.env.ZOHO_VAULT_MASTER_PASSWORD;
} catch {
  // n8n can be configured to block process.env access in Code nodes.
}
masterPassword ||= source.masterPassword;
if (!masterPassword) throw new Error('Zoho Vault master password is unavailable');

function legacyUtf8Encode(text, normalizeCrLf = false) {
  if (normalizeCrLf) text = text.replace(/\r\n/g, '\n');
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push((c >> 6) | 0xc0, (c & 0x3f) | 0x80);
    else bytes.push((c >> 12) | 0xe0, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80);
  }
  return Buffer.from(bytes);
}

function legacyUtf8Decode(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i];
    if (c < 0x80) {
      text += String.fromCharCode(c);
      i += 1;
    } else if (c > 0xbf && c < 0xe0) {
      text += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      text += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    }
  }
  return text;
}

function saltBytes(salt) {
  const result = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i++) result[i] = salt.charCodeAt(i) & 0xff;
  return result;
}

function pbkdf2Key(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(
    Buffer.from(passphrase, 'utf8'),
    saltBytes(salt),
    Number(iterations),
    32,
    'sha256',
  ).toString('hex');
}

function legacyHash(value) {
  return crypto.createHash('sha256').update(legacyUtf8Encode(value, true)).digest('hex');
}

function aesKey(password) {
  const passwordBytes = Buffer.alloc(32);
  legacyUtf8Encode(password).copy(passwordBytes, 0, 0, 32);
  const ecb = crypto.createCipheriv('aes-256-ecb', passwordBytes, null);
  ecb.setAutoPadding(false);
  const block = Buffer.concat([ecb.update(passwordBytes.subarray(0, 16)), ecb.final()]);
  return Buffer.concat([block, block]);
}

function vaultDecrypt(ciphertext, password) {
  const envelope = Buffer.from(ciphertext, 'base64');
  if (envelope.length < 8) throw new Error('Invalid Zoho Vault ciphertext');
  const counter = Buffer.concat([envelope.subarray(0, 8), Buffer.alloc(8)]);
  const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey(password), counter);
  return legacyUtf8Decode(Buffer.concat([decipher.update(envelope.subarray(8)), decipher.final()]));
}

function hexToBase64Url(value) {
  let bytes = Buffer.from(value.length % 2 ? `0${value}` : value, 'hex');
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return bytes.toString('base64url');
}

function rsaDecrypt1024(ciphertextHex, privateKeyCsv) {
  const parts = privateKeyCsv.split(',');
  if (parts.length !== 8) throw new Error('Invalid legacy Zoho RSA private key');
  const [n, e, d, p, q, dp, dq, qi] = parts;
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'RSA', n: hexToBase64Url(n), e: hexToBase64Url(e), d: hexToBase64Url(d),
      p: hexToBase64Url(p), q: hexToBase64Url(q), dp: hexToBase64Url(dp),
      dq: hexToBase64Url(dq), qi: hexToBase64Url(qi),
    },
  });
  return crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(ciphertextHex, 'hex'),
  ).toString('utf8');
}

function rsaDecrypt4096(ciphertextBase64, privateKeyPkcs8Base64) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertextBase64, 'base64'),
  ).toString('utf8');
}

function detailsOf(response) {
  return response?.operation?.Details || response?.operation?.details || response;
}

const login = detailsOf(source.getLogin);
if (!login) throw new Error('GET_LOGIN response is missing');
const loginType = login.LOGIN || login.logtype;
const salt = login.SALT || login.salt;
const iterations = login.ITERATION || login.iteration;
let masterKey;
if (loginType === 'PBKDF2_AES') masterKey = pbkdf2Key(masterPassword, salt, iterations);
else if (loginType === 'SHA256') masterKey = legacyHash(masterPassword);
else throw new Error(`Unsupported Zoho Vault login type: ${loginType}`);

// PBKDF2 accounts carry an encrypted authentication JSON. Validate it before
// decrypting any secret so a wrong master password fails closed.
const encryptedAuth = login.PASSPHRASE || login.passphrase;
if (loginType === 'PBKDF2_AES' && encryptedAuth) {
  try {
    const auth = JSON.parse(vaultDecrypt(encryptedAuth, masterKey));
    if (Number.isNaN(Date.parse(auth.date))) throw new Error('missing auth date');
  } catch {
    throw new Error('Zoho Vault master password validation failed');
  }
}

const secret = source.secret;
if (!secret) throw new Error('Zoho secret is missing');
const isShared = String(secret.ISSHARED ?? secret.isshared ?? 'NO').toUpperCase() === 'YES';
let dataKey = masterKey;

if (isShared) {
  const org = detailsOf(source.orgKeyResponse);
  if (!org) throw new Error('Shared secret requires the org-key response');
  const encryptedPrivateKey = org.privateKey || org.PRIVATEKEY;
  const sharedKey = org.sharedKey || org.SHARINGKEY;
  const rsaKeyType = org.rsaKeyType || org.RSAKEYTYPE || 'RSA_1024';
  const privateKey = vaultDecrypt(encryptedPrivateKey, masterKey);
  dataKey = rsaKeyType === 'RSA_4096'
    ? rsaDecrypt4096(sharedKey, privateKey)
    : rsaDecrypt1024(sharedKey, privateKey);
}

const rawSecretData = secret.secretData || secret.SECRETDATA;
const encryptedFields = typeof rawSecretData === 'string' ? JSON.parse(rawSecretData) : rawSecretData;
const requestedFields = source.fieldNames || ['username', 'password'];
const result = {};
for (const fieldName of requestedFields) {
  if (typeof encryptedFields?.[fieldName] === 'string') {
    result[fieldName] = vaultDecrypt(encryptedFields[fieldName], dataKey);
  }
}
if (Object.keys(result).length === 0) throw new Error('Requested encrypted fields were not present');

// Do not console.log result, masterKey, dataKey, or masterPassword.
return [{ json: result }];
