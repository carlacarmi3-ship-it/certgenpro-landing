// api/time.js
// Mengembalikan server time UTC — dipakai desktop app untuk anti clock manipulation

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    time:      new Date().toISOString(),
    timestamp: Date.now(),
    utc:       new Date().toUTCString(),
  });
};
