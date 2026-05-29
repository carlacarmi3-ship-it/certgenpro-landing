// ============================================================
// keep-alive.js
// Cron job: expire lisensi yang sudah habis masa berlakunya
// Dipanggil oleh Vercel Cron sesuai jadwal di vercel.json
// Header Authorization: Bearer CRON_SECRET
// ============================================================

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Cron Secret' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { error } = await supabase.rpc('check_and_expire_licenses');
    if (error) throw error;
    return res.status(200).json({ message: 'Housekeeping executed successfully', timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
