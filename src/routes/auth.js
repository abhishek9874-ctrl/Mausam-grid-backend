const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const { signAccessToken, signRefreshToken, verifyRefreshToken, REFRESH_TTL_MS } = require("../utils/tokens");
const { authenticate, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/auditService");

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // per IP across all accounts; per-account lockout below is the stricter guard
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts from this IP. Try again later." },
});

// In production the frontend (e.g. Vercel) and API (e.g. Render) live on different
// domains, so the refresh cookie must be SameSite=None; Secure to be sent cross-site.
const IS_PROD = process.env.NODE_ENV === "production";
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? "none" : "lax",
  maxAge: REFRESH_TTL_MS,
  path: "/api/auth",
};

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, errors: errors.array() });
  next();
}

/**
 * POST /api/auth/signup
 * Self-service signup is only ever allowed to create "citizen" accounts.
 * district_admin / state_admin / super_admin accounts can only be
 * created by an existing super_admin via POST /api/auth/admin-create.
 */
router.post(
  "/signup",
  [
    body("name").trim().isLength({ min: 2 }).withMessage("Name is too short"),
    body("email").isEmail().normalizeEmail().withMessage("Invalid email"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters")
      .matches(/[A-Z]/)
      .withMessage("Password needs at least one uppercase letter")
      .matches(/[0-9]/)
      .withMessage("Password needs at least one number"),
  ],
  validate,
  async (req, res) => {
    try {
      const { name, email, password } = req.body;
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: "An account with this email already exists" });

      const user = new User({ name, email, role: "citizen" });
      await user.setPassword(password);
      await user.save();

      await logAction({ action: "signup", user, ip: req.ip });

      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTS);
      res.status(201).json({ user: user.toSafeJSON(), accessToken });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/auth/admin-create — super_admin only.
 * Creates a district_admin or state_admin account bound to a state.
 */
router.post(
  "/admin-create",
  authenticate,
  requireRole("super_admin"),
  [
    body("name").trim().isLength({ min: 2 }),
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("role").isIn(["district_admin", "state_admin"]),
    body("state").trim().isLength({ min: 2 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { name, email, password, role, state } = req.body;
      const existing = await User.findOne({ email });
      if (existing) return res.status(409).json({ error: "An account with this email already exists" });

      const user = new User({ name, email, role, state });
      await user.setPassword(password);
      await user.save();

      await logAction({ action: "admin_create", user: req.user, targetType: "User", targetId: user._id, detail: { role, state }, ip: req.ip });
      res.status(201).json({ user: user.toSafeJSON() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/auth/login
 */
router.post(
  "/login",
  loginLimiter,
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !user.isActive) {
      await logAction({ action: "login_failed", detail: { email, reason: "no_such_user" }, ip: req.ip });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (user.isLocked()) {
      await logAction({ action: "login_failed", user, detail: { reason: "locked" }, ip: req.ip });
      return res.status(423).json({ error: "Account temporarily locked due to repeated failed logins. Try again later." });
    }

    const ok = await user.verifyPassword(password);
    if (!ok) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
        user.failedLoginAttempts = 0;
      }
      await user.save();
      await logAction({ action: "login_failed", user, detail: { reason: "bad_password" }, ip: req.ip });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    await logAction({ action: "login", user, ip: req.ip });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTS);
    res.json({ user: user.toSafeJSON(), accessToken });
  }
);

/**
 * POST /api/auth/refresh
 * Reads the httpOnly refresh cookie, issues a new short-lived access token.
 */
router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) return res.status(401).json({ error: "No refresh token" });

  try {
    const payload = verifyRefreshToken(token);
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive || user.refreshTokenVersion !== payload.v) {
      return res.status(401).json({ error: "Refresh token no longer valid" });
    }
    const accessToken = signAccessToken(user);
    res.json({ user: user.toSafeJSON(), accessToken });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/**
 * POST /api/auth/logout
 * Clears the refresh cookie. Bumping refreshTokenVersion (optional,
 * triggered from a "log out everywhere" action) would invalidate all
 * outstanding refresh tokens for the account.
 */
router.post("/logout", (req, res) => {
  res.clearCookie("refreshToken", { path: "/api/auth", httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? "none" : "lax" });
  res.json({ status: "logged_out" });
});

/**
 * GET /api/auth/me — resolve the current user from the access token.
 */
router.get("/me", authenticate, async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: user.toSafeJSON() });
});

module.exports = router;
