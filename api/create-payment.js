// api/create-payment.js
// Membuat Midtrans Snap token dan menyimpan transaksi ke Supabase

const { createClient } = require('@supabase/supabase-js');
const midtransClient    = require('midtrans-client');

// ============================================================
// PRICE LIST — server-side validation (jangan percaya client)
// ============================================================
const PRICE_LIST = {
  daily:    { amount: 19000,  label: 'Paket Harian'   },
  monthly:  { amount: 49000,  label: 'Paket Bulanan'  },
  yearly:   { amount: 149000, label: 'Paket Tahunan'  },
  lifetime: { amount: 299000, label: 'Paket Lifetime' },
};

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    package_type,
    customer_name,
    customer_email,
    customer_wa,
    customer_city,
    renew_license_key = null,
  } = req.body;

  // ── Validasi input ─────────────────────────────────────────
  if (!package_type || !PRICE_LIST[package_type]) {
    return res.status(400).json({ error: 'Paket tidak valid.' });
  }
  if (!customer_name || !customer_email || !customer_wa) {
    return res.status(400).json({ error: 'Data pembeli tidak lengkap.' });
  }

  const pkg    = PRICE_LIST[package_type];
  const amount = pkg.amount;

  // ── Supabase client ────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Generate order_id unik ─────────────────────────────────
  const ts      = Date.now();
  const rand    = Math.random().toString(36).substring(2, 6).toUpperCase();
  const orderId = `CGP-${ts}-${rand}`;

  // ── Simpan transaksi ke Supabase ───────────────────────────
  const { error: dbError } = await supabase.from('transactions').insert({
    order_id:       orderId,
    customer_name:  customer_name.trim(),
    customer_email: customer_email.trim().toLowerCase(),
    customer_wa:    customer_wa.trim().replace(/^0/, '62'),
    customer_city:  customer_city ? customer_city.trim() : '',
    paket:          pkg.label,
    amount,
    status:         'pending',
    raw_payload:    { package_type, renew_license_key },
  });

  if (dbError) {
    console.error('[create-payment] DB error:', dbError);
    return res.status(500).json({ error: 'Gagal menyimpan transaksi.' });
  }

  // ── Buat Midtrans Snap token ───────────────────────────────
  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

  const snap = new midtransClient.Snap({
    isProduction,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY,
  });

  const baseUrl = process.env.APP_BASE_URL || 'https://certgenpro.vercel.app';

  const parameter = {
    transaction_details: {
      order_id: orderId,
      gross_amount: amount,
    },
    customer_details: {
      first_name:   customer_name.trim(),
      email:        customer_email.trim().toLowerCase(),
      phone:        customer_wa.trim(),
    },
    item_details: [
      {
        id:       package_type,
        price:    amount,
        quantity: 1,
        name:     pkg.label,
        brand:    'CertGen PRO',
        category: 'Software License',
      },
    ],
    callbacks: {
      finish:  `${baseUrl}/thank-you.html?order_id=${orderId}`,
      error:   `${baseUrl}/payment-status.html?order_id=${orderId}&status=error`,
      pending: `${baseUrl}/payment-status.html?order_id=${orderId}&status=pending`,
    },
    // Midtrans notification URL (backup — utamanya set di dashboard Midtrans)
    notification_url: `${baseUrl}/api/midtrans-webhook`,
    // Custom field untuk keperluan webhook
    custom_field1: package_type,
    custom_field2: renew_license_key || '',
    custom_field3: customer_wa.trim().replace(/^0/, '62'),
  };

  try {
    const transaction = await snap.createTransaction(parameter);
    return res.status(200).json({
      snap_token: transaction.token,
      order_id:   orderId,
    });
  } catch (err) {
    console.error('[create-payment] Midtrans error:', err);
    return res.status(500).json({ error: 'Gagal membuat sesi pembayaran Midtrans.' });
  }
};
