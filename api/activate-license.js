// api/activate-license.js — CertGen Pro v3
// expired_at dihitung di sini saat aktivasi pertama kali
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, reason: 'METHOD_NOT_ALLOWED' });
  }

  const { license_key, device_id } = req.body;

  if (!license_key || !device_id) {
    return res.status(400).json({ valid: false, reason: 'MISSING_PARAMETERS' });
  }

  // 1. Cek Lisensi ke Supabase
  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', license_key)
    .single();

  if (error || !license) {
    return res.status(404).json({ valid: false, reason: 'INVALID_KEY' });
  }

  // Jika status sudah dicabut atau expired
  if (license.status === 'revoked' || license.status === 'expired') {
    return res.status(403).json({ valid: false, reason: license.status.toUpperCase() });
  }

  // Validasi lapis dua: cek waktu expired_at aktual (jika sudah diaktivasi sebelumnya)
  if (license.expired_at && new Date(license.expired_at) < new Date()) {
    // Update status ke expired jika belum
    await supabase.from('licenses').update({ status: 'expired' }).eq('license_key', license_key);
    return res.status(403).json({ valid: false, reason: 'EXPIRED' });
  }

  // 2. Logika Device Binding
  if (license.device_id === null) {
    // Aktivasi pertama kali — hitung expired_at berdasarkan package_type
    const now = new Date();
    let expired_at = null;

    switch (license.package_type) {
      case 'daily':
        expired_at = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        expired_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        break;
      case 'yearly':
        expired_at = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        break;
      case 'lifetime':
        expired_at = null;
        break;
      default:
        expired_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // default 30 hari
    }

    const { error: updateError } = await supabase
      .from('licenses')
      .update({
        device_id: device_id,
        activated_at: now.toISOString(),
        expired_at: expired_at ? expired_at.toISOString() : null,
      })
      .eq('license_key', license_key);

    if (updateError) {
      return res.status(500).json({ valid: false, reason: 'DATABASE_ERROR' });
    }

    // Catat event aktivasi
    await supabase.from('license_events').insert([{
      license_key,
      event_type: 'activation',
      device_id,
      note: `First time binding. Package: ${license.package_type}. Expires: ${expired_at ? expired_at.toISOString() : 'never (lifetime)'}`,
    }]);

    return res.status(200).json({
      valid: true,
      expired_at: expired_at ? expired_at.toISOString() : null,
      package_type: license.package_type,
      package_name: license.package_name,
    });

  } else if (license.device_id !== device_id) {
    // Lisensi sudah terikat ke device lain — tolak
    await supabase.from('license_events').insert([{
      license_key,
      event_type: 'failed_activation',
      device_id,
      note: 'Hardware ID mismatch attempt',
    }]);

    return res.status(403).json({ valid: false, reason: 'DEVICE_MISMATCH' });
  }

  // Device cocok — re-validasi berhasil (keep-alive check dari desktop app)
  return res.status(200).json({
    valid: true,
    expired_at: license.expired_at,
    package_type: license.package_type,
    package_name: license.package_name,
  });
};
