// api/get-recent-sales.js — CertGen Pro v3
// Social proof: tampilkan pembelian terbaru (nama samar + paket)
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PACKAGE_DISPLAY = {
  daily:    'Paket Harian',
  monthly:  'Paket Bulanan',
  yearly:   'Paket Tahunan',
  lifetime: 'Paket Lifetime',
};

function obscureName(name) {
  if (!name) return 'Seseorang';
  const parts = name.trim().split(' ');
  const first = parts[0];
  if (first.length <= 2) return first + '**';
  return first.slice(0, 2) + '*'.repeat(Math.min(first.length - 2, 4));
}

function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('customer_name, customer_city, paket, paid_at')
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    const sales = (data || []).map(tx => ({
      name: obscureName(tx.customer_name),
      city: tx.customer_city || 'Indonesia',
      package: PACKAGE_DISPLAY[tx.paket] || tx.paket,
      time_ago: timeAgo(tx.paid_at),
    }));

    return res.status(200).json(sales);
  } catch (err) {
    console.error('get-recent-sales error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
