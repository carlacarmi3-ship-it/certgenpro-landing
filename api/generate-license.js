// api/generate-license.js
// Fungsi inti generate lisensi (HMAC-SHA256)
// Export: generateLicenseInternal() — dipakai oleh webhook & recovery
// HTTP endpoint: hanya untuk admin (dilindungi ADMIN_SECRET)

const crypto              = require('crypto');
const { createClient }    = require('@supabase/supabase-js');

// ============================================================
// generateLicenseInternal
// Satu-satunya fungsi yang boleh membuat license_key baru.
// Tidak ada logika expired_at di sini — diisi oleh activate-license.js
// ============================================================
function generateLicenseInternal(appId, secret, packageType, email) {
  const timestamp  = Date.now().toString();
  const random     = crypto.randomBytes(8).toString('hex');
  const payload    = `${appId}-${packageType}-${email}-${timestamp}-${random}`;
  const hmac       = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Format: APPID-XXXX-XXXX-XXXX (12 hex chars dari HMAC, uppercase)
  const raw         = hmac.substring(0, 12).toUpperCase();
  const licenseCode = `${appId}-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;

  return { license_code: licenseCode };
}

// ============================================================
// HTTP handler — admin only
// POST /api/generate-license
// Body: { admin_secret, email, package_type, package_name, order_id }
// ============================================================
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, email, package_type, package_name, order_id } = req.body;

  if (!admin_secret || admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!email || !package_type || !order_id) {
    return res.status(400).json({ error: 'Field email, package_type, order_id diperlukan.' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Cek apakah sudah ada lisensi untuk order ini
  const { data: existing } = await supabase
    .from('licenses')
    .select('license_key, status')
    .eq('order_id', order_id)
    .single();

  if (existing) {
    return res.status(200).json({
      license_key: existing.license_key,
      status:      existing.status,
      was_existing: true,
      message:     'Lisensi sudah ada untuk order ini.',
    });
  }

  // Generate key baru
  const { license_code } = generateLicenseInternal(
    'CERTGEN',
    process.env.LICENSE_SECRET,
    package_type,
    email
  );

  const { error: insertError } = await supabase.from('licenses').insert({
    license_key:  license_code,
    order_id,
    buyer_email:  email,
    package_type,
    package_name: package_name || package_type,
    app_id:       'CERTGEN',
    status:       'active',
    // device_id, activated_at, expired_at — diisi saat aktivasi oleh activate-license.js
  });

  if (insertError) {
    console.error('[generate-license] Insert error:', insertError);
    return res.status(500).json({ error: 'Gagal menyimpan lisensi ke database.' });
  }

  return res.status(200).json({
    license_key:  license_code,
    order_id,
    package_type,
    was_existing: false,
  });
}

module.exports = handler;
module.exports.generateLicenseInternal = generateLicenseInternal;
