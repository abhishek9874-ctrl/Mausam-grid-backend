const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Every login and every report verification decision is recorded here,
 * so the platform can show "every action is traceable, nothing is
 * silently changed" — a strong point for a public-sector data platform.
 */
const AuditLogSchema = new Schema(
  {
    action: { type: String, required: true, index: true }, // "login", "login_failed", "signup", "report_verify"
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    userEmail: { type: String, default: null },
    targetType: { type: String, default: null }, // e.g. "Report"
    targetId: { type: Schema.Types.ObjectId, default: null },
    detail: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AuditLog", AuditLogSchema);
