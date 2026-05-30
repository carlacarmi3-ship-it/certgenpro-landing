// api/midtrans-webhook.js — CertGen Pro v3
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseInternal } = require('./generate-license');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Nama paket untuk tampilan
const PACKAGE_NAMES = {
  daily:    'CertGen Pro — Harian (1 Hari)',
  monthly:  'CertGen Pro — Bulanan (30 Hari)',
  yearly:   'CertGen Pro — Tahunan (365 Hari)',
  lifetime: 'CertGen Pro — Selamanya (Lifetime)',
};

async function sendBrevoEmail(to_email, to_name, license_key, package_name) {
  const downloadLink = process.env.APP_DOWNLOAD_LINK || '#';
  const downloadMirror = process.env.APP_DOWNLOAD_LINK_MIRROR || '#';
  const supportWA = process.env.SUPPORT_WA || '';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
  <div style="background: #fff; border-radius: 12px; padding: 40px; border: 1px solid #e0e0e0;">
    <h1 style="color: #1a1a2e; font-size: 24px; margin-bottom: 8px;">🎉 Pembayaran Berhasil!</h1>
    <p style="color: #555; font-size: 16px;">Halo <strong>${to_name}</strong>, terima kasih telah membeli <strong>${package_name}</strong>.</p>
    
    <div style="background: #f0f4ff; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
      <p style="color: #555; margin: 0 0 8px; font-size: 14px;">Lisensi Anda:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #2563eb; letter-spacing: 2px; margin: 0;">${license_key}</p>
    </div>
    
    <p style="color: #555;">Salin kode di atas dan masukkan saat pertama kali membuka aplikasi CertGen Pro.</p>
    
    <div style="margin: 24px 0;">
      <a href="${downloadLink}" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-right: 12px;">⬇️ Download Aplikasi</a>
      <a href="${downloadMirror}" style="display: inline-block; background: #475569; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">🔗 Link Mirror</a>
    </div>

    <p style="color: #888; font-size: 14px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px;">
      Butuh bantuan? Hubungi support kami di WhatsApp: <strong>+${supportWA}</strong><br>
      <em>Harap simpan email ini sebagai bukti pembelian Anda.</em>
    </p>
  </div>
</body>
</html>`;

  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'CertGen Pro', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: to_email, name: to_name }],
    subject: `🔑 Lisensi CertGen Pro Anda — ${license_key}`,
    htmlContent,
  }, {
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
  });
}

async function sendFonnteWA(to_number, license_key, package_name) {
  const downloadLink = process.env.APP_DOWNLOAD_LINK || '#';
  const supportWA = process.env.SUPPORT_WA || '';

  const message = `✅ *Pembayaran CertGen Pro Berhasil!*

Terima kasih atas pembelian Anda.

📦 *Paket:* ${package_name}
🔑 *Lisensi Key:*
\`${license_key}\`

📥 *Download Aplikasi:*
${downloadLink}

Cara aktivasi: buka aplikasi → masukkan lisensi key di atas.

Butuh bantuan? Chat admin: wa.me/${supportWA}

_Harap simpan pesan ini sebagai bukti pembelian._`;

  await axios.post('https://api.fonnte.com/send', {
    target: to_number,
    message,
  }, {
    headers: { Authorization: process.env.FONNTE_TOKEN },
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body;

  // Verifikasi signature Midtrans
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const signatureString = `${payload.order_id}${payload.status_code}${payload.gross_amount}${serverKey}`;
  const expectedSignature = crypto.createHash('sha512').update(signatureString).digest('hex');

  if (payload.signature_key !== expectedSignature) {
    console.error('Invalid Midtrans signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const { order_id, transaction_status, fraud_status } = payload;

  // Hanya proses settlement (pembayaran berhasil)
  const isSettled = transaction_status === 'settlement' ||
    (transaction_status === 'capture' && fraud_status === 'accept');

  if (!isSettled) {
    // Update status pending/expire/cancel di DB
    const statusMap = {
      'pending': 'pending',
      'deny': 'failed',
      'cancel': 'failed',
      'expire': 'expired',
    };
    const newStatus = statusMap[transaction_status] || transaction_status;
    await supabase.from('transactions').update({ status: newStatus }).eq('order_id', order_id);
    return res.status(200).json({ message: `Status updated to ${newStatus}` });
  }

  // Cek duplikat — jika sudah paid, skip
  const { data: existingTx } = await supabase
    .from('transactions')
    .select('status')
    .eq('order_id', order_id)
    .single();

  if (existingTx?.status === 'paid') {
    return res.status(200).json({ message: 'Already processed' });
  }

  // Ambil data transaksi
  const { data: transaction } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  // Update status transaksi ke paid
  await supabase.from('transactions').update({
    status: 'paid',
    payment_type: payload.payment_type || null,
    paid_at: new Date().toISOString(),
    raw_payload: payload,
  }).eq('order_id', order_id);

  // Generate lisensi
  const appId = 'CERTGEN';
  const secret = process.env.LICENSE_SECRET;
  const { license_code } = generateLicenseInternal(appId, secret, transaction.paket, transaction.customer_email);
  const package_name = PACKAGE_NAMES[transaction.paket] || transaction.paket;

  let email_sent = false;
  let wa_sent = false;

  // Insert lisensi ke DB (expired_at = NULL, diisi saat aktivasi)
  await supabase.from('licenses').insert([{
    license_key: license_code,
    order_id,
    buyer_email: transaction.customer_email,
    package_type: transaction.paket,
    package_name,
    app_id: appId,
    status: 'active',
    expired_at: null,
  }]);

  // Kirim Email via Brevo
  try {
    await sendBrevoEmail(transaction.customer_email, transaction.customer_name, license_code, package_name);
    email_sent = true;
  } catch (err) {
    console.error('Brevo error:', err.message);
  }

  // Kirim WA via Fonnte
  try {
    if (transaction.customer_wa) {
      await sendFonnteWA(transaction.customer_wa, license_code, package_name);
      wa_sent = true;
    }
  } catch (err) {
    console.error('Fonnte error:', err.message);
  }

  // Update flag pengiriman
  await supabase.from('licenses')
    .update({ email_sent, wa_sent })
    .eq('license_key', license_code);

  return res.status(200).json({
    message: 'License generated and sent',
    license_key: license_code,
    email_sent,
    wa_sent,
  });
};
