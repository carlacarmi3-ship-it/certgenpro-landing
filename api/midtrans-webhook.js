// ============================================================
// midtrans-webhook.js
// Menerima notifikasi pembayaran dari Midtrans (production/sandbox)
// Saat settlement/capture:
//   1. Verifikasi signature HMAC-SHA512
//   2. Generate lisensi via generateLicenseInternal
//   3. Insert ke tabel licenses (expired_at = NULL, diisi saat aktivasi)
//   4. Kirim email via Brevo
//   5. Kirim WA via Fonnte
// ============================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseInternal } = require('./generate-license');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Kirim Email via Brevo ──
async function sendEmailBrevo({ toEmail, toName, licenseKey, paketName, downloadLink, downloadMirror, supportWa }) {
  const htmlBody = `
<!DOCTYPE html>
<html lang="id">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(13,27,75,.1);">
        <!-- HEADER -->
        <tr>
          <td style="background:linear-gradient(135deg,#0d1b4b 0%,#1a237e 100%);padding:32px 40px;text-align:center;">
            <div style="display:inline-block;background:#f9a825;border-radius:10px;padding:8px 14px;font-size:20px;font-weight:900;color:#0d1b4b;letter-spacing:-0.5px;">C</div>
            <span style="color:#ffffff;font-size:20px;font-weight:700;margin-left:10px;">CertGen <span style="color:#f9a825;">Pro</span></span>
            <p style="color:rgba(255,255,255,.7);margin:8px 0 0;font-size:13px;">Pembayaran Berhasil ✅</p>
          </td>
        </tr>
        <!-- BODY -->
        <tr>
          <td style="padding:36px 40px;">
            <p style="font-size:16px;color:#1a202c;margin:0 0 8px;">Halo <strong>${toName}</strong>,</p>
            <p style="font-size:14px;color:#4a5568;margin:0 0 28px;line-height:1.7;">
              Terima kasih telah membeli <strong>${paketName}</strong>. Berikut adalah license key Anda yang siap diaktivasi:
            </p>

            <!-- LICENSE KEY BOX -->
            <div style="background:#f8f9ff;border:2px solid #1a237e;border-radius:12px;padding:20px;text-align:center;margin-bottom:28px;">
              <p style="font-size:11px;color:#8892b0;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px;">License Key</p>
              <p style="font-family:'Courier New',monospace;font-size:20px;font-weight:700;color:#0d1b4b;letter-spacing:2px;margin:0;word-break:break-all;">${licenseKey}</p>
            </div>

            <!-- CARA AKTIVASI -->
            <p style="font-size:14px;font-weight:700;color:#0d1b4b;margin:0 0 12px;">📋 Cara Aktivasi:</p>
            <ol style="font-size:13px;color:#4a5568;line-height:2;padding-left:20px;margin:0 0 24px;">
              <li>Download software CertGen Pro (link di bawah)</li>
              <li>Install dan buka aplikasi</li>
              <li>Masukkan license key di atas</li>
              <li>Klik <strong>Aktivasi</strong> — selesai!</li>
            </ol>

            <!-- DOWNLOAD BUTTONS -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="padding-right:8px;">
                  <a href="${downloadLink}" style="display:block;background:linear-gradient(135deg,#f9a825,#f57f17);color:#0d1b4b;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:14px;font-weight:700;">⬇️ Download (Utama)</a>
                </td>
                <td style="padding-left:8px;">
                  <a href="${downloadMirror}" style="display:block;background:#eef0f6;color:#0d1b4b;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:14px;font-weight:700;">🔗 Download (Mirror)</a>
                </td>
              </tr>
            </table>

            <p style="font-size:13px;color:#8892b0;line-height:1.7;margin:0;">
              Simpan email ini baik-baik. License key ini terhubung ke perangkat Anda setelah aktivasi pertama.<br>
              Butuh bantuan? Hubungi kami di <a href="https://wa.me/${supportWa}" style="color:#1a237e;">WhatsApp Support</a>.
            </p>
          </td>
        </tr>
        <!-- FOOTER -->
        <tr>
          <td style="background:#f8f9ff;border-top:1px solid #eef0f6;padding:20px 40px;text-align:center;">
            <p style="font-size:12px;color:#8892b0;margin:0;">© 2025 CertGen Pro · Made with ❤️ in Indonesia</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'CertGen Pro', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail, name: toName }],
      subject: `🎉 License Key CertGen Pro — ${paketName}`,
      htmlContent: htmlBody,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Brevo error ${resp.status}: ${errText}`);
  }
  return true;
}

