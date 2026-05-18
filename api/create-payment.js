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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { name, email, whatsapp, paket } = req.body;

    // --- 1. VALIDASI INPUT ---
    if (!name || !email || !whatsapp || !paket) {
      return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
    }

    // --- 2. VALIDASI PAKET & HARGA ---
    const paketKey = paket.toLowerCase().trim();
    const expectedPrice = PRICELIST[paketKey];

    if (!expectedPrice) {
      return res.status(400).json({ message: 'Paket tidak dikenali oleh sistem.' });
    }

    // --- 3. BUAT ORDER ID ---
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderId = `CGP-${timestamp}-${randomStr}`;

    // custom_field1 = name, custom_field2 = whatsapp, custom_field3 = paket
    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: expectedPrice
      },
      customer_details: {
        first_name: name,
        email: email,
        phone: whatsapp
      },
      item_details: [{
        id: paketKey.replace(/\s/g, '_'),
        price: expectedPrice,
        quantity: 1,
        name: `Lisensi CertGen Pro - ${paket}`
      }],
      custom_field1: name,      // Nama customer
      custom_field2: whatsapp,  // Nomor WhatsApp
      custom_field3: paket,     // Nama paket
      callbacks: {
        finish: `https://${req.headers.host}/thank-you.html?order=${orderId}`,
        error: `https://${req.headers.host}/renew.html?error=1`,
        pending: `https://${req.headers.host}/thank-you.html?pending=1`
      }
    };

    // --- 4. REQUEST KE MIDTRANS ---
    const transaction = await snap.createTransaction(parameter);
    const snapToken = transaction.token;

    // --- 5. SIMPAN KE DATABASE SUPABASE ---
    // ✅ FIX: Nama kolom disesuaikan dengan schema tabel transactions
    const { error: dbError } = await supabase
      .from('transactions')
      .insert([{
        order_id:       orderId,
        customer_name:  name,           // ✅ fix: bukan 'name'
        customer_email: email,          // ✅ fix: bukan 'email'
        customer_wa:    whatsapp,       // ✅ fix: bukan 'whatsapp'
        paket:          paket,
        amount:         expectedPrice,
        status:         'pending',
        created_at:     new Date().toISOString()
      }]);

    if (dbError) {
      console.error('Supabase Insert Error:', JSON.stringify(dbError, null, 2));
      throw new Error('Gagal menyimpan data ke database.');
    }

    // --- 6. KEMBALIKAN TOKEN KE FRONTEND ---
    return res.status(200).json({
      snap_token: snapToken,
      order_id: orderId
    });

  } catch (error) {
    console.error('Error Create Payment:', error);
    return res.status(500).json({
      message: error.message || 'Terjadi kesalahan pada server saat membuat pembayaran.'
    });
  }
};
