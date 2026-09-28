const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { Schema } = mongoose;

/**
 * Roles map to the real governance hierarchy this platform is built for,
 * not a generic "user/admin" split:
 *   - citizen        can submit reports, view public dashboards
 *   - district_admin can verify/reject reports within their own state
 *                     (district-level scoping can be added later via a
 *                     `district` field once report data carries one)
 *   - state_admin     can verify anywhere in their assigned state, sees
 *                     state-level analytics
 *   - super_admin     full access; the only role that can create other
 *                     district_admin/state_admin accounts
 */
const ROLES = ["citizen", "district_admin", "state_admin", "super_admin"];

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: "citizen", index: true },
    state: { type: String, default: null }, // required for district_admin / state_admin
    isActive: { type: Boolean, default: true },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    refreshTokenVersion: { type: Number, default: 0 }, // bumping this invalidates all outstanding refresh tokens
  },
  { timestamps: true }
);

UserSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = await bcrypt.hash(plainPassword, 12);
};

UserSchema.methods.verifyPassword = function (plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

UserSchema.methods.isLocked = function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

UserSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    state: this.state,
    isActive: this.isActive,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model("User", UserSchema);
module.exports.ROLES = ROLES;
