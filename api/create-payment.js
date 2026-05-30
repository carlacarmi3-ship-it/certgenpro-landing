// api/create-payment.js — CertGen Pro v3
const { createClient } = require('@supabase/supabase-js');
const midtransClient = require('midtrans-client');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Daftar harga server-side — TIDAK BISA dimanipulasi dari client
const PRICELIST = {
  daily:    { name: 'CertGen Pro — Harian',    price: 15000  },
  monthly:  { name: 'CertGen Pro — Bulanan',   price: 79000  },
  yearly:   { name: 'CertGen Pro — Tahunan',   price: 499000 },
  lifetime: { name: 'CertGen Pro — Selamanya', price: 999000 },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, whatsapp, city, package_type } = req.body;

  if (!name || !email || !whatsapp || !package_type) {
    return res.status(400).json({ error: 'name, email, whatsapp, dan package_type wajib diisi' });
  }

  const paket = PRICELIST[package_type];
  if (!paket) {
    return res.status(400).json({ error: 'package_type tidak valid' });
  }

  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

  const snap = new midtransClient.Snap({
    isProduction,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY,
  });

  // Generate order_id unik
  const timestamp = Date.now();
  const order_id = `CGP-${package_type.toUpperCase().slice(0,3)}-${timestamp}`;

  const parameter = {
    transaction_details: {
      order_id,
      gross_amount: paket.price,
    },
    item_details: [{
      id: package_type,
      price: paket.price,
      quantity: 1,
      name: paket.name,
    }],
    customer_details: {
      first_name: name,
      email,
      phone: whatsapp,
    },
    callbacks: {
      finish: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/thank-you.html`,
      error: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/payment-status.html`,
      pending: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/payment-status.html`,
    },
    notification_url: `${process.env.APP_BASE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '')}/api/midtrans-webhook`,
  };

  try {
    const transaction = await snap.createTransaction(parameter);

    // Simpan transaksi ke Supabase dengan status pending
    await supabase.from('transactions').insert([{
      order_id,
      customer_name: name,
      customer_email: email,
      customer_wa: whatsapp,
      customer_city: city || null,
      paket: package_type,
      amount: paket.price,
      status: 'pending',
    }]);

    return res.status(200).json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      order_id,
    });
  } catch (err) {
    console.error('Midtrans error:', err);
    return res.status(500).json({ error: err.message || 'Gagal membuat transaksi' });
  }
};
