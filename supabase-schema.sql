-- ============================================================
-- CERTGEN PRO — Supabase SQL Setup Script v3
-- Jalankan seluruh script ini sekali di Supabase SQL Editor
-- ============================================================

-- ============================================================
-- TABEL 1: customers (opsional — untuk CRM masa depan)
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email       TEXT        UNIQUE NOT NULL,
  name        TEXT,
  whatsapp    TEXT,
  city        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 2: transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        TEXT        UNIQUE NOT NULL,
  customer_name   TEXT,
  customer_email  TEXT        NOT NULL,
  customer_wa     TEXT,
  customer_city   TEXT,
  paket           TEXT        NOT NULL,
  amount          INTEGER     NOT NULL,
  status          TEXT        DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','failed','expired','refunded')),
  payment_type    TEXT,
  paid_at         TIMESTAMPTZ,
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 3: licenses
-- ============================================================
CREATE TABLE IF NOT EXISTS licenses (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  license_key   TEXT        UNIQUE NOT NULL,
  order_id      TEXT        REFERENCES transactions(order_id) ON DELETE SET NULL,
  buyer_email   TEXT        NOT NULL,
  package_type  TEXT        NOT NULL
                            CHECK (package_type IN ('daily','monthly','yearly','lifetime')),
  package_name  TEXT,
  app_id        TEXT        DEFAULT 'CERTGEN',
  device_id     TEXT,                      -- Diisi saat aktivasi (SHA-256 hardware fingerprint)
  status        TEXT        DEFAULT 'active'
                            CHECK (status IN ('active','expired','revoked')),
  activated_at  TIMESTAMPTZ,               -- Diisi saat aktivasi pertama
  expired_at    TIMESTAMPTZ,               -- NULL untuk lifetime
  email_sent    BOOLEAN     DEFAULT false,
  wa_sent       BOOLEAN     DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 4: license_events (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS license_events (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  license_key  TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,       -- activated|validated|expired|revoked|activation_failed|activation_blocked
  device_id    TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 5: recovery_log
-- ============================================================
CREATE TABLE IF NOT EXISTS recovery_log (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        TEXT        NOT NULL,
  customer_email  TEXT,
  customer_wa     TEXT,
  original_key    TEXT,
  new_key         TEXT,
  reason          TEXT,
  resolved_by     TEXT        DEFAULT 'admin',
  resolved_at     TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 6: social_proof
-- ============================================================
CREATE TABLE IF NOT EXISTS social_proof (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_name  TEXT        NOT NULL,
  customer_city  TEXT,
  paket          TEXT        NOT NULL,
  order_id       TEXT,
  verified       BOOLEAN     DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 7: testimonials
-- ============================================================
CREATE TABLE IF NOT EXISTS testimonials (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name         TEXT        NOT NULL,
  city         TEXT,
  role         TEXT,
  content      TEXT        NOT NULL,
  rating       INTEGER     DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
  verified     BOOLEAN     DEFAULT false,
  is_featured  BOOLEAN     DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- TABEL 8: downloads (opsional — tracking download)
-- ============================================================
CREATE TABLE IF NOT EXISTS downloads (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id     TEXT,
  license_key  TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  link_type    TEXT        DEFAULT 'primary', -- primary | mirror
  downloaded_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_transactions_status       ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_email        ON transactions(customer_email);
CREATE INDEX IF NOT EXISTS idx_transactions_order_id     ON transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_transactions_paid_at      ON transactions(paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_licenses_key              ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_email            ON licenses(buyer_email);
CREATE INDEX IF NOT EXISTS idx_licenses_order_id         ON licenses(order_id);
CREATE INDEX IF NOT EXISTS idx_licenses_device_id        ON licenses(device_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status_expired   ON licenses(status, expired_at);

CREATE INDEX IF NOT EXISTS idx_license_events_key        ON license_events(license_key);
CREATE INDEX IF NOT EXISTS idx_license_events_created    ON license_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_proof_verified     ON social_proof(verified, created_at DESC);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_licenses_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RPC: check_and_expire_licenses
-- Dipanggil oleh keep-alive.js setiap 3 hari
-- ============================================================
CREATE OR REPLACE FUNCTION check_and_expire_licenses()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE licenses
  SET status     = 'expired',
      updated_at = now()
  WHERE expired_at IS NOT NULL
    AND expired_at < now()
    AND status = 'active';

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RLS (Row Level Security)
-- API menggunakan service_role_key → bypass RLS otomatis
-- Public tidak bisa akses tabel sensitif tanpa auth
-- ============================================================
ALTER TABLE transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_proof    ENABLE ROW LEVEL SECURITY;
ALTER TABLE testimonials    ENABLE ROW LEVEL SECURITY;
ALTER TABLE downloads       ENABLE ROW LEVEL SECURITY;

-- Public hanya bisa baca social_proof yang verified
CREATE POLICY "public_read_social_proof"
  ON social_proof FOR SELECT
  TO anon
  USING (verified = true);

-- Public hanya bisa baca testimoni yang featured
CREATE POLICY "public_read_testimonials"
  ON testimonials FOR SELECT
  TO anon
  USING (verified = true AND is_featured = true);

-- Service role (API Vercel) → bypass semua RLS secara otomatis
-- Tidak perlu policy tambahan untuk service role

-- ============================================================
-- DATA AWAL: Testimonial sample
-- ============================================================
INSERT INTO testimonials (name, city, role, content, rating, verified, is_featured) VALUES
  ('Rini Handayani',    'Semarang', 'Koordinator Training',        'Dulu bikin 300 sertifikat webinar butuh setengah hari penuh. Sekarang pakai CertGen PRO cuma 3 menit. Luar biasa efisien!', 5, true, true),
  ('Dimas Kurniawan',   'Jakarta',  'Event Organizer',             'QR Code validasinya keren banget. Peserta bisa langsung verifikasi sertifikat mereka. Acara kami jadi lebih profesional.', 5, true, true),
  ('Siti Purwanti',     'Yogyakarta','Kaprodi Universitas Swasta', 'Templatenya bisa dikustomisasi sesuai branding kampus kami. Kirim email otomatis ke mahasiswa bikin kerja admin jauh lebih ringan.', 5, true, true),
  ('Agus Firmansyah',   'Surabaya', 'Founder Komunitas Digital',   'Investasi paling worth it tahun ini. Paket Lifetime langsung balik modal dari event pertama. Sangat direkomendasikan!', 5, true, true),
  ('Nur Wahyuni',       'Bandung',  'Trainer Freelance',           'Install mudah, antarmuka bersih. Saya yang tidak jago IT pun langsung bisa pakai. Support-nya juga responsif via WA.', 5, true, true),
  ('Yusuf Pratama',     'Malang',   'HRD Manager',                 'Fitur nomor sertifikat otomatis sangat membantu untuk keperluan administrasi. Tidak ada lagi sertifikat dengan nomor duplikat.', 5, true, true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- MONITORING QUERIES (untuk Supabase SQL Editor)
-- ============================================================

-- Ringkasan penjualan hari ini
-- SELECT paket, COUNT(*) as total, SUM(amount) as revenue
-- FROM transactions
-- WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE
-- GROUP BY paket ORDER BY revenue DESC;

-- Lisensi aktif per paket
-- SELECT package_type, COUNT(*) as total
-- FROM licenses WHERE status = 'active'
-- GROUP BY package_type;

-- Anomali: paid tapi tidak ada lisensi
-- SELECT t.order_id, t.customer_email, t.paid_at
-- FROM transactions t
-- LEFT JOIN licenses l ON t.order_id = l.order_id
-- WHERE t.status = 'paid' AND l.id IS NULL;

-- Lisensi yang email/WA-nya gagal terkirim
-- SELECT l.license_key, l.order_id, l.email_sent, l.wa_sent,
--        t.customer_email, t.customer_wa
-- FROM licenses l JOIN transactions t ON l.order_id = t.order_id
-- WHERE l.email_sent = false OR l.wa_sent = false
-- ORDER BY l.created_at DESC;

-- Revoke lisensi
-- UPDATE licenses SET status = 'revoked' WHERE license_key = 'CERTGEN-XXXX-XXXX-XXXX';
