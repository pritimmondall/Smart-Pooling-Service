const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively strips MongoDB operator keys ($-prefixed), dotted keys, and prototype-pollution keys.
 */
export function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const clean = {};
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key) || key.startsWith('$') || key.includes('.')) {
        continue;
      }
      clean[key] = sanitizeValue(nested);
    }
    return clean;
  }

  return value;
}

/**
 * Express middleware sanitizing req.body, req.query, and req.params against NoSQL operator injection.
 */
export function sanitizeRequest(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params);
  }
  next();
}
