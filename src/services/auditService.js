const AuditLog = require("../models/AuditLog");

async function logAction({ action, user, targetType, targetId, detail, ip }) {
  try {
    await AuditLog.create({
      action,
      userId: user ? user._id || user.id || user.sub : null,
      userEmail: user ? user.email : null,
      targetType,
      targetId,
      detail,
      ip,
    });
  } catch (err) {
    // Audit logging must never break the primary request flow.
    console.error("[audit] failed to write log:", err.message);
  }
}

module.exports = { logAction };
