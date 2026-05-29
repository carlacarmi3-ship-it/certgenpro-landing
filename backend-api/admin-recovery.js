// ============================================================
// admin-recovery.js
// Endpoint POST untuk recovery lisensi manual oleh admin
// Body: { admin_secret, order_id }
// Alur:
//   1. Validasi admin_secret
//   2. Query transactions by order_id
//   3. Cek apakah sudah ada lisensi → return existing jika ada
//   4. Jika belum → generate ulang + insert + kirim email & WA ulang
//   5. Catat ke recovery_log
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const { generateLicenseInternal } = require('./generate-license');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const PAKET_TYPE_MAP = {
  'Paket Harian': 'daily',
  'Paket Bulanan': 'monthly',
  'Paket Tahunan': 'yearly',
  'Paket Seumur Hidup': 'lifetime',
  daily: 'daily',
  monthly: 'monthly',
  yearly: 'yearly',
  lifetime: 'lifetime',
};

async function sendEmailBrevo({ toEmail, toName, licenseKey, paketName, downloadLink, downloadMirror, supportWa }) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'CertGen Pro', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail, name: toName }],
      subject: `🔑 Recovery License Key CertGen Pro — ${paketName}`,
      htmlContent: `<p>Halo <b>${toName}</b>,</p>
        <p>Berikut license key Anda (recovery):</p>
        <div style="background:#f0f4ff;border:2px solid #1a237e;border-radius:10px;padding:16px;text-align:center;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;">${licenseKey}</div>
        <p>Download: <a href="${downloadLink}">${downloadLink}</a></p>
        <p>Mirror: <a href="${downloadMirror}">${downloadMirror}</a></p>
        <p>Support WA: <a href="https://wa.me/${supportWa}">Klik di sini</a></p>`,
    }),
  });
  return resp.ok;
}

async function sendWAFonnte({ waNumber, name, licenseKey, paketName, downloadLink, supportWa }) {
  const message =
    `[RECOVERY] Halo *${name}*,\n\n` +
    `Berikut license key recovery Anda:\n` +
    `*CertGen Pro — ${paketName}*\n\n` +
    `🔑 Key: \`${licenseKey}\`\n` +
    `📥 Download: ${downloadLink}\n\n` +
    `Butuh bantuan? wa.me/${supportWa}`;

  const resp = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: { 'Authorization': process.env.FONNTE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: waNumber, message, countryCode: '62' }),
  });
  return resp.ok;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, order_id } = req.body || {};

  // 1. Validasi admin_secret
  if (admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!order_id) {
    return res.status(400).json({ error: 'order_id wajib diisi' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 2. Query transaksi
  const { data: trx, error: trxErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (trxErr || !trx) {
    return res.status(404).json({ error: `Transaksi dengan order_id ${order_id} tidak ditemukan` });
  }

  // 3. Cek apakah lisensi sudah ada
  const { data: existingLic } = await supabase
    .from('licenses')
    .select('*')
    .eq('order_id', order_id)
    .maybeSingle();

  if (existingLic) {
    // Sudah ada — return data existing
    return res.status(200).json({
      success: true,
      was_existing: true,
      license_key: existingLic.license_key,
      customer_email: trx.customer_email,
      customer_wa: trx.customer_wa,
      paket: trx.paket,
      email_sent: existingLic.email_sent,
      wa_sent: existingLic.wa_sent,
      message: 'Lisensi sudah ada di database. Tidak digenerate ulang.',
    });
  }

  // 4. Generate ulang lisensi baru
  const appId = 'CERTGEN';
  const packageType = PAKET_TYPE_MAP[trx.paket] || 'lifetime';
  const { license_code } = generateLicenseInternal(appId, process.env.LICENSE_SECRET, packageType, trx.customer_email);

  const { error: licErr } = await supabase.from('licenses').insert([{
    license_key: license_code,
    order_id,
    buyer_email: trx.customer_email,
    package_type: packageType,
    package_name: trx.paket,
    app_id: appId,
    device_id: null,
    status: 'active',
    activated_at: null,
    expired_at: null,
    email_sent: false,
    wa_sent: false,
  }]);

  if (licErr) {
    return res.status(500).json({ error: 'Gagal insert lisensi', detail: licErr.message });
  }

  // 5. Kirim ulang email & WA
  let emailSent = false;
  let waSent = false;

  try {
    emailSent = await sendEmailBrevo({
      toEmail: trx.customer_email,
      toName: trx.customer_name,
      licenseKey: license_code,
      paketName: trx.paket,
      downloadLink: process.env.APP_DOWNLOAD_LINK,
      downloadMirror: process.env.APP_DOWNLOAD_LINK_MIRROR,
      supportWa: process.env.SUPPORT_WA,
    });
  } catch (e) { console.error('Email recovery gagal:', e.message); }

  try {
    waSent = await sendWAFonnte({
      waNumber: trx.customer_wa,
      name: trx.customer_name,
      licenseKey: license_code,
      paketName: trx.paket,
      downloadLink: process.env.APP_DOWNLOAD_LINK,
      supportWa: process.env.SUPPORT_WA,
    });
  } catch (e) { console.error('WA recovery gagal:', e.message); }

  // Update status kirim
  await supabase.from('licenses')
    .update({ email_sent: emailSent, wa_sent: waSent })
    .eq('license_key', license_code);

  // 6. Catat ke recovery_log
  await supabase.from('recovery_log').insert([{
    order_id,
    customer_email: trx.customer_email,
    customer_wa: trx.customer_wa,
    original_key: null,
    new_key: license_code,
    reason: 'Manual recovery by admin',
    resolved_by: 'admin',
  }]);

  return res.status(200).json({
    success: true,
    was_existing: false,
    license_key: license_code,
    customer_email: trx.customer_email,
    customer_wa: trx.customer_wa,
    paket: trx.paket,
    email_sent: emailSent,
    wa_sent: waSent,
  });
};
