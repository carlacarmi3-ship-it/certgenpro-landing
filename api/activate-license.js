// api/activate-license.js
// Aktivasi License Key dari Desktop App
// Flow: validasi key → cek device binding → set expired_at → return status
// Dipanggil oleh license_manager.py di aplikasi Python

const { createClient } = require('@supabase/supabase-js');

// ============================================================
// Kalkulasi expired_at berdasarkan package_type
// Dipanggil saat aktivasi pertama kali (device binding)
// ============================================================
function calculateExpiredAt(packageType) {
  const now = new Date();
  switch (packageType) {
    case 'daily':
      now.setDate(now.getDate() + 1);
      return now.toISOString();
    case 'monthly':
      now.setDate(now.getDate() + 30);
      return now.toISOString();
    case 'yearly':
      now.setDate(now.getDate() + 365);
      return now.toISOString();
    case 'lifetime':
      return null; // NULL = seumur hidup
    default:
      now.setDate(now.getDate() + 30);
      return now.toISOString();
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { license_key, device_id, app_id = 'CERTGEN' } = req.body;

  if (!license_key || !device_id) {
    return res.status(400).json({
      success: false,
      error:   'license_key dan device_id wajib diisi.',
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Cari lisensi di database ───────────────────────────────
  const { data: lic, error: fetchErr } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', license_key.trim().toUpperCase())
    .eq('app_id', app_id)
    .single();

  if (fetchErr || !lic) {
    await logEvent(supabase, license_key, 'activation_failed', device_id, 'Key tidak ditemukan');
    return res.status(404).json({
      success: false,
      error:   'License Key tidak valid atau tidak ditemukan.',
    });
  }

  // ── Cek status lisensi ─────────────────────────────────────
  if (lic.status === 'revoked') {
    await logEvent(supabase, license_key, 'activation_rejected', device_id, 'Lisensi dicabut');
    return res.status(403).json({
      success: false,
      error:   'Lisensi ini telah dicabut. Hubungi support untuk bantuan.',
    });
  }

  // ── Cek expired (untuk lisensi yang sudah diaktifkan sebelumnya) ─
  if (lic.status === 'expired' || (lic.expired_at && new Date(lic.expired_at) < new Date())) {
    await supabase.from('licenses').update({ status: 'expired' }).eq('license_key', license_key);
    await logEvent(supabase, license_key, 'activation_rejected', device_id, 'Lisensi kedaluwarsa');
    return res.status(403).json({
      success:    false,
      error:      'Lisensi sudah kedaluwarsa. Silakan perpanjang di certgenpro.vercel.app/renew.html',
      expired_at: lic.expired_at,
    });
  }

  // ── Skenario A: Belum diaktifkan sebelumnya (device_id = NULL) ─
  if (!lic.device_id) {
    const expiredAt = calculateExpiredAt(lic.package_type);

    const { error: updateErr } = await supabase
      .from('licenses')
      .update({
        device_id:    device_id,
        activated_at: new Date().toISOString(),
        expired_at:   expiredAt,
        status:       'active',
      })
      .eq('license_key', license_key);

    if (updateErr) {
      console.error('[activate-license] Update error:', updateErr);
      return res.status(500).json({ success: false, error: 'Gagal menyimpan aktivasi.' });
    }

    await logEvent(supabase, license_key, 'activated', device_id,
      `Aktivasi pertama. Package: ${lic.package_type}. Expires: ${expiredAt || 'lifetime'}`);

    console.log('[activate-license] Aktivasi sukses:', license_key, '| device:', device_id);
    return res.status(200).json({
      success:      true,
      message:      'Lisensi berhasil diaktifkan!',
      license_key,
      package_type: lic.package_type,
      package_name: lic.package_name,
      activated_at: new Date().toISOString(),
      expired_at:   expiredAt,
      status:       'active',
    });
  }

  // ── Skenario B: Sudah diaktifkan — cek apakah device sama ─
  if (lic.device_id === device_id) {
    // Device sama → validasi normal (re-login, cek saat buka app)
    await logEvent(supabase, license_key, 'validated', device_id, 'Re-validasi device yang sama');
    return res.status(200).json({
      success:      true,
      message:      'Lisensi valid.',
      license_key,
      package_type: lic.package_type,
      package_name: lic.package_name,
      activated_at: lic.activated_at,
      expired_at:   lic.expired_at,
      status:       'active',
    });
  }

  // ── Skenario C: Device berbeda → TOLAK (device binding) ───
  await logEvent(supabase, license_key, 'activation_blocked', device_id,
    `Percobaan aktivasi dari device berbeda. Device terdaftar: ${lic.device_id}`);

  return res.status(403).json({
    success: false,
    error:   'Lisensi ini sudah terdaftar di perangkat lain. 1 lisensi hanya untuk 1 perangkat. Hubungi support jika ingin pindah perangkat.',
  });
};

// ── Helper: catat event ke license_events ─────────────────
async function logEvent(supabase, licenseKey, eventType, deviceId, note) {
  await supabase.from('license_events').insert({
    license_key: licenseKey,
    event_type:  eventType,
    device_id:   deviceId,
    note,
  }).then(() => {}).catch(() => {});
}
