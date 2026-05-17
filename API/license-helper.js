// File: api/license-helper.js

const crypto = require('crypto');
const base32 = require('hi-base32');

// Durasi berdasarkan tag yang ada di Python Anda
const DURATION_DAYS = {
  "1D": 1,
  "30D": 30,
  "365D": 365,
  "LIFETIME": 36500 // 100 tahun
};

function deriveKeys(secretKey, appId) {
  const base = Buffer.from(secretKey + "|" + appId, 'utf-8');
  const encKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from("ENC|"), base])).digest();
  const macKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from("MAC|"), base])).digest();
  return { encKey, macKey };
}

function generateLicenseNode(appId, secretKey, durationTag, tokenValidityDays = 1) {
  if (!DURATION_DAYS[durationTag]) {
    throw new Error(`Durasi ${durationTag} tidak valid.`);
  }

  const { encKey, macKey } = deriveKeys(secretKey, appId);

  const now = Math.floor(Date.now() / 1000); // Unix timestamp dalam detik
  const tokenExpiry = now + (tokenValidityDays * 24 * 60 * 60);
  const licenseExpiry = now + (DURATION_DAYS[durationTag] * 24 * 60 * 60);

  // Buat Payload JSON
  const payload = {
    v: 1,
    app: appId,
    dur: DURATION_DAYS[durationTag],
    tak: tokenExpiry,
    lak: licenseExpiry,
    nce: crypto.randomBytes(4).readUInt32BE(0) // Random nonce
  };

  const payloadString = JSON.stringify(payload);
  const payloadBytes = Buffer.from(payloadString, 'utf-8');

  // Sign dengan HMAC-SHA256
  const signature = crypto.createHmac('sha256', macKey).update(payloadBytes).digest();

  // Susun BLOB (Magic + Versi + Length + Payload + Signature)
  const MAGIC = Buffer.from([0xAB, 0xCD, 0xEF, 0x01]);
  const VERSION = Buffer.from([0x01]);
  
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32BE(payloadBytes.length, 0);

  const blob = Buffer.concat([MAGIC, VERSION, lenBuffer, payloadBytes, signature]);

  // Enkripsi AES-256-CBC
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  
  // Enkripsi dan gabungkan dengan IV (sesuai format Python Anda)
  const encryptedPayload = Buffer.concat([cipher.update(blob), cipher.final()]);
  const ciphertext = Buffer.concat([iv, encryptedPayload]);

  // Buat Checksum luar 2-byte (seperti di file _to_license_string python)
  const crc = crypto.createHash('sha256').update(ciphertext).digest().slice(0, 2);
  const protectedBytes = Buffer.concat([crc, ciphertext]);

  // Encode Base32
  let encoded = base32.encode(protectedBytes).replace(/=/g, "");
  
  // Format menjadi bagian-bagian per 5 karakter
  const chunks = encoded.match(/.{1,5}/g).join("-");
  
  const prefix = appId.split("_")[0];
  const licenseCode = `${prefix}-${chunks}`;

  return {
    license_code: licenseCode,
    token_expires: tokenExpiry,
    license_expires: licenseExpiry
  };
}

module.exports = { generateLicenseNode };