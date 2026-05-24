// api/get-recent-sales.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    // Mengambil 10 data yang statusnya 'paid' beserta Kolom KOTA-nya
    const { data, error } = await supabase
      .from('transactions')
      .select('customer_name, customer_city, paket, paid_at')
      .eq('status', 'paid')
      .order('paid_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    // Masking nama belakang untuk menjaga privasi
    const formattedData = data.map(trx => {
      let nameParts = trx.customer_name.trim().split(' ');
      let displayName = nameParts[0];
      if (nameParts.length > 1) {
        displayName += ' ' + nameParts[nameParts.length - 1].charAt(0).toUpperCase() + '.';
      }

      return {
        name: displayName,
        city: trx.customer_city || "", // String kosong jika tidak ada kota
        paket: trx.paket,
        time: trx.paid_at
      };
    });

    return res.status(200).json(formattedData);
  } catch (error) {
    console.error('Error fetching sales:', error);
    return res.status(200).json([]); // Jangan lempar 500, kembalikan array kosong agar frontend tidak error
  }
};