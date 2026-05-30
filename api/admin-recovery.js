// api/admin-recovery.js — CertGen Pro v3
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseInternal } = require('./generate-license');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    <h1 style="color: #1a1a2e; font-size: 24px; margin-bottom: 8px;">🔑 Recovery Lisensi CertGen Pro</h1>
    <p style="color: #555; font-size: 16px;">Halo <strong>${to_name}</strong>, berikut adalah lisensi untuk <strong>${package_name}</strong> Anda.</p>
    
    <div style="background: #f0f4ff; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
      <p style="color: #555; margin: 0 0 8px; font-size: 14px;">Lisensi Anda:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #2563eb; letter-spacing: 2px; margin: 0;">${license_key}</p>
    </div>

    <div style="margin: 24px 0;">
      <a href="${downloadLink}" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-right: 12px;">⬇️ Download Aplikasi</a>
      <a href="${downloadMirror}" style="display: inline-block; background: #475569; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">🔗 Link Mirror</a>
    </div>

    <p style="color: #888; font-size: 14px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px;">
      Butuh bantuan? Hubungi support: <strong>+${supportWA}</strong>
    </p>
  </div>
</body>
</html>`;

  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: 'CertGen Pro', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: to_email, name: to_name }],
    subject: `🔑 [Recovery] Lisensi CertGen Pro Anda — ${license_key}`,
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

  const message = `🔑 *[Recovery] Lisensi CertGen Pro*

Halo! Berikut adalah lisensi Anda.

📦 *Paket:* ${package_name}
🔑 *Lisensi Key:*
\`${license_key}\`

📥 *Download Aplikasi:*
${downloadLink}

Butuh bantuan? Chat: wa.me/${supportWA}`;

  await axios.post('https://api.fonnte.com/send', {
    target: to_number,
    message,
  }, {
    headers: { Authorization: process.env.FONNTE_TOKEN },
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, order_id } = req.body;

  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Secret' });
  }

  if (!order_id) {
    return res.status(400).json({ error: 'order_id is required' });
  }

  // Ambil data transaksi
  const { data: transaction, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (txError || !transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  if (transaction.status !== 'paid') {
    return res.status(400).json({ error: `Transaction status is '${transaction.status}', not 'paid'. Recovery only for paid transactions.` });
  }

  // Cek apakah lisensi sudah ada
  const { data: existingLicense } = await supabase
    .from('licenses')
    .select('*')
    .eq('order_id', order_id)
    .single();

  let license_key;
  let was_existing = false;
  let email_sent = false;
  let wa_sent = false;

  if (existingLicense) {
    // Lisensi sudah ada — return existing, kirim ulang notifikasi
    license_key = existingLicense.license_key;
    was_existing = true;
    email_sent = existingLicense.email_sent;
    wa_sent = existingLicense.wa_sent;
  } else {
    // Generate lisensi baru
    const appId = 'CERTGEN';
    const secret = process.env.LICENSE_SECRET;
    const { license_code } = generateLicenseInternal(appId, secret, transaction.paket, transaction.customer_email);
    license_key = license_code;
    const package_name = PACKAGE_NAMES[transaction.paket] || transaction.paket;

    await supabase.from('licenses').insert([{
      license_key,
      order_id,
      buyer_email: transaction.customer_email,
      package_type: transaction.paket,
      package_name,
      app_id: appId,
      status: 'active',
      expired_at: null,
    }]);
  }

  const package_name = PACKAGE_NAMES[transaction.paket] || transaction.paket;

  // Kirim ulang Email
  try {
    await sendBrevoEmail(transaction.customer_email, transaction.customer_name, license_key, package_name);
    email_sent = true;
  } catch (err) {
    console.error('Brevo error:', err.message);
  }

  // Kirim ulang WA
  try {
    if (transaction.customer_wa) {
      await sendFonnteWA(transaction.customer_wa, license_key, package_name);
      wa_sent = true;
    }
  } catch (err) {
    console.error('Fonnte error:', err.message);
  }

  // Update flag di DB
  await supabase.from('licenses')
    .update({ email_sent, wa_sent })
    .eq('license_key', license_key);

  // Catat ke recovery_log
  await supabase.from('recovery_log').insert([{
    order_id,
    customer_email: transaction.customer_email,
    customer_wa: transaction.customer_wa || null,
    original_key: was_existing ? license_key : null,
    new_key: was_existing ? null : license_key,
    reason: was_existing ? 'Resend existing license' : 'Generated new license (missing)',
    resolved_by: 'admin',
  }]);

  return res.status(200).json({
    message: was_existing ? 'Existing license resent' : 'New license generated and sent',
    license_key,
    customer_email: transaction.customer_email,
    customer_wa: transaction.customer_wa,
    paket: transaction.paket,
    was_existing,
    email_sent,
    wa_sent,
  });
};
