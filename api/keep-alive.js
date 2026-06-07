// api/keep-alive.js
// ============================================================
// Cron job harian — 3 tugas sekaligus:
//   1. PING  — baca 1 baris dari DB agar Supabase tidak auto-pause
//   2. EXPIRE — UPDATE licenses yang expired_at sudah lewat
//   3. CLEANUP — DELETE license_events yang lebih dari 90 hari
//              — DELETE social_proof yang lebih dari 60 hari
//              — DELETE transactions 'pending' yang lebih dari 3 hari
//
// Dijadwalkan lewat vercel.json:
//   "schedule": "0 7 * * *"  → setiap hari jam 07:00 UTC (14:00 WIB)
//
// Bisa juga dipanggil manual dengan CRON_SECRET:
//   GET /api/keep-alive?secret=CRON_SECRET_ANDA
// ============================================================

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // ── Auth: hanya cron Vercel atau pemanggil dengan secret ──
  const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    // Vercel cron tidak mengirim secret — cek User-Agent Vercel
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes('vercel-cron')) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const results = {
    ran_at:             new Date().toISOString(),
    ping_ok:            false,
    licenses_expired:   0,
    events_deleted:     0,
    proof_deleted:      0,
    pending_deleted:    0,
    errors:             [],
  };

  // ──────────────────────────────────────────────────────────
  // TUGAS 1 — PING Supabase
  // Cukup 1 baris SELECT kecil, tujuannya hanya "menyentuh" DB
  // agar Supabase free tier tidak hitung idle dan auto-pause.
  // ──────────────────────────────────────────────────────────
  try {
    const { error } = await supabase
      .from('transactions')
      .select('id')
      .limit(1);

    results.ping_ok = !error;
    if (error) results.errors.push(`ping: ${error.message}`);
  } catch (e) {
    results.errors.push(`ping: ${e.message}`);
  }

  // ──────────────────────────────────────────────────────────
  // TUGAS 2 — EXPIRE lisensi yang expired_at sudah lewat
  // Hanya update status → 'expired', data tetap ada untuk audit
  // ──────────────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('licenses')
      .update({
        status:     'expired',
        updated_at: new Date().toISOString(),
      })
      .lt('expired_at', new Date().toISOString())   // expired_at < sekarang
      .eq('status', 'active')                        // hanya yang masih active
      .not('expired_at', 'is', null)                 // jangan sentuh lifetime (NULL)
      .select('license_key');

    results.licenses_expired = data?.length || 0;
    if (error) results.errors.push(`expire: ${error.message}`);

    // Log setiap lisensi yang di-expire ke license_events
    if (data && data.length > 0) {
      const events = data.map(lic => ({
        license_key: lic.license_key,
        event_type:  'auto_expired',
        note:        `Auto-expired by keep-alive cron at ${results.ran_at}`,
      }));
      await supabase.from('license_events').insert(events);
    }
  } catch (e) {
    results.errors.push(`expire: ${e.message}`);
  }

  // ──────────────────────────────────────────────────────────
  // TUGAS 3A — CLEANUP license_events > 90 hari
  // Tabel ini bisa tumbuh cepat karena setiap validate() menulis event.
  // Hapus event lama yang tidak relevan lagi.
  // ──────────────────────────────────────────────────────────
  try {
    const cutoff90 = new Date();
    cutoff90.setDate(cutoff90.getDate() - 90);

    const { data, error } = await supabase
      .from('license_events')
      .delete()
      .lt('created_at', cutoff90.toISOString())
      // Pertahankan event penting meskipun sudah lama
      .not('event_type', 'in', '("activated","revoked","auto_expired")')
      .select('id');

    results.events_deleted = data?.length || 0;
    if (error) results.errors.push(`cleanup_events: ${error.message}`);
  } catch (e) {
    results.errors.push(`cleanup_events: ${e.message}`);
  }

  // ──────────────────────────────────────────────────────────
  // TUGAS 3B — CLEANUP social_proof > 60 hari
  // Feed realtime tidak perlu data lebih dari 2 bulan
  // ──────────────────────────────────────────────────────────
  try {
    const cutoff60 = new Date();
    cutoff60.setDate(cutoff60.getDate() - 60);

    const { data, error } = await supabase
      .from('social_proof')
      .delete()
      .lt('created_at', cutoff60.toISOString())
      .select('id');

    results.proof_deleted = data?.length || 0;
    if (error) results.errors.push(`cleanup_proof: ${error.message}`);
  } catch (e) {
    results.errors.push(`cleanup_proof: ${e.message}`);
  }

  // ──────────────────────────────────────────────────────────
  // TUGAS 3C — CLEANUP transactions 'pending' > 3 hari
  // Transaksi pending yang tidak diselesaikan user — buang saja.
  // Yang 'paid' dan 'failed' tetap disimpan selamanya untuk audit.
  // ──────────────────────────────────────────────────────────
  try {
    const cutoff3 = new Date();
    cutoff3.setDate(cutoff3.getDate() - 3);

    const { data, error } = await supabase
      .from('transactions')
      .delete()
      .eq('status', 'pending')
      .lt('created_at', cutoff3.toISOString())
      .select('id');

    results.pending_deleted = data?.length || 0;
    if (error) results.errors.push(`cleanup_pending: ${error.message}`);
  } catch (e) {
    results.errors.push(`cleanup_pending: ${e.message}`);
  }

  // ── Log ringkasan ke console Vercel ───────────────────────
  console.log('[keep-alive] Summary:', JSON.stringify(results));

  return res.status(200).json(results);
};
