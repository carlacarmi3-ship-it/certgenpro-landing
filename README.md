# CertGen PRO — Panduan Deploy Lengkap (v3 Monorepo)

> Satu GitHub repository · Satu Vercel project · Satu domain untuk landing page + seluruh API

---

## 📋 Daftar Isi

1. [Prasyarat & Akun yang Dibutuhkan](#1-prasyarat)
2. [Setup Database Supabase](#2-setup-supabase)
3. [Setup Repository GitHub](#3-setup-github)
4. [Deploy ke Vercel](#4-deploy-vercel)
5. [Konfigurasi Midtrans](#5-konfigurasi-midtrans)
6. [Konfigurasi Brevo (Email)](#6-konfigurasi-brevo)
7. [Konfigurasi Fonnte (WhatsApp)](#7-konfigurasi-fonnte)
8. [Environment Variables Lengkap](#8-environment-variables)
9. [Testing End-to-End](#9-testing)
10. [Checklist Go-Live](#10-go-live)
11. [Operasional & Monitoring](#11-monitoring)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prasyarat

| Layanan | Tier | Link |
|---|---|---|
| GitHub | Free | https://github.com |
| Vercel | Free | https://vercel.com |
| Supabase | Free | https://supabase.com |
| Midtrans | Sandbox/Production | https://midtrans.com |
| Brevo | Free (300 email/hari) | https://brevo.com |
| Fonnte | Berbayar per pesan | https://fonnte.com |

---

## 2. Setup Database Supabase

### Langkah-langkah:

```
1. Buka https://supabase.com → New Project
2. Isi: Project Name = certgenpro, Region = Southeast Asia (Singapore)
3. Catat Project URL dan Service Role Key
   → Settings → API → Project URL + service_role key
4. Buka SQL Editor → paste seluruh isi file supabase-schema.sql → Run
5. Verifikasi: Table Editor → pastikan 8 tabel terbuat
6. Verifikasi: Database → Functions → cek fungsi check_and_expire_licenses
```

### Catat ke tempat aman:
```
SUPABASE_URL      = https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6...
```

> ⚠️ **PENTING:** Jangan gunakan anon key untuk API. Gunakan **service_role key**.

---

## 3. Setup Repository GitHub

```bash
# Buat repo baru di github.com → New Repository
# Nama: certgenpro (private)

# Clone ke lokal
git clone https://github.com/USERNAME/certgenpro.git
cd certgenpro

# Copy semua file project (dari folder yang diberikan):
# - public/index.html
# - public/thank-you.html
# - public/renew.html
# - public/payment-status.html
# - public/terms.html
# - api/create-payment.js
# - api/generate-license.js
# - api/midtrans-webhook.js
# - api/activate-license.js
# - api/check-license.js
# - api/check-order.js
# - api/get-recent-sales.js
# - api/admin-recovery.js
# - api/time.js
# - api/keep-alive.js
# - package.json
# - vercel.json

# Install dependencies
npm install

# Commit dan push
git add .
git commit -m "feat: CertGen PRO v3 monorepo — initial setup"
git push origin main
```

---

## 4. Deploy ke Vercel

```
1. Buka https://vercel.com → New Project
2. Import GitHub repo: certgenpro
3. WAJIB: Framework Preset → pilih "Other" (BUKAN Next.js!)
4. Root Directory: . (biarkan kosong/titik)
5. Build Command: (kosongkan)
6. Output Directory: (kosongkan)
7. Environment Variables: isi semua dari tabel di bagian 8
8. Klik Deploy
9. Tunggu ~1 menit → catat URL: https://certgenpro.vercel.app
```

### Verifikasi Routing:
```
✓ https://certgenpro.vercel.app/               → index.html (200)
✓ https://certgenpro.vercel.app/thank-you.html  → thank-you.html (200)
✓ https://certgenpro.vercel.app/renew.html       → renew.html (200)
✓ https://certgenpro.vercel.app/terms.html        → terms.html (200)
✓ https://certgenpro.vercel.app/api/time          → JSON (200)
✓ https://certgenpro.vercel.app/api/get-recent-sales → JSON array (200)
```

---

## 5. Konfigurasi Midtrans

### Sandbox (Testing):
```
1. Login https://sandbox.midtrans.com
2. Settings → Access Keys → catat:
   - Server Key: SB-Mid-server-XXXX
   - Client Key: SB-Mid-client-XXXX
3. Settings → Configuration:
   - Payment Notification URL: https://certgenpro.vercel.app/api/midtrans-webhook
   - Finish Redirect URL: https://certgenpro.vercel.app/thank-you.html
   - Error Redirect URL: https://certgenpro.vercel.app/payment-status.html
   - Unfinish Redirect URL: https://certgenpro.vercel.app/payment-status.html
```

### Update Client Key di HTML:
Buka `public/index.html` dan `public/renew.html`, ganti:
```html
<!-- SANDBOX -->
<script src="https://app.sandbox.midtrans.com/snap/snap.js"
        data-client-key="SB-Mid-client-XXXX"></script>

<!-- PRODUCTION (ganti saat go-live) -->
<script src="https://app.midtrans.com/snap/snap.js"
        data-client-key="Mid-client-XXXX"></script>
```

### Production (Saat Go-Live):
```
1. Login https://dashboard.midtrans.com
2. Settings → Configuration → Payment Notification URL:
   https://certgenpro.vercel.app/api/midtrans-webhook
3. Ubah MIDTRANS_IS_PRODUCTION=true di Vercel env
4. Ganti Snap script ke URL production + client key production
```

---

## 6. Konfigurasi Brevo (Email)

```
1. Daftar https://brevo.com → Free plan (300 email/hari)
2. My Account → SMTP & API → API Keys → Generate New API Key
   Catat: BREVO_API_KEY = xkeysib-XXXX
3. Senders & IP → Add a Sender
   → Email: no-reply@domain-anda.com atau email terverifikasi
   → Verifikasi kepemilikan email/domain
   Catat: BREVO_SENDER_EMAIL = no-reply@domain-anda.com
4. (Opsional) Setup DKIM di domain untuk deliverability lebih baik
```

---

## 7. Konfigurasi Fonnte (WhatsApp)

```
1. Daftar https://fonnte.com
2. Add Device → scan QR dengan WhatsApp aktif Anda
3. Device Settings → catat Token
   Catat: FONNTE_TOKEN = xxx
4. Nomor WA support (untuk footer pesan):
   Catat: SUPPORT_WA = 6281234567890 (format 62xxx, tanpa +)
```

> ⚠️ Fonnte menggunakan nomor WA pribadi sebagai pengirim. Pastikan nomor tidak dipakai aktif bercakap-cakap agar tidak kena ban WhatsApp.

---

## 8. Environment Variables

Isi semua ini di **Vercel → Project Settings → Environment Variables**:

| Variable | Contoh Nilai | Keterangan |
|---|---|---|
| `SUPABASE_URL` | `https://xxx.supabase.co` | Project URL Supabase |
| `SUPABASE_SERVICE_KEY` | `eyJ...` | Service Role Key Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Sama dengan di atas (alias) |
| `MIDTRANS_SERVER_KEY` | `SB-Mid-server-XXX` | Server Key Midtrans |
| `MIDTRANS_CLIENT_KEY` | `SB-Mid-client-XXX` | Client Key Midtrans |
| `MIDTRANS_IS_PRODUCTION` | `false` | `true` saat go-live |
| `BREVO_API_KEY` | `xkeysib-XXX` | API Key Brevo |
| `BREVO_SENDER_EMAIL` | `noreply@domain.com` | Email terverifikasi Brevo |
| `FONNTE_TOKEN` | `xxx` | Token Fonnte |
| `APP_DOWNLOAD_LINK` | `https://drive.google.com/...` | Link download installer utama |
| `APP_DOWNLOAD_LINK_MIRROR` | `https://mediafire.com/...` | Link download mirror |
| `APP_BASE_URL` | `https://certgenpro.vercel.app` | Base URL Vercel (tanpa trailing slash) |
| `SUPPORT_WA` | `6281234567890` | Nomor WA support (format 62xxx) |
| `LICENSE_SECRET` | `(string 32 char random)` | **JANGAN PERNAH GANTI** setelah production |
| `ADMIN_SECRET` | `(string random aman)` | Password untuk /api/admin-recovery |
| `CRON_SECRET` | `(string random)` | Secret untuk cron keep-alive |

### Generate string rahasia:
```bash
# Di terminal (Linux/Mac):
openssl rand -hex 32

# Atau via Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 9. Testing End-to-End

### Urutan Testing:

```
□ 1. Buka https://certgenpro.vercel.app/ → landing page tampil sempurna
□ 2. Social proof feed muncul (atau tidak ada error di console)
□ 3. Klik "Beli Sekarang" → modal form muncul
□ 4. Isi form → klik Lanjut → Midtrans Snap popup terbuka
□ 5. Bayar menggunakan akun sandbox Midtrans:
      - BCA Virtual Account: 12345678901234
      - GoPay: buka Midtrans Simulator di sandbox dashboard
□ 6. Setelah bayar → redirect ke /thank-you.html
□ 7. Cek email → license key diterima (cek spam jika tidak ada)
□ 8. Cek WhatsApp → pesan lisensi diterima
□ 9. Buka Supabase Table Editor:
      - transactions: status = 'paid' ✓
      - licenses: ada entry baru, device_id = NULL ✓
      - social_proof: ada entry baru ✓
□ 10. Test halaman Renew → input license key dari step 9
□ 11. Download desktop app → input license key → aktivasi berhasil
□ 12. Supabase licenses: device_id terisi, expired_at terisi ✓
□ 13. Coba aktivasi key sama di device berbeda → DITOLAK ✓
□ 14. Test /api/admin-recovery:
       POST https://certgenpro.vercel.app/api/admin-recovery
       Body: {"admin_secret":"ISI_ADMIN_SECRET","order_id":"CGP-xxx"}
□ 15. Cek recovery_log di Supabase ✓
```

### Test Midtrans Sandbox:
- Sandbox dashboard: https://simulator.sandbox.midtrans.com/
- Test card: 4811 1111 1111 1114 (CVV: 123, Expiry: 01/39)

---

## 10. Checklist Go-Live

```
□ Ubah MIDTRANS_IS_PRODUCTION=true di Vercel env
□ Ganti Snap script di index.html & renew.html ke URL production
□ Ganti data-client-key ke Production client key
□ Update Notification URL di Midtrans dashboard Production
□ Test pembayaran nyata (Rp 1.000 minimum)
□ Verifikasi webhook Production berjalan (cek Midtrans log)
□ Setup custom domain di Vercel Settings → Domains (opsional)
□ Aktifkan Vercel Analytics (gratis)
□ Simpan semua credential di password manager
□ Bookmark SQL monitoring di Supabase SQL Editor
□ Screenshot semua halaman untuk dokumentasi
□ Test halaman terms.html → pastikan kontak support benar
□ Update nomor WA support di terms.html dan footer
```

---

## 11. Operasional & Monitoring

### Query SQL Harian:

```sql
-- Penjualan hari ini
SELECT paket, COUNT(*) total, SUM(amount) revenue
FROM transactions
WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE
GROUP BY paket;

-- Lisensi aktif
SELECT package_type, COUNT(*) total
FROM licenses WHERE status = 'active'
GROUP BY package_type;

-- Anomali: paid tapi lisensi tidak ada
SELECT t.order_id, t.customer_email, t.paid_at
FROM transactions t
LEFT JOIN licenses l ON t.order_id = l.order_id
WHERE t.status = 'paid' AND l.id IS NULL;

-- Email/WA gagal terkirim
SELECT l.license_key, l.order_id, l.email_sent, l.wa_sent,
       t.customer_email, t.customer_wa
FROM licenses l JOIN transactions t ON l.order_id = t.order_id
WHERE l.email_sent = false OR l.wa_sent = false;
```

### Recovery Lisensi Gagal:

```bash
curl -X POST https://certgenpro.vercel.app/api/admin-recovery \
  -H "Content-Type: application/json" \
  -d '{"admin_secret":"ISI_ADMIN_SECRET","order_id":"CGP-xxx"}'
```

### Revoke Lisensi:

```sql
UPDATE licenses SET status = 'revoked'
WHERE license_key = 'CERTGEN-XXXX-XXXX-XXXX';
```

---

## 12. Troubleshooting

| Masalah | Solusi |
|---|---|
| Webhook tidak dipanggil Midtrans | Cek Notification URL di Midtrans dashboard. Pastikan endpoint dapat diakses publik. |
| Email tidak terkirim | Cek BREVO_API_KEY dan BREVO_SENDER_EMAIL. Pastikan sender sudah diverifikasi di Brevo. |
| WA tidak terkirim | Cek FONNTE_TOKEN. Pastikan device Fonnte masih online (scan ulang jika perlu). |
| Lisensi tidak generate | Cek log di Vercel (Functions → Logs). Cek query anomali di Supabase. Jalankan admin-recovery. |
| Supabase auto-pause | Keep-alive cron berjalan setiap 3 hari. Jika paused, buka Supabase dashboard untuk resume. |
| Framework preset salah | Di Vercel project settings, pastikan Framework = **Other**, bukan Next.js. Redeploy. |
| CORS error | Tidak diperlukan di v3 (monorepo). Jika muncul, pastikan API_URL = '' di file HTML. |
| `midtrans-client` not found | Jalankan `npm install` di root, push ke GitHub, redeploy Vercel. |

---

## Struktur Folder Final

```
certgenpro/
├── public/
│   ├── index.html           ← Landing page utama
│   ├── thank-you.html       ← Halaman sukses bayar
│   ├── renew.html           ← Perpanjang lisensi
│   ├── payment-status.html  ← Pending/gagal bayar
│   └── terms.html           ← Syarat & Ketentuan
├── api/
│   ├── create-payment.js    ← Midtrans Snap token
│   ├── generate-license.js  ← Generate key (+ export internal)
│   ├── midtrans-webhook.js  ← Auto-process payment settlement
│   ├── activate-license.js  ← Aktivasi + device binding
│   ├── check-license.js     ← Cek status lisensi (renew page)
│   ├── check-order.js       ← Polling status order (thank-you)
│   ├── get-recent-sales.js  ← Social proof data
│   ├── admin-recovery.js    ← Recovery lisensi manual
│   ├── time.js              ← Server time (anti clock manipulation)
│   └── keep-alive.js        ← Cron: expire + ping Supabase
├── supabase-schema.sql      ← SQL setup database
├── package.json
├── vercel.json              ← Cron config
└── README.md                ← Panduan ini
```

---

*CertGen PRO v3 — Monorepo Edition · ImagineStudio · 2024*
