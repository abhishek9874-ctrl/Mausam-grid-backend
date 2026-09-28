const { verifyAccessToken } = require("../utils/tokens");

const ROLE_RANK = { citizen: 0, district_admin: 1, state_admin: 2, super_admin: 3 };

/**
 * Verifies the Authorization: Bearer <token> header and attaches the
 * decoded payload as req.user. Does not hit the database — the access
 * token is short-lived (15 min by default) so a stale role/state claim
 * self-corrects quickly on refresh.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Optional authentication: attaches req.user if a valid token is present,
 * but does not reject the request otherwise. Useful for public endpoints
 * that behave slightly differently for logged-in users.
 */
function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    req.user = verifyAccessToken(token);
  } catch (err) {
    /* ignore invalid token on optional routes */
  }
  next();
}

/**
 * @param {string} minRole - minimum role required, per ROLE_RANK
 */
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const rank = ROLE_RANK[req.user.role] ?? -1;
    if (rank < minRank) return res.status(403).json({ error: "Insufficient role" });
    next();
  };
}

/**
 * State-scoping guard: a district_admin/state_admin may only act on
 * resources within their own state; super_admin bypasses this check.
 * Expects the resource's state on req.resourceState (set by the route
 * handler before calling this, or pass a getter).
 */
function requireOwnState(getResourceState) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role === "super_admin") return next();
    const resourceState = typeof getResourceState === "function" ? getResourceState(req) : req.resourceState;
    if (req.user.state && resourceState && req.user.state !== resourceState) {
      return res.status(403).json({ error: `Not authorised for state: ${resourceState}` });
    }
    next();
  };
}

module.exports = { authenticate, optionalAuthenticate, requireRole, requireOwnState, ROLE_RANK };
