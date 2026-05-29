// ============================================================
// time.js
// Mengembalikan waktu UTC server — digunakan desktop app
// untuk mencegah manipulasi jam lokal
// ============================================================

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ utc: new Date().toISOString() });
};
