/**
 * Sends a standardized JSON success response across all API endpoints.
 */
export function sendSuccess(res, { statusCode = 200, message, data, meta } = {}) {
  const payload = {
    success: true,
    ...(message ? { message } : {}),
    data,
    ...(meta ? { meta } : {}),
  };

  return res.status(statusCode).json(payload);
}
