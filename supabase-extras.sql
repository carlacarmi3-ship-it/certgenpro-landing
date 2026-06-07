-- ============================================================
-- CERTGEN PRO — SQL Tambahan: Cleanup + Monitoring
-- Jalankan di Supabase SQL Editor
-- ============================================================


-- ============================================================
-- FUNCTION: Expire lisensi kadaluarsa
-- Bisa dipanggil manual dari SQL Editor kapan saja
-- ============================================================
CREATE OR REPLACE FUNCTION expire_overdue_licenses()
RETURNS TABLE(license_key TEXT, package_type TEXT, expired_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  UPDATE licenses l
  SET    status     = 'expired',
         updated_at = now()
  WHERE  l.expired_at IS NOT NULL
    AND  l.expired_at < now()
    AND  l.status = 'active'
  RETURNING l.license_key, l.package_type, l.expired_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cara pakai (jalankan di SQL Editor):
-- SELECT * FROM expire_overdue_licenses();


-- ============================================================
-- FUNCTION: Cleanup data lama
-- Satu fungsi untuk semua cleanup — bisa dipanggil manual
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_data(
  events_days  INT DEFAULT 90,   -- hapus license_events > N hari (kecuali penting)
  proof_days   INT DEFAULT 60,   -- hapus social_proof > N hari
  pending_days INT DEFAULT 3     -- hapus transactions pending > N hari
)
RETURNS JSONB AS $$
DECLARE
  v_events_deleted  INT := 0;
  v_proof_deleted   INT := 0;
  v_pending_deleted INT := 0;
BEGIN
  -- Hapus license_events lama (kecuali activated, revoked, auto_expired)
  DELETE FROM license_events
  WHERE  created_at < now() - (events_days || ' days')::INTERVAL
    AND  event_type NOT IN ('activated', 'revoked', 'auto_expired');
  GET DIAGNOSTICS v_events_deleted = ROW_COUNT;

  -- Hapus social_proof lama
  DELETE FROM social_proof
  WHERE  created_at < now() - (proof_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_proof_deleted = ROW_COUNT;

  -- Hapus transactions pending yang ditinggalkan
  DELETE FROM transactions
  WHERE  status = 'pending'
    AND  created_at < now() - (pending_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_pending_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'events_deleted',  v_events_deleted,
    'proof_deleted',   v_proof_deleted,
    'pending_deleted', v_pending_deleted,
    'ran_at',          now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cara pakai (jalankan di SQL Editor):
-- SELECT cleanup_old_data();
-- SELECT cleanup_old_data(events_days => 30, proof_days => 14, pending_days => 1);


-- ============================================================
-- VIEW: Dashboard ringkasan (buka di Table Editor → Views)
-- ============================================================
CREATE OR REPLACE VIEW v_dashboard AS
SELECT
  -- Penjualan total
  (SELECT COUNT(*)   FROM transactions WHERE status = 'paid')           AS total_orders,
  (SELECT SUM(amount) FROM transactions WHERE status = 'paid')          AS total_revenue,
  -- Penjualan hari ini
  (SELECT COUNT(*)   FROM transactions
   WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE)             AS orders_today,
  (SELECT COALESCE(SUM(amount), 0) FROM transactions
   WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE)             AS revenue_today,
  -- Lisensi aktif
  (SELECT COUNT(*) FROM licenses WHERE status = 'active')               AS licenses_active,
  (SELECT COUNT(*) FROM licenses WHERE status = 'expired')              AS licenses_expired,
  (SELECT COUNT(*) FROM licenses WHERE status = 'revoked')              AS licenses_revoked,
  -- Belum aktifkan device
  (SELECT COUNT(*) FROM licenses
   WHERE status = 'active' AND device_id IS NULL)                       AS licenses_not_activated,
  -- Anomali
  (SELECT COUNT(*) FROM transactions t
   LEFT JOIN licenses l ON t.order_id = l.order_id
   WHERE t.status = 'paid' AND l.id IS NULL)                            AS anomaly_paid_no_license,
  (SELECT COUNT(*) FROM licenses
   WHERE email_sent = false OR wa_sent = false)                         AS delivery_failed;

-- Cara pakai:
-- SELECT * FROM v_dashboard;


-- ============================================================
-- VIEW: Anomali — paid tapi tidak ada lisensi
-- ============================================================
CREATE OR REPLACE VIEW v_anomaly_missing_license AS
SELECT
  t.order_id,
  t.customer_name,
  t.customer_email,
  t.customer_wa,
  t.paket,
  t.amount,
  t.paid_at
FROM transactions t
LEFT JOIN licenses l ON t.order_id = l.order_id
WHERE t.status = 'paid'
  AND l.id IS NULL
ORDER BY t.paid_at DESC;

-- Cara pakai:
-- SELECT * FROM v_anomaly_missing_license;


-- ============================================================
-- VIEW: Lisensi yang email/WA-nya gagal terkirim
-- ============================================================
CREATE OR REPLACE VIEW v_delivery_failed AS
SELECT
  l.license_key,
  l.order_id,
  l.email_sent,
  l.wa_sent,
  l.created_at,
  t.customer_name,
  t.customer_email,
  t.customer_wa,
  t.paket
FROM licenses l
JOIN transactions t ON l.order_id = t.order_id
WHERE l.email_sent = false OR l.wa_sent = false
ORDER BY l.created_at DESC;

-- Cara pakai:
-- SELECT * FROM v_delivery_failed;


-- ============================================================
-- QUERY MONITORING HARIAN (simpan di SQL Editor sebagai saved query)
-- ============================================================

-- 1. Ringkasan penjualan hari ini
-- SELECT paket, COUNT(*) total, SUM(amount) revenue
-- FROM transactions
-- WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE
-- GROUP BY paket ORDER BY revenue DESC;

-- 2. Lisensi aktif per paket
-- SELECT package_type, COUNT(*) total
-- FROM licenses WHERE status = 'active'
-- GROUP BY package_type ORDER BY total DESC;

-- 3. Penjualan 30 hari terakhir (per hari)
-- SELECT DATE(paid_at) tgl, COUNT(*) total, SUM(amount) revenue
-- FROM transactions
-- WHERE status = 'paid' AND paid_at > now() - INTERVAL '30 days'
-- GROUP BY DATE(paid_at) ORDER BY tgl DESC;

-- 4. Cek semua anomali sekaligus
-- SELECT * FROM v_dashboard;

-- 5. Recovery cepat: lihat semua yang butuh admin-recovery
-- SELECT * FROM v_anomaly_missing_license;

-- 6. Manual expire sekarang (jalankan jika perlu)
-- SELECT * FROM expire_overdue_licenses();

-- 7. Manual cleanup sekarang
-- SELECT cleanup_old_data();

-- 8. Revoke lisensi
-- UPDATE licenses SET status = 'revoked'
-- WHERE license_key = 'CERTGEN-XXXX-XXXX-XXXX';

-- 9. Reset device binding (untuk transfer perangkat)
-- UPDATE licenses
-- SET device_id = NULL, activated_at = NULL, expired_at = NULL
-- WHERE license_key = 'CERTGEN-XXXX-XXXX-XXXX';
-- (User harus aktivasi ulang dari awal setelah ini)
