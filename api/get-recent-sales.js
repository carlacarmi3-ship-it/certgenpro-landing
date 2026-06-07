// api/get-recent-sales.js
// Mengembalikan data penjualan terbaru untuk social proof di landing page

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache 60 detik di Vercel Edge
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('social_proof')
    .select('customer_name, customer_city, paket, created_at, verified')
    .eq('verified', true)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) {
    return res.status(200).json([]);
  }

  // Format time_ago
  const result = data.map(row => {
    const diffMs  = Date.now() - new Date(row.created_at).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr  = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    let time_ago;
    if (diffMin < 2)       time_ago = 'baru saja';
    else if (diffMin < 60) time_ago = `${diffMin} menit lalu`;
    else if (diffHr < 24)  time_ago = `${diffHr} jam lalu`;
    else                   time_ago = `${diffDay} hari lalu`;

    // Sensor nama: "Ahmad Fauzi" → "Ahmad F***"
    const nameParts = row.customer_name.split(' ');
    const maskedName = nameParts.length > 1
      ? `${nameParts[0]} ${nameParts[1][0]}***`
      : `${row.customer_name[0]}***`;

    return {
      customer_name: maskedName,
      customer_city: row.customer_city,
      paket:         row.paket,
      time_ago,
    };
  });

  return res.status(200).json(result);
};
