export function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
}

export function errorHandler(error, req, res, next) {
  console.error(error);
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'Each image must be under 8MB' });
  if (error.name === 'ValidationError') return res.status(400).json({ message: Object.values(error.errors).map((item) => item.message).join(', ') });
  if (error.code === 11000) return res.status(409).json({ message: 'A record with that value already exists' });
  res.status(error.statusCode || 500).json({ message: error.message || 'Unexpected server error' });
}

