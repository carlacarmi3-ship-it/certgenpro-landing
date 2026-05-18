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
// Frontend boleh mengirim harga, tapi kita akan pakai harga dari sini untuk keamanan
const PRICELIST = {
  'paket harian': 19000,
  'paket bulanan': 79000,
  'paket tahunan': 299000,
  'paket lifetime': 599000
};

export default async function handler(req, res) {
  // --- KONFIGURASI CORS (Mengizinkan frontend mengakses API ini) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle Preflight request (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- VALIDASI METODE REQUEST ---
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { name, email, whatsapp, paket, harga } = req.body;

    // --- 1. VALIDASI INPUT KOSONG ---
    if (!name || !email || !whatsapp || !paket) {
      return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
    }

    // --- 2. VALIDASI HARGA & PAKET (KEAMANAN) ---
    // Ubah nama paket jadi huruf kecil semua untuk pencocokan
    const paketKey = paket.toLowerCase().trim(); 
    const expectedPrice = PRICELIST[paketKey];

    if (!expectedPrice) {
      return res.status(400).json({ message: 'Paket tidak dikenali oleh sistem.' });
    }

    // --- 3. BUAT DATA TRANSAKSI ---
    // Format Order ID: CGP-TahunBulanTanggalJamMenitDetik-AngkaRandom
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderId = `CGP-${timestamp}-${randomStr}`;

    // Parameter untuk Midtrans Snap
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
      // Custom fields sangat berguna untuk dikirim ulang oleh webhook Midtrans nantinya
      custom_field1: whatsapp,
      custom_field2: paket,
      // Setting Redirect URL setelah user bayar (opsional, karena di frontend kita sudah pakai JS snap.pay callbacks)
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
    const { error: dbError } = await supabase
      .from('transactions')
      .insert([
        {
          order_id: orderId,
          name: name,
          email: email,
          whatsapp: whatsapp,
          paket: paket,
          harga: expectedPrice,
          status: 'pending', // Status awal selalu pending sebelum ada info dari Midtrans Webhook
          created_at: new Date().toISOString()
        }
      ]);

    if (dbError) {
      console.error('Supabase Insert Error:', dbError);
      // Kita tetap lanjut return token meski save DB gagal sebentar (opsional, bisa juga dibuat gagal)
      // Namun untuk sistem yang baik, lebih baik kita throw error jika DB gagal
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
}
