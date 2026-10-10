'use strict';

// Independent, Node.js-compatible implementation of the formats used by
// Zoho Vault's public web bundle and @zohocorporation/vault-cli 1.1.4.
// It is not copied Zoho source. See zoho-vault-crypto-report.md for evidence.

const crypto = require('node:crypto');

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function legacyUtf8Encode(text, normalizeCrLf = false) {
  if (normalizeCrLf) text = text.replace(/\r\n/g, '\n');
  const bytes = [];

  // Zoho's legacy helper encodes UTF-16 code units independently. This is
  // deliberately retained for byte compatibility, including its CESU-8-like
  // treatment of supplementary characters.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push((c >> 6) | 0xc0, (c & 0x3f) | 0x80);
    } else {
      bytes.push(
        (c >> 12) | 0xe0,
        ((c >> 6) & 0x3f) | 0x80,
        (c & 0x3f) | 0x80,
      );
    }
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
      text += String.fromCharCode(
        ((c & 0x0f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f),
      );
      i += 3;
    }
  }
  return text;
}

function zohoSaltBytes(salt) {
  requireString(salt, 'salt');
  const result = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i++) result[i] = salt.charCodeAt(i) & 0xff;
  return result;
}

function PBKDF2_key(passphrase, salt, iteration) {
  requireString(passphrase, 'passphrase');
  requireString(salt, 'salt');
  const iterations = Number(iteration);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new TypeError('iteration must be a positive safe integer');
  }

  return crypto.pbkdf2Sync(
    Buffer.from(passphrase, 'utf8'),
    zohoSaltBytes(salt),
    iterations,
    32,
    'sha256',
  ).toString('hex');
}

function hash(plaintext) {
  requireString(plaintext, 'plaintext');
  return crypto
    .createHash('sha256')
    .update(legacyUtf8Encode(plaintext, true))
    .digest('hex');
}

function zohoAes256Key(password) {
  requireString(password, 'password');
  const encoded = legacyUtf8Encode(password);
  const passwordBytes = Buffer.alloc(32);
  encoded.copy(passwordBytes, 0, 0, 32);

  // Zoho encrypts the first 16 password bytes as one AES-256 ECB block, then
  // repeats that 16-byte result to form the AES-CTR key.
  const cipher = crypto.createCipheriv('aes-256-ecb', passwordBytes, null);
  cipher.setAutoPadding(false);
  const block = Buffer.concat([
    cipher.update(passwordBytes.subarray(0, 16)),
    cipher.final(),
  ]);
  return Buffer.concat([block, block]);
}

function normalizeNonce(nonce) {
  if (nonce === undefined) return crypto.randomBytes(8);
  const bytes = Buffer.isBuffer(nonce) ? Buffer.from(nonce) : Buffer.from(nonce);
  if (bytes.length !== 8) throw new TypeError('nonce must contain exactly 8 bytes');
  return bytes;
}

function encrypt(plaintext, password, options = {}) {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
  const nonce = normalizeNonce(options.nonce);
  const initialCounter = Buffer.concat([nonce, Buffer.alloc(8)]);
  const cipher = crypto.createCipheriv('aes-256-ctr', zohoAes256Key(password), initialCounter);
  const ciphertext = Buffer.concat([
    cipher.update(legacyUtf8Encode(plaintext)),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext]).toString('base64');
}

function decrypt(ciphertext, password) {
  requireString(ciphertext, 'ciphertext');
  const envelope = Buffer.from(ciphertext, 'base64');
  if (envelope.length < 8) throw new Error('invalid Zoho Vault ciphertext');

  const nonce = envelope.subarray(0, 8);
  const initialCounter = Buffer.concat([nonce, Buffer.alloc(8)]);
  const decipher = crypto.createDecipheriv(
    'aes-256-ctr',
    zohoAes256Key(password),
    initialCounter,
  );
  const plaintext = Buffer.concat([
    decipher.update(envelope.subarray(8)),
    decipher.final(),
  ]);
  return legacyUtf8Decode(plaintext);
}

function base64UrlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function hexComponentToBase64Url(value) {
  const normalized = value.length % 2 ? `0${value}` : value;
  let bytes = Buffer.from(normalized, 'hex');
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return bytes.toString('base64url');
}

function RSA_decrypt_1024(ciphertextHex, privateKeyCsv) {
  requireString(ciphertextHex, 'ciphertextHex');
  requireString(privateKeyCsv, 'privateKeyCsv');
  const parts = privateKeyCsv.split(',');
  if (parts.length !== 8) {
    throw new Error('legacy RSA private key must have 8 comma-separated hex components');
  }
  const [n, e, d, p, q, dp, dq, qi] = parts;
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'RSA',
      n: hexComponentToBase64Url(n),
      e: hexComponentToBase64Url(e),
      d: hexComponentToBase64Url(d),
      p: hexComponentToBase64Url(p),
      q: hexComponentToBase64Url(q),
      dp: hexComponentToBase64Url(dp),
      dq: hexComponentToBase64Url(dq),
      qi: hexComponentToBase64Url(qi),
    },
  });
  const plaintext = crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(ciphertextHex, 'hex'),
  );
  return plaintext.toString('utf8');
}

function RSA_decrypt_4096(ciphertextBase64, privateKeyPkcs8Base64) {
  requireString(ciphertextBase64, 'ciphertextBase64');
  requireString(privateKeyPkcs8Base64, 'privateKeyPkcs8Base64');
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const plaintext = crypto.privateDecrypt(
    {
      key,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(ciphertextBase64, 'base64'),
  );
  return plaintext.toString('utf8');
}

function RSA_decrypt(ciphertext, privateKey, keyType = 'RSA_1024') {
  if (keyType === 'RSA_1024') return RSA_decrypt_1024(ciphertext, privateKey);
  if (keyType === 'RSA_4096') return RSA_decrypt_4096(ciphertext, privateKey);
  throw new Error(`unsupported Zoho Vault RSA key type: ${keyType}`);
}

module.exports = {
  PBKDF2_key,
  decrypt,
  encrypt,
  hash,
  RSA_decrypt,
  RSA_decrypt_1024,
  RSA_decrypt_4096,
  _internals: {
    base64UrlToBuffer,
    legacyUtf8Decode,
    legacyUtf8Encode,
    zohoAes256Key,
    zohoSaltBytes,
  },
};
