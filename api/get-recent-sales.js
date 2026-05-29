// ============================================================
// get-recent-sales.js
// Mengembalikan data penjualan terakhir untuk social proof
// Hanya return: nama, kota, paket (TANPA email/WA)
// ============================================================

const { createClient } = require('@supabase/supabase-js');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('transactions')
    .select('customer_name, customer_city, paket, paid_at')
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(20);

  if (error) {
    return res.status(500).json([]);
  }

  // Anonimkan nama: "Budi S." → "Budi S"
  const cleaned = (data || []).map(t => ({
    name: anonymizeName(t.customer_name),
    city: t.customer_city || null,
    paket: t.paket,
  }));

  return res.status(200).json(cleaned);
};

function anonymizeName(fullName) {
  if (!fullName) return 'Pembeli';
  const parts = fullName.trim().split(' ');
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[1][0] + '.';
}