// ── Kirim WA via Fonnte ──
async function sendWAFonnte({ waNumber, name, licenseKey, paketName, downloadLink, supportWa }) {
  const message =
    `Halo *${name}*! 👋\n\n` +
    `Terima kasih sudah membeli *CertGen Pro — ${paketName}* ✅\n\n` +
    `🔑 *License Key Anda:*\n` +
    `\`${licenseKey}\`\n\n` +
    `📥 *Download Software:*\n${downloadLink}\n\n` +
    `📋 *Cara Aktivasi:*\n` +
    `1. Download & install CertGen Pro\n` +
    `2. Buka aplikasi\n` +
    `3. Masukkan license key di atas\n` +
    `4. Klik Aktivasi — selesai!\n\n` +
    `⚠️ Simpan key ini baik-baik. Key terhubung ke 1 perangkat setelah aktivasi.\n\n` +
    `Butuh bantuan? Balas pesan ini atau chat WA support: wa.me/${supportWa}`;

  const resp = await fetch('https://api.fonnte.com/send', {
    method: 'POST',
    headers: {
      'Authorization': process.env.FONNTE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      target: waNumber,
      message,
      countryCode: '62',
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Fonnte error ${resp.status}: ${errText}`);
  }
  return true;
}

// ── PAKET MAPPING ──
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

// ── WEBHOOK HANDLER ──
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body;
  const {
    order_id,
    status_code,
    gross_amount,
    signature_key,
    transaction_status,
    fraud_status,
    payment_type,
  } = payload;

  // 1. Verifikasi signature Midtrans (HMAC-SHA512)
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  const expectedSig = crypto
    .createHash('sha512')
    .update(`${order_id}${status_code}${gross_amount}${serverKey}`)
    .digest('hex');

  if (signature_key !== expectedSig) {
    console.warn('Webhook signature mismatch:', order_id);
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // 2. Hanya proses jika settlement/capture dan tidak fraud
  const isSettled =
    transaction_status === 'settlement' ||
    (transaction_status === 'capture' && fraud_status === 'accept');

  if (!isSettled) {
    return res.status(200).json({ message: `Status ${transaction_status} — tidak diproses` });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 3. Cek transaksi di DB
  const { data: trx, error: trxErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (trxErr || !trx) {
    console.error('Transaksi tidak ditemukan:', order_id);
    return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  }

  // 4. Cegah double-processing
  if (trx.status === 'paid') {
    console.log('Duplikat webhook, sudah diproses:', order_id);
    return res.status(200).json({ message: 'Sudah diproses sebelumnya' });
  }

  // 5. Update status transaksi
  await supabase
    .from('transactions')
    .update({ status: 'paid', payment_type, paid_at: new Date().toISOString(), raw_payload: payload })
    .eq('order_id', order_id);

  // 6. Generate lisensi
  const appId = 'CERTGEN';
  const secret = process.env.LICENSE_SECRET;
  const packageType = PAKET_TYPE_MAP[trx.paket] || 'lifetime';
  const { license_code } = generateLicenseInternal(appId, secret, packageType, trx.customer_email);

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
    expired_at: null,  // diisi oleh activate-license.js saat aktivasi
    email_sent: false,
    wa_sent: false,
  }]);

  if (licErr) {
    console.error('Gagal insert license:', licErr);
    return res.status(500).json({ error: 'Gagal generate lisensi' });
  }

  // 7. Kirim Email via Brevo
  let emailSent = false;
  try {
    await sendEmailBrevo({
      toEmail: trx.customer_email,
      toName: trx.customer_name,
      licenseKey: license_code,
      paketName: trx.paket,
      downloadLink: process.env.APP_DOWNLOAD_LINK,
      downloadMirror: process.env.APP_DOWNLOAD_LINK_MIRROR,
      supportWa: process.env.SUPPORT_WA,
    });
    emailSent = true;
  } catch (e) {
    console.error('Email gagal:', e.message);
  }

  // 8. Kirim WA via Fonnte
  let waSent = false;
  try {
    await sendWAFonnte({
      waNumber: trx.customer_wa,
      name: trx.customer_name,
      licenseKey: license_code,
      paketName: trx.paket,
      downloadLink: process.env.APP_DOWNLOAD_LINK,
      supportWa: process.env.SUPPORT_WA,
    });
    waSent = true;
  } catch (e) {
    console.error('WA gagal:', e.message);
  }

  // 9. Update status email_sent & wa_sent
  await supabase
    .from('licenses')
    .update({ email_sent: emailSent, wa_sent: waSent })
    .eq('license_key', license_code);

  console.log(`✅ Webhook OK: ${order_id} | Key: ${license_code} | Email: ${emailSent} | WA: ${waSent}`);
  return res.status(200).json({
    success: true,
    order_id,
    license_key: license_code,
    email_sent: emailSent,
    wa_sent: waSent,
  });
};
