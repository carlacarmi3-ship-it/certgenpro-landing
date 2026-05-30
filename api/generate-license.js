// api/generate-license.js — CertGen Pro v3
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// FUNGSI INTERNAL — dipanggil oleh webhook & recovery
// expired_at TIDAK diisi di sini — diisi saat aktivasi oleh activate-license.js
// ============================================================
function generateLicenseInternal(appId, secret, packageType, email) {
  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(8).toString('hex');
  const payload = `${appId}-${packageType}-${email}-${timestamp}-${random}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Format: APPID-XXXX-XXXX-XXXX (ambil 12 karakter pertama dari HMAC, uppercase)
  const raw = hmac.substring(0, 12).toUpperCase();
  const license_code = `${appId}-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;

  return { license_code };
}

// ============================================================
// HTTP ENDPOINT — untuk admin generate key manual
// ============================================================
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, buyer_email, package_type, package_name, order_id } = req.body;

  // Validasi admin
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret' });
  }

  if (!buyer_email || !package_type) {
    return res.status(400).json({ error: 'buyer_email and package_type are required' });
  }

  const validTypes = ['daily', 'monthly', 'yearly', 'lifetime'];
  if (!validTypes.includes(package_type)) {
    return res.status(400).json({ error: 'Invalid package_type. Use: daily, monthly, yearly, or lifetime' });
  }

  const appId = 'CERTGEN';
  const secret = process.env.LICENSE_SECRET;

  const { license_code } = generateLicenseInternal(appId, secret, package_type, buyer_email);

  const { data, error } = await supabase
    .from('licenses')
    .insert([{
      license_key: license_code,
      order_id: order_id || null,
      buyer_email,
      package_type,
      package_name: package_name || package_type,
      app_id: appId,
      status: 'active',
      expired_at: null, // diisi saat aktivasi
    }])
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    message: 'License generated successfully',
    license_key: data.license_key,
    package_type: data.package_type,
    buyer_email: data.buyer_email,
    expired_at: data.expired_at,
  });
};

// Export fungsi internal agar bisa dipakai file lain
module.exports.generateLicenseInternal = generateLicenseInternal;
