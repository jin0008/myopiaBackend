import rateLimit from "express-rate-limit";

/**
 * Brute-force / credential-stuffing protection for authentication endpoints.
 *
 * Only FAILED requests are counted (`skipSuccessfulRequests`), so a busy clinic
 * where many staff sign in from the same public IP is not affected by normal
 * use — only repeated failures from one IP are throttled. CORS preflight
 * (OPTIONS → 204) is treated as success and therefore not counted either.
 *
 * IMPORTANT: this keys on the client IP, which only works when Express is told
 * to trust the nginx reverse proxy — see `app.set("trust proxy", 1)` in
 * index.ts. Without it every request would appear to come from 127.0.0.1 and
 * a single attacker could lock out everyone.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max 30 FAILED attempts per IP per window
  standardHeaders: true, // expose RateLimit-* headers
  legacyHeaders: false, // drop the deprecated X-RateLimit-* headers
  skipSuccessfulRequests: true, // successful logins do not count toward the limit
  message: {
    message:
      "Too many attempts from this network. Please wait a few minutes and try again.",
  },
});
