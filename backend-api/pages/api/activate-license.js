// ============================================================
// activate-license.js — v2
// - Validasi license_key + device_id dari desktop app
// - Device binding: saat pertama aktivasi, isi device_id + activated_at + expired_at
// - expired_at dihitung di sini berdasarkan package_type (BUKAN saat generate)
// ============================================================

const { createClient } = require('@supabase/supabase-js');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
  }

  const { license_key, device_id } = req.body || {};

  if (!license_key || !device_id) {
    return res.status(400).json({ valid: false, reason: 'MISSING_PARAMETERS' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 1. Cek lisensi
  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', license_key)
    .single();

  if (error || !license) {
    return res.status(404).json({ valid: false, reason: 'INVALID_KEY' });
  }

  if (license.status === 'revoked' || license.status === 'expired') {
    return res.status(403).json({ valid: false, reason: license.status.toUpperCase() });
  }

  // Validasi expired_at aktual (fallback jika cron terlambat)
  if (license.expired_at && new Date(license.expired_at) < new Date()) {
    return res.status(403).json({ valid: false, reason: 'EXPIRED' });
  }

  // 2. Device binding
  if (license.device_id === null) {
    // ── AKTIVASI PERTAMA: isi device_id + activated_at + expired_at ──
    const now = new Date();
    let expired_at = null;

    switch (license.package_type) {
      case 'daily':
        expired_at = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case 'monthly':
        expired_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case 'yearly':
        expired_at = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case 'lifetime':
        expired_at = null;
        break;
      default:
        expired_at = null;
    }

    const { error: updateError } = await supabase
      .from('licenses')
      .update({
        device_id,
        activated_at: now.toISOString(),
        expired_at,
      })
      .eq('license_key', license_key);

    if (updateError) {
      return res.status(500).json({ valid: false, reason: 'DATABASE_ERROR' });
    }

    await supabase.from('license_events').insert([{
      license_key,
      event_type: 'activation',
      device_id,
      note: `First activation. package=${license.package_type}. expired_at=${expired_at || 'lifetime'}`,
    }]);

    return res.status(200).json({
      valid: true,
      expired_at,
      package_type: license.package_type,
    });

  } else if (license.device_id !== device_id) {
    // ── DEVICE MISMATCH ──
    await supabase.from('license_events').insert([{
      license_key,
      event_type: 'failed_activation',
      device_id,
      note: 'Hardware ID mismatch — device binding ditolak',
    }]);

    return res.status(403).json({ valid: false, reason: 'DEVICE_MISMATCH' });

  } else {
    // ── SAME DEVICE — re-aktivasi / cache refresh ──
    await supabase.from('license_events').insert([{
      license_key,
      event_type: 'revalidation',
      device_id,
      note: 'Same device re-check',
    }]);

    return res.status(200).json({
      valid: true,
      expired_at: license.expired_at,
      package_type: license.package_type,
    });
  }
};
