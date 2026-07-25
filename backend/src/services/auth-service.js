import crypto from "node:crypto";
import { config } from "../config.js";

// Optional shared-password auth. When ZEROBUG_AUTH_PASSWORD is unset, auth is
// disabled and every request passes — so an existing install is never locked out.

export function authEnabled() {
  return !!config.authPassword;
}

// Stable bearer token derived from the password (so the raw password isn't
// resent after login). Not a session system — a simple gate.
export function expectedToken() {
  return crypto.createHash("sha256").update(`zerobug-auth:${config.authPassword}`).digest("hex");
}

export function verifyPassword(password) {
  return authEnabled() && String(password ?? "") === config.authPassword;
}

/** Express middleware: allow if auth is off, else require a valid token. */
export function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = bearer || (typeof req.query.token === "string" ? req.query.token : "");
  if (token && token === expectedToken()) return next();
  return res.status(401).json({ error: "Authentication required" });
}
