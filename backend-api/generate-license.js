// ============================================================
// generate-license.js — v2
// Dua tanggung jawab:
//   1. HTTP endpoint untuk admin generate key manual
//   2. Export generateLicenseInternal() untuk dipakai webhook & recovery
//
// PENTING (v2): Tidak ada token days. expired_at = NULL saat generate,
// diisi oleh activate-license.js saat user aktivasi.
// ============================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── CORS Helper ──
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ============================================================
// FUNGSI INTERNAL — dipanggil oleh midtrans-webhook.js & admin-recovery.js
// Signature: generateLicenseInternal(appId, secret, packageType, email)
// Return: { license_code }
// ============================================================
function generateLicenseInternal(appId, secret, packageType, email) {
  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(8).toString('hex');
  const payload = `${appId}-${packageType}-${email}-${timestamp}-${random}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Format: CERTGEN-XXXX-XXXX-XXXX (12 char pertama HMAC uppercase)
  const raw = hmac.substring(0, 12).toUpperCase();
  const license_code = `${appId}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;

  return { license_code };
}

// ============================================================
// HTTP ENDPOINT — admin generate key manual (POST)
// Body: { admin_secret, email, package_type, package_name, order_id }
// ============================================================
async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, email, package_type, package_name, order_id } = req.body || {};

  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!email || !package_type) {
    return res.status(400).json({ error: 'email dan package_type wajib diisi' });
  }

  const VALID_TYPES = ['daily', 'monthly', 'yearly', 'lifetime'];
  if (!VALID_TYPES.includes(package_type)) {
    return res.status(400).json({ error: 'package_type tidak valid' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const appId = 'CERTGEN';
  const secret = process.env.LICENSE_SECRET;
  const { license_code } = generateLicenseInternal(appId, secret, package_type, email);

  const { data, error } = await supabase
    .from('licenses')
    .insert([{
      license_key: license_code,
      order_id: order_id || null,
      buyer_email: email,
      package_type,
      package_name: package_name || package_type,
      app_id: appId,
      device_id: null,
      status: 'active',
      activated_at: null,
      expired_at: null,  // diisi saat aktivasi oleh activate-license.js
      email_sent: false,
      wa_sent: false,
    }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    success: true,
    license_key: data.license_key,
    package_type: data.package_type,
    buyer_email: data.buyer_email,
    message: 'License generated. expired_at akan diisi saat aktivasi.',
  });
}

module.exports = handler;
module.exports.generateLicenseInternal = generateLicenseInternal;
