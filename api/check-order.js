// api/check-order.js
// Dipakai oleh thank-you.html untuk polling status transaksi + ambil license key

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { order_id } = req.query;
  if (!order_id) return res.status(400).json({ error: 'order_id diperlukan.' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Ambil transaksi
  const { data: tx, error: txErr } = await supabase
    .from('transactions')
    .select('order_id, customer_name, customer_email, paket, amount, status, paid_at')
    .eq('order_id', order_id)
    .single();

  if (txErr || !tx) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  }

  // Ambil license key jika status paid
  let licenseKey = null;
  if (tx.status === 'paid') {
    const { data: lic } = await supabase
      .from('licenses')
      .select('license_key, email_sent, wa_sent')
      .eq('order_id', order_id)
      .single();

    if (lic) licenseKey = lic.license_key;
  }

  return res.status(200).json({
    ...tx,
    license_key: licenseKey,
  });
};
