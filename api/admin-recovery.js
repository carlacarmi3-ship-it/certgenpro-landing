// api/admin-recovery.js
// Recovery lisensi manual oleh admin
// POST /api/admin-recovery
// Body: { admin_secret, order_id }

const axios                          = require('axios');
const { createClient }               = require('@supabase/supabase-js');
const { generateLicenseInternal }    = require('./generate-license');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { admin_secret, order_id } = req.body;

  // ── Auth ──────────────────────────────────────────────────
  if (!admin_secret || admin_secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!order_id) {
    return res.status(400).json({ error: 'order_id diperlukan.' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Cari transaksi ────────────────────────────────────────
  const { data: tx, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (txErr || !tx) {
    return res.status(404).json({ error: `Transaksi ${order_id} tidak ditemukan.` });
  }

  if (tx.status !== 'paid') {
    return res.status(400).json({
      error: `Transaksi belum lunas. Status saat ini: ${tx.status}`,
      status: tx.status,
    });
  }

  // ── Cek apakah lisensi sudah ada ─────────────────────────
  const { data: existingLic } = await supabase
    .from('licenses')
    .select('*')
    .eq('order_id', order_id)
    .single();

  let licenseKey;
  let wasExisting = false;
  let emailSent   = false;
  let waSent      = false;

  if (existingLic) {
    licenseKey  = existingLic.license_key;
    wasExisting = true;
    emailSent   = existingLic.email_sent;
    waSent      = existingLic.wa_sent;
    console.log('[recovery] Lisensi sudah ada:', licenseKey);
  } else {
    // Generate lisensi baru
    const packageType = tx.raw_payload?.package_type || 'monthly';
    const packageNames = {
      daily: 'Paket Harian', monthly: 'Paket Bulanan',
      yearly: 'Paket Tahunan', lifetime: 'Paket Lifetime',
    };

    const { license_code } = generateLicenseInternal(
      'CERTGEN',
      process.env.LICENSE_SECRET,
      packageType,
      tx.customer_email
    );
    licenseKey = license_code;

    const { error: insErr } = await supabase.from('licenses').insert({
      license_key:  licenseKey,
      order_id,
      buyer_email:  tx.customer_email,
      package_type: packageType,
      package_name: packageNames[packageType] || packageType,
      app_id:       'CERTGEN',
      status:       'active',
    });

    if (insErr) {
      console.error('[recovery] Insert gagal:', insErr);
      return res.status(500).json({ error: 'Gagal generate lisensi baru.' });
    }

    console.log('[recovery] Lisensi baru digenerate:', licenseKey);
  }

  // ── Kirim ulang email & WA ────────────────────────────────
  const packageType = tx.raw_payload?.package_type || 'monthly';
  const packageNames = {
    daily: 'Paket Harian', monthly: 'Paket Bulanan',
    yearly: 'Paket Tahunan', lifetime: 'Paket Lifetime',
  };
  const pkgLabel       = packageNames[packageType] || packageType;
  const downloadLink   = process.env.APP_DOWNLOAD_LINK       || '#';
  const downloadMirror = process.env.APP_DOWNLOAD_LINK_MIRROR || '#';
  const supportWA      = process.env.SUPPORT_WA               || '6281234567890';

  // Email
  try {
    await sendBrevoEmail({
      buyerName:          tx.customer_name,
      buyerEmail:         tx.customer_email,
      licenseKey,
      pkgLabel,
      orderId:            order_id,
      downloadLink,
      downloadLinkMirror: downloadMirror,
      supportWA,
    });
    emailSent = true;
  } catch (e) {
    console.error('[recovery] Email gagal:', e.message);
  }

  // WhatsApp
  const buyerWA = tx.customer_wa || tx.raw_payload?.custom_field3 || '';
  if (buyerWA) {
    try {
      await sendFonnteWA({
        phone:              buyerWA,
        buyerName:          tx.customer_name,
        licenseKey,
        pkgLabel,
        orderId:            order_id,
        downloadLink,
        downloadLinkMirror: downloadMirror,
        supportWA,
      });
      waSent = true;
    } catch (e) {
      console.error('[recovery] WA gagal:', e.message);
    }
  }

  // Update flag
  await supabase
    .from('licenses')
    .update({ email_sent: emailSent, wa_sent: waSent })
    .eq('license_key', licenseKey);

  // Catat ke recovery_log
  await supabase.from('recovery_log').insert({
    order_id,
    customer_email: tx.customer_email,
    customer_wa:    buyerWA,
    original_key:   wasExisting ? licenseKey : null,
    new_key:        wasExisting ? null : licenseKey,
    reason:         'Admin manual recovery',
    resolved_by:    'admin',
  });

  return res.status(200).json({
    success:        true,
    license_key:    licenseKey,
    customer_email: tx.customer_email,
    customer_wa:    buyerWA,
    paket:          pkgLabel,
    was_existing:   wasExisting,
    email_sent:     emailSent,
    wa_sent:        waSent,
  });
};

// ── Email via Brevo ──────────────────────────────────────────
async function sendBrevoEmail({ buyerName, buyerEmail, licenseKey, pkgLabel, orderId, downloadLink, downloadLinkMirror, supportWA }) {
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender:     { name: 'CertGen PRO', email: process.env.BREVO_SENDER_EMAIL },
    to:         [{ email: buyerEmail, name: buyerName }],
    subject:    `[Recovery] 🔑 License Key CertGen PRO — ${pkgLabel}`,
    htmlContent: `<p>Halo <strong>${buyerName}</strong>,</p>
      <p>Berikut adalah License Key CertGen PRO Anda yang dikirim ulang oleh tim support:</p>
      <div style="background:#EFF6FF;border:2px dashed #3B82F6;padding:16px;text-align:center;border-radius:8px;margin:16px 0;">
        <strong style="font-size:1.3rem;font-family:monospace;letter-spacing:0.1em;">${licenseKey}</strong>
      </div>
      <p><strong>Order ID:</strong> ${orderId}<br><strong>Paket:</strong> ${pkgLabel}</p>
      <p><a href="${downloadLink}">⬇️ Download CertGen PRO</a> | <a href="${downloadLinkMirror}">Mirror</a></p>
      <p>Bantuan: wa.me/${supportWA}</p>`,
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
  });
}

// ── WhatsApp via Fonnte ───────────────────────────────────────
async function sendFonnteWA({ phone, buyerName, licenseKey, pkgLabel, orderId, downloadLink, downloadLinkMirror, supportWA }) {
  await axios.post('https://api.fonnte.com/send', {
    target: phone,
    message: `[Recovery] ✅ *CertGen PRO — License Key Anda*\n\nHalo ${buyerName}!\n\n🔑 *License Key:*\n\`${licenseKey}\`\n\n📦 Order: ${orderId}\nPaket: ${pkgLabel}\n\n📥 Download: ${downloadLink}\nMirror: ${downloadLinkMirror}\n\nBantuan: wa.me/${supportWA}`,
    delay: 1,
  }, {
    headers: { Authorization: process.env.FONNTE_TOKEN, 'Content-Type': 'application/json' },
  });
}
