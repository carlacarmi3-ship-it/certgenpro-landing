// api/get-recent-sales.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // --- KONFIGURASI CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    // Validasi internal variabel env agar tidak crash senyap
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables are missing on host.");
    }

    // Inisialisasi di dalam handler untuk kestabilan serverless cold-start
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('transactions')
      .select('customer_name, customer_city, paket, paid_at')
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    const formattedData = (data || []).map(trx => {
      let nameParts = (trx.customer_name || "Pelanggan").trim().split(' ');
      let displayName = nameParts[0];
      if (nameParts.length > 1) {
        displayName += ' ' + nameParts[nameParts.length - 1].charAt(0).toUpperCase() + '.';
      }

      return {
        name: displayName,
        city: trx.customer_city || "",
        paket: trx.paket || "paket bulanan",
        time: trx.paid_at
      };
    });

    return res.status(200).json(formattedData);
  } catch (error) {
    console.error('Error fetching sales:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
};