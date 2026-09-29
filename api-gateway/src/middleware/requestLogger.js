function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const id = req.id || '-';
    console.log(`[gateway] ${id} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

module.exports = requestLogger;
