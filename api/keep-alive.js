// api/keep-alive.js — CertGen Pro v3
// Dijalankan otomatis via Vercel Cron — expire lisensi yang sudah habis masa berlakunya
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  // Validasi Header Authorization dari Vercel Cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Cron Secret' });
  }

  try {
    const { error } = await supabase.rpc('check_and_expire_licenses');
    if (error) throw error;
    res.status(200).json({ message: 'Housekeeping executed successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
