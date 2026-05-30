// api/time.js — CertGen Pro v3
// Mengembalikan waktu UTC server secara realtime (anti clock manipulation)
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ utc: new Date().toISOString() });
};
