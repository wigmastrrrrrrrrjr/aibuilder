// IP-based rate limiter — fixed-window with auto-cleanup.

export function rateLimit({ windowMs = 60000, max = 120, keyFn } = {}) {
  const hits = new Map();
  let lastCleanup = Date.now();

  // Evict stale entries every 60s
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < 60000) return;
    lastCleanup = now;
    for (const [k, v] of hits) {
      if (now - v.start > windowMs) hits.delete(k);
    }
  }

  return async (c, next) => {
    cleanup();
    const ip = keyFn ? keyFn(c) : (
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'unknown'
    );
    const now = Date.now();
    const rec = hits.get(ip);

    if (!rec || now - rec.start > windowMs) {
      hits.set(ip, { start: now, count: 1 });
      c.header('X-RateLimit-Limit', String(max));
      c.header('X-RateLimit-Remaining', String(max - 1));
      return next();
    }

    rec.count++;
    const remaining = Math.max(0, max - rec.count);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.start + windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: `rate limit exceeded — try again in ${retryAfter}s` }, 429);
    }

    return next();
  };
}
