// File: api/midtrans-webhook.js

const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseNode } = require('./license-helper');

// --- AMBIL ENVIRONMENT VARIABLES ---
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const APP_DOWNLOAD_LINK = process.env.APP_DOWNLOAD_LINK || "https://link-download-app-anda.com";
const SUPPORT_WA = process.env.SUPPORT_WA || "08123456789";
const LICENSE_SECRET = process.env.LICENSE_SECRET; // Harus SAMA PERSIS dengan yg di app Python Anda
const APP_ID = "CERTGEN_V1"; // Sesuaikan dengan APP_ID Anda

// Inisialisasi Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  // Wajib POST request
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    // --- LANGKAH 1: Verifikasi Keamanan Signature Midtrans ---
    const rawString = `${payload.order_id}${payload.status_code}${payload.gross_amount}${MIDTRANS_SERVER_KEY}`;
    const hash = crypto.createHash('sha512').update(rawString).digest('hex');

    if (hash !== payload.signature_key) {
      console.error("⛔ Signature tidak valid!");
      return res.status(401).json({ message: 'Invalid signature' });
    }

    // --- LANGKAH 2: Cek Status Transaksi ---
    const status = payload.transaction_status;
    const orderId = payload.order_id;
    
    if (status !== 'settlement' && status !== 'capture') {
      // Jika status pending/batal/kadaluarsa, update DB lalu kembalikan 200 (Stop proses)
      await supabase.from('transactions')
        .update({ status: status })
        .eq('order_id', orderId);
      return res.status(200).json({ message: 'Status updated' });
    }

    // --- LANGKAH 3: Cek Duplikat di Database ---
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('status')
      .eq('order_id', orderId)
      .single();

    if (existingTx && existingTx.status === 'paid') {
      console.log(`✅ Transaksi ${orderId} sudah pernah diproses.`);
      return res.status(200).json({ message: 'Already processed' });
    }

    // --- LANGKAH 4: Ekstrak Data Pembeli ---
    // Pastikan saat Frontend Anda melakukan pembayaran (create-payment), 
    // Anda mengisi item_details atau custom_fields di Snap payload
    const customerName = payload.custom_field1 || "Pelanggan"; // Asumsi custom_field1 = Nama
    const customerWA = payload.custom_field2 || ""; // Asumsi custom_field2 = No WA
    const durationTag = payload.custom_field3 || "30D"; // Asumsi custom_field3 = Paket (1D/30D/365D/LIFETIME)
    
    // Email biasanya ada di object customer_details
    const customerEmail = payload.customer_details?.email || `user-${Date.now()}@temp.com`; 

    // --- LANGKAH 5: Generate Lisensi ---
    console.log(`⚙️ Generating license untuk: ${customerEmail}, Paket: ${durationTag}`);
    const tokenDays = 3; // User diberi waktu 3 hari untuk aktivasi kodenya
    
    const licenseData = generateLicenseNode(APP_ID, LICENSE_SECRET, durationTag, tokenDays);
    const licenseKey = licenseData.license_code;

    // --- LANGKAH 6: Simpan ke Database (Supabase) ---
    // 6A. Upsert Customer
    await supabase.from('customers').upsert({
      email: customerEmail,
      name: customerName,
      whatsapp: customerWA
    });

    // 6B. Update Status Transaction
    await supabase.from('transactions').upsert({
      order_id: orderId,
      status: 'paid',
      gross_amount: parseFloat(payload.gross_amount),
      payment_type: payload.payment_type,
      customer_email: customerEmail
    });

    // 6C. Simpan Data Lisensi
    await supabase.from('licenses').insert({
      order_id: orderId,
      license_key: licenseKey,
      package_name: durationTag,
      app_id: APP_ID,
      expired_at: new Date(licenseData.license_expires * 1000).toISOString()
    });

    // --- LANGKAH 7: Kirim Email via Brevo ---
    let emailSent = false;
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
          <h2>🎉 License Key CertGen Pro Anda Sudah Siap!</h2>
          <p>Halo <b>${customerName}</b>,</p>
          <p>Terima kasih telah melakukan pembelian. Berikut adalah detail lisensi Anda:</p>
          
          <div style="background-color: #f4f4f4; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #555;">KODE LISENSI ANDA:</p>
            <h3 style="margin: 10px 0; font-family: monospace; font-size: 20px; color: #d32f2f;">${licenseKey}</h3>
            <p style="margin: 0; font-size: 12px; color: #d32f2f;">*Segera aktifkan dalam ${tokenDays} hari agar kode tidak hangus!</p>
          </div>

          <p><b>Paket:</b> ${durationTag}</p>
          
          <h3>Langkah Aktivasi:</h3>
          <ol>
            <li>Download aplikasi: <a href="${APP_DOWNLOAD_LINK}">Klik di sini</a></li>
            <li>Buka aplikasi CertGen Pro</li>
            <li>Klik menu <b>Aktivasi Lisensi</b></li>
            <li>Paste kode lisensi di atas, lalu klik <b>Aktifkan</b></li>
          </ol>

          <p>Butuh bantuan? Silakan balas email ini atau hubungi WA kami: ${SUPPORT_WA}</p>
          <hr>
          <p style="font-size: 12px; color: #888; text-align: center;">© ImagineStudio</p>
        </div>
      `;

      await axios.post('https://api.brevo.com/v3/smtp/email', {
        sender: { name: "CertGen Pro", email: "noreply@domainanda.com" }, // Ganti email ini
        to: [{ email: customerEmail, name: customerName }],
        subject: "🎉 License Key CertGen Pro Anda Sudah Siap!",
        htmlContent: emailHtml
      }, {
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      });
      emailSent = true;
      console.log(`📧 Email terkirim ke ${customerEmail}`);
    } catch (err) {
      console.error(`❌ Gagal kirim email:`, err.response?.data || err.message);
    }

    // --- LANGKAH 8: Kirim WA via Fonnte ---
    let waSent = false;
    if (customerWA) {
      try {
        const waMessage = `Halo ${customerName}! 🎉\n\nLicense Key CertGen Pro Anda:\n*${licenseKey}*\n\nPaket: ${durationTag}\n_PENTING: Segera aktifkan kode ini dalam ${tokenDays} hari di aplikasi._\n\nCara aktivasi:\n1. Buka CertGen Pro\n2. Klik Aktivasi Lisensi\n3. Paste key di atas → Aktif!\n\nLink Download App:\n${APP_DOWNLOAD_LINK}\n\nButuh bantuan? Balas pesan ini. Terima kasih! 🙏`;

        await axios.post('https://api.fonnte.com/send', {
          target: customerWA,
          message: waMessage,
          countryCode: "62"
        }, {
          headers: { 'Authorization': FONNTE_TOKEN }
        });
        waSent = true;
        console.log(`📱 WA terkirim ke ${customerWA}`);
      } catch (err) {
        console.error(`❌ Gagal kirim WA:`, err.response?.data || err.message);
      }
    }

    // --- LANGKAH 9: Update Status Notifikasi ---
    await supabase.from('licenses')
      .update({ email_sent: emailSent, wa_sent: waSent })
      .eq('order_id', orderId);

    // --- LANGKAH 10: Selesai ---
    // Harus selalu balas 200 OK ke Midtrans
    return res.status(200).json({ message: 'Success process webhook' });

  } catch (error) {
    console.error("🔥 ERROR SISTEM:", error);
    // Kita tetap kirim 200 ke Midtrans agar webhook tidak terus-menerus diulang jika error dari sisi code kita
    return res.status(200).json({ message: 'Error processing webhook, logged.' }); 
  }
}