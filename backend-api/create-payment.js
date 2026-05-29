// ============================================================
// create-payment.js
// Membuat Midtrans Snap token untuk checkout
// - Harga divalidasi SERVER-SIDE dari PRICELIST (bukan dari frontend)
// - Support mode Production & Sandbox via env MIDTRANS_IS_PRODUCTION
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const midtransClient = require('midtrans-client');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── PRICELIST (server-side authority) ──
const PRICELIST = {
  'Paket Harian': { amount: 29000, type: 'daily' },
  'Paket Bulanan': { amount: 99000, type: 'monthly' },
  'Paket Tahunan': { amount: 299000, type: 'yearly' },
  'Paket Seumur Hidup': { amount: 499000, type: 'lifetime' },
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, whatsapp, paket, kota } = req.body || {};

  if (!name || !email || !whatsapp || !paket) {
    return res.status(400).json({ error: 'Field name, email, whatsapp, paket wajib diisi' });
  }

  const paketData = PRICELIST[paket];
  if (!paketData) {
    return res.status(400).json({ error: 'Paket tidak dikenal' });
  }

  const { amount, type: packageType } = paketData;

  // Format WA: hilangkan karakter non-digit, pastikan diawali 62
  let waClean = whatsapp.replace(/\D/g, '');
  if (waClean.startsWith('0')) waClean = '62' + waClean.slice(1);
  if (!waClean.startsWith('62')) waClean = '62' + waClean;

  // Order ID unik
  const orderId = `CGP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  // Simpan transaksi ke Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: dbError } = await supabase.from('transactions').insert([{
    order_id: orderId,
    customer_name: name,
    customer_email: email,
    customer_wa: waClean,
    customer_city: kota || null,
    paket,
    amount,
    status: 'pending',
  }]);

  if (dbError) {
    console.error('DB error create-payment:', dbError);
    return res.status(500).json({ error: 'Gagal menyimpan transaksi' });
  }

  // Inisialisasi Midtrans Snap
  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
  const snap = new midtransClient.Snap({
    isProduction,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY,
  });

  const parameter = {
    transaction_details: {
      order_id: orderId,
      gross_amount: amount,
    },
    customer_details: {
      first_name: name,
      email,
      phone: waClean,
    },
    item_details: [{
      id: packageType,
      price: amount,
      quantity: 1,
      name: paket,
    }],
    callbacks: {
      finish: `${process.env.LANDING_URL || ''}/thank-you.html?order=${orderId}`,
      error: `${process.env.LANDING_URL || ''}/payment-status.html?status=error&order_id=${orderId}`,
      pending: `${process.env.LANDING_URL || ''}/payment-status.html?status=unfinish&order_id=${orderId}`,
    },
    // Webhook dikirim otomatis oleh Midtrans ke notification_url di dashboard
    // Untuk production: set di Midtrans Dashboard > Settings > Payment > Notification URL
  };

  try {
    const snapResponse = await snap.createTransaction(parameter);
    return res.status(200).json({
      snap_token: snapResponse.token,
      order_id: orderId,
    });
  } catch (err) {
    console.error('Midtrans error:', err);
    return res.status(500).json({ error: 'Gagal membuat token pembayaran', detail: err.message });
  }
};
