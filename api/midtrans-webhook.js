// api/midtrans-webhook.js
// Menerima notifikasi settlement dari Midtrans
// Flow: verifikasi HMAC → update transaksi → generate lisensi → kirim email (Brevo) + WA (Fonnte)

const crypto                           = require('crypto');
const axios                            = require('axios');
const { createClient }                 = require('@supabase/supabase-js');
const { generateLicenseInternal }      = require('./generate-license');

// ============================================================
// Verifikasi Midtrans signature
// signature_key = SHA512(order_id + status_code + gross_amount + server_key)
// ============================================================
function verifySignature(orderId, statusCode, grossAmount, serverKey, receivedSig) {
  const raw  = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const hash = crypto.createHash('sha512').update(raw).digest('hex');
  return hash === receivedSig;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  console.log('[webhook] Received:', JSON.stringify({
    order_id:           body.order_id,
    transaction_status: body.transaction_status,
    fraud_status:       body.fraud_status,
    payment_type:       body.payment_type,
  }));

  // ── Verifikasi signature ───────────────────────────────────
  const isValid = verifySignature(
    body.order_id,
    body.status_code,
    body.gross_amount,
    process.env.MIDTRANS_SERVER_KEY,
    body.signature_key
  );

  if (!isValid) {
    console.error('[webhook] Signature verification FAILED:', body.order_id);
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  // ── Hanya proses jika settlement / capture ─────────────────
  const txStatus    = body.transaction_status;
  const fraudStatus = body.fraud_status;

  const isSettled = (
    txStatus === 'settlement' ||
    (txStatus === 'capture' && fraudStatus === 'accept')
  );

  if (!isSettled) {
    console.log(`[webhook] Skipping status: ${txStatus} / fraud: ${fraudStatus}`);
    return res.status(200).json({ message: `Status ${txStatus} — tidak diproses.` });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Cek apakah sudah pernah diproses (idempotency) ─────────
  const { data: txRow } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', body.order_id)
    .single();

  if (!txRow) {
    console.error('[webhook] Transaksi tidak ditemukan:', body.order_id);
    return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
  }

  if (txRow.status === 'paid') {
    console.log('[webhook] Sudah diproses sebelumnya:', body.order_id);
    return res.status(200).json({ message: 'Already processed.' });
  }

  // ── Update status transaksi → paid ─────────────────────────
  const { error: updateErr } = await supabase
    .from('transactions')
    .update({
      status:       'paid',
      payment_type: body.payment_type,
      paid_at:      body.settlement_time || new Date().toISOString(),
      raw_payload:  body,
    })
    .eq('order_id', body.order_id);

  if (updateErr) {
    console.error('[webhook] Update transaksi gagal:', updateErr);
    return res.status(500).json({ error: 'Gagal update transaksi.' });
  }

  // ── Ambil package_type dari custom_field atau raw_payload ──
  const packageType = body.custom_field1
    || txRow.raw_payload?.package_type
    || 'monthly';

  const packageNames = {
    daily:    'Paket Harian',
    monthly:  'Paket Bulanan',
    yearly:   'Paket Tahunan',
    lifetime: 'Paket Lifetime',
  };

  // ── Generate License Key ───────────────────────────────────
  // Cek dulu apakah sudah ada lisensi (race condition guard)
  const { data: existingLic } = await supabase
    .from('licenses')
    .select('license_key')
    .eq('order_id', body.order_id)
    .single();

  let licenseKey;

  if (existingLic) {
    licenseKey = existingLic.license_key;
    console.log('[webhook] Lisensi sudah ada:', licenseKey);
  } else {
    const { license_code } = generateLicenseInternal(
      'CERTGEN',
      process.env.LICENSE_SECRET,
      packageType,
      txRow.customer_email
    );
    licenseKey = license_code;

    const { error: licErr } = await supabase.from('licenses').insert({
      license_key:  licenseKey,
      order_id:     body.order_id,
      buyer_email:  txRow.customer_email,
      package_type: packageType,
      package_name: packageNames[packageType] || packageType,
      app_id:       'CERTGEN',
      status:       'active',
      // expired_at: NULL — diisi saat user aktivasi di desktop app
    });

    if (licErr) {
      console.error('[webhook] Insert lisensi gagal:', licErr);
      // Tetap lanjut kirim email/WA jika bisa
    } else {
      // Log event
      await supabase.from('license_events').insert({
        license_key: licenseKey,
        event_type:  'generated',
        note:        `Generated via webhook. Order: ${body.order_id}`,
      });
      console.log('[webhook] Lisensi digenerate:', licenseKey);
    }
  }

  // ── Nomor WA pembeli ───────────────────────────────────────
  const buyerWA = body.custom_field3
    || txRow.customer_wa
    || '';

  const downloadLink       = process.env.APP_DOWNLOAD_LINK       || '#';
  const downloadLinkMirror = process.env.APP_DOWNLOAD_LINK_MIRROR || '#';
  const supportWA          = process.env.SUPPORT_WA               || '6281234567890';
  const buyerName          = txRow.customer_name || 'Pelanggan';
  const pkgLabel           = packageNames[packageType] || packageType;

  // ── Kirim Email via Brevo ──────────────────────────────────
  let emailSent = false;
  try {
    await sendBrevoEmail({
      buyerName,
      buyerEmail:   txRow.customer_email,
      licenseKey,
      pkgLabel,
      orderId:      body.order_id,
      downloadLink,
      downloadLinkMirror,
      supportWA,
    });
    emailSent = true;
    console.log('[webhook] Email terkirim ke:', txRow.customer_email);
  } catch (err) {
    console.error('[webhook] Email gagal:', err.message);
  }

  // ── Kirim WhatsApp via Fonnte ──────────────────────────────
  let waSent = false;
  if (buyerWA) {
    try {
      await sendFonnteWA({
        phone: buyerWA,
        buyerName,
        licenseKey,
        pkgLabel,
        orderId:      body.order_id,
        downloadLink,
        downloadLinkMirror,
        supportWA,
      });
      waSent = true;
      console.log('[webhook] WA terkirim ke:', buyerWA);
    } catch (err) {
      console.error('[webhook] WA gagal:', err.message);
    }
  }

  // ── Update flag email_sent / wa_sent di tabel licenses ────
  await supabase
    .from('licenses')
    .update({ email_sent: emailSent, wa_sent: waSent })
    .eq('license_key', licenseKey);

  // ── Update social_proof ────────────────────────────────────
  await supabase.from('social_proof').insert({
    customer_name: buyerName,
    customer_city: txRow.customer_city || 'Indonesia',
    paket:         pkgLabel,
    order_id:      body.order_id,
    verified:      true,
  }).then(() => {}).catch(() => {});

  console.log('[webhook] Selesai:', body.order_id, '| email:', emailSent, '| wa:', waSent);
  return res.status(200).json({ success: true, license_key: licenseKey, email_sent: emailSent, wa_sent: waSent });
};

// ============================================================
// HELPER: Kirim email via Brevo (API v3)
// ============================================================
async function sendBrevoEmail({ buyerName, buyerEmail, licenseKey, pkgLabel, orderId, downloadLink, downloadLinkMirror, supportWA }) {
  const html = `
  <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;">
    <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
      <div style="background:linear-gradient(135deg,#0B1D3A,#1E56AE);padding:28px 32px;text-align:center;">
        <div style="color:white;font-size:1.4rem;font-weight:800;letter-spacing:-0.03em;">CertGen <span style="background:rgba(255,255,255,0.2);padding:2px 8px;border-radius:6px;font-size:0.7rem;vertical-align:middle;">PRO</span></div>
        <div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:6px;">Lisensi Anda Sudah Siap 🎉</div>
      </div>
      <div style="padding:28px 32px;">
        <p style="font-size:1rem;color:#1E293B;margin-bottom:0.5rem;">Halo, <strong>${buyerName}</strong>!</p>
        <p style="font-size:0.9rem;color:#475569;line-height:1.7;">Terima kasih telah membeli <strong>CertGen PRO ${pkgLabel}</strong>. Berikut adalah License Key dan panduan aktivasi Anda.</p>

        <div style="background:#EFF6FF;border:2px dashed #3B82F6;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#1E56AE;margin-bottom:8px;">🔑 LICENSE KEY ANDA</div>
          <div style="font-family:monospace;font-size:1.4rem;font-weight:800;color:#1A4080;letter-spacing:0.12em;">${licenseKey}</div>
          <div style="font-size:0.75rem;color:#64748B;margin-top:8px;">Simpan key ini dengan aman. Jangan bagikan ke siapapun.</div>
        </div>

        <div style="background:#F8FAFC;border-radius:8px;padding:16px;margin-bottom:20px;">
          <div style="font-size:0.8rem;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">📦 Detail Pesanan</div>
          <table style="width:100%;font-size:0.85rem;color:#334155;">
            <tr><td style="padding:4px 0;color:#64748B;">Order ID</td><td style="font-weight:600;">${orderId}</td></tr>
            <tr><td style="padding:4px 0;color:#64748B;">Paket</td><td style="font-weight:600;">${pkgLabel}</td></tr>
            <tr><td style="padding:4px 0;color:#64748B;">Status</td><td style="color:#10B981;font-weight:700;">✓ Aktif</td></tr>
          </table>
        </div>

        <div style="margin-bottom:20px;">
          <div style="font-size:0.8rem;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px;">📥 Download Aplikasi</div>
          <a href="${downloadLink}" style="display:block;background:#1E56AE;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;font-size:0.9rem;text-align:center;margin-bottom:8px;">⬇️ Download CertGen PRO (Link Utama)</a>
          <a href="${downloadLinkMirror}" style="display:block;background:#F1F5F9;color:#334155;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:0.875rem;text-align:center;">🔗 Mirror Download</a>
        </div>

        <div style="background:#0B1D3A;border-radius:10px;padding:20px;color:white;margin-bottom:20px;">
          <div style="font-size:0.85rem;font-weight:700;margin-bottom:12px;">📋 Cara Aktivasi</div>
          <ol style="padding-left:18px;margin:0;font-size:0.85rem;color:rgba(255,255,255,0.85);line-height:2;">
            <li>Download dan install CertGen PRO</li>
            <li>Buka aplikasi → klik "Aktivasi Lisensi"</li>
            <li>Masukkan License Key di atas</li>
            <li>Klik "Aktifkan" — selesai! Aplikasi siap digunakan</li>
          </ol>
        </div>

        <p style="font-size:0.875rem;color:#475569;">Butuh bantuan? Hubungi support kami di WhatsApp: <a href="https://wa.me/${supportWA}" style="color:#1E56AE;font-weight:700;">wa.me/${supportWA}</a></p>
      </div>
      <div style="background:#F8FAFC;padding:16px 32px;text-align:center;font-size:0.78rem;color:#94A3B8;border-top:1px solid #E2E8F0;">
        © 2024 ImagineStudio · CertGen PRO · support@imaginestudio.id
      </div>
    </div>
  </body></html>
  `;

  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender:     { name: 'CertGen PRO', email: process.env.BREVO_SENDER_EMAIL },
    to:         [{ email: buyerEmail, name: buyerName }],
    subject:    `🔑 License Key CertGen PRO Anda — ${pkgLabel}`,
    htmlContent: html,
  }, {
    headers: {
      'api-key':      process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
  });
}

// ============================================================
// HELPER: Kirim WhatsApp via Fonnte
// ============================================================
async function sendFonnteWA({ phone, buyerName, licenseKey, pkgLabel, orderId, downloadLink, downloadLinkMirror, supportWA }) {
  const message = `✅ *Pembayaran CertGen PRO Berhasil!*

Halo ${buyerName}! 🎉

Terima kasih telah membeli *CertGen PRO ${pkgLabel}*.

🔑 *License Key Anda:*
\`${licenseKey}\`

📦 *Order ID:* ${orderId}

📥 *Download Aplikasi:*
Link Utama: ${downloadLink}
Mirror: ${downloadLinkMirror}

📋 *Cara Aktivasi:*
1. Download & install CertGen PRO
2. Buka app → klik "Aktivasi Lisensi"
3. Masukkan License Key di atas
4. Klik "Aktifkan" → siap pakai!

💬 Butuh bantuan? Chat support kami:
wa.me/${supportWA}

_Simpan License Key ini dengan aman ya!_ 🔐

— Tim CertGen PRO / ImagineStudio`;

  await axios.post('https://api.fonnte.com/send', {
    target:  phone,
    message,
    delay:   1,
  }, {
    headers: {
      Authorization: process.env.FONNTE_TOKEN,
      'Content-Type': 'application/json',
    },
  });
}
