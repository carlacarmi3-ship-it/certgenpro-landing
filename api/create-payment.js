// api/create-payment.js
const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');

// 1. Inisialisasi Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Inisialisasi Midtrans Snap
const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Daftar harga resmi (Server-side validation)
const PRICELIST = {
  'paket harian':   19000,
  'paket bulanan':  79000,
  'paket tahunan':  299000,
  'paket lifetime': 599000
};

module.exports = async function handler(req, res) {
  // --- KONFIGURASI CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  try {
    // ✅ Menangkap kota dari req.body (opsional, jika diblock adblock akan kosong)
    const { name, email, whatsapp, paket, kota } = req.body;

    if (!name || !email || !whatsapp || !paket) {
      return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
    }

    const paketKey = paket.toLowerCase().trim();
    const expectedPrice = PRICELIST[paketKey];

    if (!expectedPrice) {
      return res.status(400).json({ message: 'Paket tidak dikenali oleh sistem.' });
    }

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderId = `CGP-${timestamp}-${randomStr}`;

    const parameter = {
      transaction_details: { order_id: orderId, gross_amount: expectedPrice },
      customer_details: { first_name: name, email: email, phone: whatsapp },
      item_details: [{
        id: paketKey.replace(/\s/g, '_'), price: expectedPrice, quantity: 1, name: `Lisensi CertGen Pro - ${paket}`
      }],
      custom_field1: name,
      custom_field2: email,
      // ✅ Menyisipkan KOTA ke JSON bersama WA & Paket untuk webhook
      custom_field3: JSON.stringify({ wa: whatsapp, paket: paket, kota: kota || "" }),
      callbacks: {
        finish: `https://${req.headers.host}/thank-you.html?order=${orderId}`,
        error: `https://${req.headers.host}/renew.html?error=1`,
        pending: `https://${req.headers.host}/thank-you.html?pending=1`
      }
    };

    const transaction = await snap.createTransaction(parameter);
    const snapToken = transaction.token;

    const { error: dbError } = await supabase
      .from('transactions')
      .insert([{
        order_id:       orderId,
        customer_name:  name,
        customer_email: email,
        customer_wa:    whatsapp,
        paket:          paket,
        amount:         expectedPrice,
        status:         'pending',
        created_at:     new Date().toISOString()
      }]);

    if (dbError) throw new Error('Gagal menyimpan data ke database.');

    return res.status(200).json({ snap_token: snapToken, order_id: orderId });

  } catch (error) {
    console.error('Error Create Payment:', error);
    return res.status(500).json({ message: error.message || 'Terjadi kesalahan sistem.' });
  }
};