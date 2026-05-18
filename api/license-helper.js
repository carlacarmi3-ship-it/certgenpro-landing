// api/license-helper.js
const crypto = require('crypto');
const base32 = require('hi-base32');

const DURATION_DAYS = {
  "1D":       1,
  "30D":      30,
  "365D":     365,
  "LIFETIME": 36500
};

function deriveKeys(secretKey, appId) {
  const base = Buffer.from(secretKey + "|" + appId, 'utf-8');
  const encKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from("ENC|"), base])).digest();
  const macKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from("MAC|"), base])).digest();
  return { encKey, macKey };
}

// ✅ PERBAIKAN: Menambahkan parameter `customerEmail` (default kosong)
function generateLicenseNode(appId, secretKey, durationTag, customerEmail = "", tokenValidityDays = 1) {
  if (!DURATION_DAYS[durationTag]) {
    throw new Error(`Durasi ${durationTag} tidak valid. Pilihan: 1D, 30D, 365D, LIFETIME`);
  }

  const { encKey, macKey } = deriveKeys(secretKey, appId);

  const now = Math.floor(Date.now() / 1000);
  const tokenExpiry   = now + (tokenValidityDays * 24 * 60 * 60);
  const licenseExpiry = now + (DURATION_DAYS[durationTag] * 24 * 60 * 60);

  // ✅ PERBAIKAN: Menambahkan key `eml` ke payload agar tidak Error/KeyError di Python
  const payload = {
    v:   1,
    app: appId,
    dur: DURATION_DAYS[durationTag],
    eml: customerEmail, 
    tak: tokenExpiry,
    lak: licenseExpiry,
    nce: crypto.randomBytes(4).readUInt32BE(0)
  };

  const payloadString = JSON.stringify(payload);
  const payloadBytes  = Buffer.from(payloadString, 'utf-8');

  const signature = crypto.createHmac('sha256', macKey).update(payloadBytes).digest();

  const MAGIC   = Buffer.from([0xAB, 0xCD, 0xEF, 0x01]);
  const VERSION = Buffer.from([0x01]);
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32BE(payloadBytes.length, 0);

  const blob = Buffer.concat([MAGIC, VERSION, lenBuffer, payloadBytes, signature]);

  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const encryptedPayload = Buffer.concat([cipher.update(blob), cipher.final()]);
  const ciphertext       = Buffer.concat([iv, encryptedPayload]);

  const crc = crypto.createHash('sha256').update(ciphertext).digest().slice(0, 2);
  const protectedBytes = Buffer.concat([crc, ciphertext]);

  let encoded = base32.encode(protectedBytes).replace(/=/g, "");
  const chunks = encoded.match(/.{1,5}/g).join("-");
  const prefix = appId.split("_")[0];
  const licenseCode = `${prefix}-${chunks}`;

  return {
    license_code:    licenseCode,
    token_expires:   tokenExpiry,
    license_expires: licenseExpiry
  };
}

module.exports = { generateLicenseNode };