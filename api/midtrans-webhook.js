// api/midtrans-webhook.js
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseNode } = require('./license-helper');

// --- ENVIRONMENT VARIABLES ---
const MIDTRANS_SERVER_KEY  = process.env.MIDTRANS_SERVER_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BREVO_API_KEY        = process.env.BREVO_API_KEY;
const FONNTE_TOKEN         = process.env.FONNTE_TOKEN;
const APP_DOWNLOAD_LINK    = process.env.APP_DOWNLOAD_LINK || "https://link-download-app-anda.com";
const SUPPORT_WA           = process.env.SUPPORT_WA || "08123456789";
const LICENSE_SECRET       = process.env.LICENSE_SECRET;
const APP_ID               = "CERTGEN";
const BREVO_SENDER_EMAIL   = process.env.BREVO_SENDER_EMAIL || "email@imaginestudio.online";
const BREVO_SENDER_NAME    = "CertGen Pro";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PAKET_TO_DURATION = {
  'paket harian':   '1D',
  'paket bulanan':  '30D',
  'paket tahunan':  '365D',
  'paket lifetime': 'LIFETIME'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    const payload = req.body;
    const rawString = `${payload.order_id}${payload.status_code}${payload.gross_amount}${MIDTRANS_SERVER_KEY}`;
    const hash = crypto.createHash('sha512').update(rawString).digest('hex');

    if (hash !== payload.signature_key) return res.status(401).json({ message: 'Invalid signature' });

    const status  = payload.transaction_status;
    const orderId = payload.order_id;

    if (status !== 'settlement' && status !== 'capture') {
      await supabase.from('transactions').update({ status: status }).eq('order_id', orderId);
      return res.status(200).json({ message: 'Status updated' });
    }

    const { data: existingTx } = await supabase.from('transactions').select('status').eq('order_id', orderId).single();
    if (existingTx && existingTx.status === 'paid') return res.status(200).json({ message: 'Already processed' });

    const customerName  = payload.custom_field1 || "Pelanggan";
    const customerEmail = payload.custom_field2 || "";
    let customerWA = "";
    let paketRaw   = "paket bulanan";
    let customerCity = ""; // ✅ Variable kota

    try {
      const field3 = JSON.parse(payload.custom_field3 || '{}');
      customerWA   = field3.wa    || "";
      paketRaw     = field3.paket || "paket bulanan";
      customerCity = field3.kota  || ""; // ✅ Ekstrak kota
    } catch (e) {
      console.error("⚠️ Gagal parse custom_field3:", payload.custom_field3);
    }

    const durationTag = PAKET_TO_DURATION[paketRaw.toLowerCase().trim()] || '30D';
    const tokenDays = 3;
    const licenseData = generateLicenseNode(APP_ID, LICENSE_SECRET, durationTag, customerEmail, tokenDays);
    const licenseKey  = licenseData.license_code;

    await supabase.from('customers').upsert({ email: customerEmail, name: customerName, whatsapp: customerWA }, { onConflict: 'email' });

    // ✅ Update ke tabel transactions ditambah customer_city
    const { error: txError } = await supabase.from('transactions')
      .update({
        status:         'paid',
        customer_email: customerEmail,
        customer_name:  customerName,
        customer_wa:    customerWA,
        customer_city:  customerCity, 
        payment_type:   payload.payment_type,
        paid_at:        new Date().toISOString(),
        raw_payload:    payload
      })
      .eq('order_id', orderId);

    const { error: licenseError } = await supabase.from('licenses').insert({
      order_id: orderId, license_key: licenseKey, package_name: paketRaw,
      app_id: APP_ID, expired_at: new Date(licenseData.license_expires * 1000).toISOString(),
      email_sent: false, wa_sent: false
    });

    // ✅ Notifikasi error DB ke Admin (Lisensi pembeli tetap dikirim)
    if (txError || licenseError) {
      console.error('❌ Gagal DB:', txError || licenseError);
      try {
        await axios.post('https://api.fonnte.com/send', {
          target: SUPPORT_WA,
          message: `🚨 *DB ERROR*\nLisensi terkirim ke pembeli, tapi gagal masuk Supabase.\nOrder: ${orderId}\nEmail: ${customerEmail}\nWA: ${customerWA}\nKey: ${licenseKey}`,
          countryCode: "62"
        }, { headers: { 'Authorization': FONNTE_TOKEN } });
      } catch(e) {}
    }

    let emailSent = false;
    if (customerEmail) {
      try {
        const emailHtml = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;"><h2>🎉 License Key CertGen Pro Anda Sudah Siap!</h2><p>Halo <b>${customerName}</b>,</p><p>Terima kasih telah melakukan pembelian. Berikut adalah detail lisensi Anda:</p><div style="background-color: #f4f4f4; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;"><p style="margin: 0; font-size: 14px; color: #555;">KODE LISENSI ANDA:</p><h3 style="margin: 10px 0; font-family: monospace; font-size: 20px; color: #d32f2f;">${licenseKey}</h3><p style="margin: 0; font-size: 12px; color: #d32f2f;">*Segera aktifkan dalam ${tokenDays} hari agar kode tidak hangus!</p></div><p><b>Paket:</b> ${paketRaw}</p><h3>Langkah Aktivasi:</h3><ol><li>Download aplikasi: <a href="${APP_DOWNLOAD_LINK}">Klik di sini</a></li><li>Buka aplikasi CertGen Pro</li><li>Klik menu <b>Aktivasi Lisensi</b></li><li>Paste kode lisensi di atas, lalu klik <b>Aktifkan</b></li></ol><p>Butuh bantuan? Silakan balas email ini atau hubungi WA kami: ${SUPPORT_WA}</p><hr><p style="font-size: 12px; color: #888; text-align: center;">© ImagineStudio</p></div>`;
        await axios.post('https://api.brevo.com/v3/smtp/email', {
          sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
          to: [{ email: customerEmail, name: customerName }],
          subject: "🎉 License Key CertGen Pro Anda Sudah Siap!",
          htmlContent: emailHtml
        }, { headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' } });
        emailSent = true;
      } catch (err) { console.error(`❌ Gagal email ke ${customerEmail}`); }
    }

    let waSent = false;
    if (customerWA) {
      try {
        const waMessage = `Halo ${customerName}! 🎉\n\nLicense Key CertGen Pro Anda:\n*${licenseKey}*\n\nPaket: ${paketRaw}\n_PENTING: Segera aktifkan kode ini dalam ${tokenDays} hari di aplikasi._\n\nCara aktivasi:\n1. Buka CertGen Pro\n2. Klik Aktivasi Lisensi\n3. Paste key di atas → Aktif!\n\nLink Download App:\n${APP_DOWNLOAD_LINK}\n\nButuh bantuan? Balas pesan ini. Terima kasih! 🙏`;
        await axios.post('https://api.fonnte.com/send', { target: customerWA, message: waMessage, countryCode: "62" }, { headers: { 'Authorization': FONNTE_TOKEN } });
        waSent = true;
      } catch (err) { console.error(`❌ Gagal WA ke ${customerWA}`); }
    }

    await supabase.from('licenses').update({ email_sent: emailSent, wa_sent: waSent }).eq('order_id', orderId);
    return res.status(200).json({ message: 'Success process webhook' });

  } catch (error) {
    console.error("🔥 ERROR SISTEM:", error);
    return res.status(200).json({ message: 'Error processing webhook' });
  }
};