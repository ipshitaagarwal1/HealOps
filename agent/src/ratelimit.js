// Tiny in-memory sliding-window rate limiter. One process, one dashboard demo: no
// shared store needed. Keyed by the admin token so one caller can't starve another.

export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> sorted timestamps within the window

  return function rateLimit(req, res, next) {
    const key = String(req.get('x-admin-token') || req.ip || 'anonymous');
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'too many requests, slow down' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
