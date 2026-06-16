const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 20;

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

export function createCorsMiddleware({
  allowedOrigins = process.env.ALLOWED_ORIGINS,
  nodeEnv = process.env.NODE_ENV
} = {}) {
  const origins = parseAllowedOrigins(allowedOrigins);
  const isProduction = nodeEnv === 'production';

  return (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = isOriginAllowed(origin, req.headers.host, origins, isProduction);

    if (origin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (!origin && !isProduction) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.sendStatus(allowed ? 204 : 403);
      return;
    }

    next();
  };
}

export function parseAllowedOrigins(value = '') {
  return new Set(
    String(value)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

export function isOriginAllowed(origin, host, allowedOrigins, isProduction) {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.has('*') || allowedOrigins.has(origin)) {
    return true;
  }
  if (isSameHostOrigin(origin, host)) {
    return true;
  }
  return !isProduction && isLocalDevOrigin(origin);
}

export function createRateLimiter({
  windowMs = positiveNumber(process.env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
  max = positiveNumber(process.env.AUTH_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
  keyGenerator = defaultRateLimitKey
} = {}) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count <= max) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ message: 'Too many attempts. Please try again later.' });
  };
}

function defaultRateLimitKey(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwardedFor || req.ip || req.socket?.remoteAddress || 'unknown';
}

function isSameHostOrigin(origin, host) {
  try {
    const url = new URL(origin);
    return Boolean(host) && url.host === host;
  } catch {
    return false;
  }
}

function isLocalDevOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
