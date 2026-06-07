// api/check-license.js
// Dipakai oleh halaman renew.html untuk cek status lisensi sebelum perpanjangan

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { license_key } = req.body;
  if (!license_key) return res.status(400).json({ error: 'license_key diperlukan.' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: lic, error } = await supabase
    .from('licenses')
    .select('license_key, package_type, package_name, status, activated_at, expired_at, buyer_email, app_id')
    .eq('license_key', license_key.trim().toUpperCase())
    .single();

  if (error || !lic) {
    return res.status(404).json({ error: 'License Key tidak ditemukan.' });
  }

  // Auto-update status jika sudah expired
  if (lic.expired_at && new Date(lic.expired_at) < new Date() && lic.status === 'active') {
    await supabase.from('licenses').update({ status: 'expired' }).eq('license_key', lic.license_key);
    lic.status = 'expired';
  }

  return res.status(200).json(lic);
};
