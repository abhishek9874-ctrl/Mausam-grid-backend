/**
 * Bootstraps the very first super_admin account, since every other
 * elevated role can only be created by an existing super_admin
 * (POST /api/auth/admin-create). Run this once after seeding:
 *
 *   node src/utils/createSuperAdmin.js "Full Name" admin@example.com "StrongPass123"
 */
require("dotenv").config();
const { connectDB, mongoose } = require("../db");
const User = require("../models/User");

async function main() {
  const [, , name, email, password] = process.argv;
  if (!name || !email || !password) {
    console.error('Usage: node src/utils/createSuperAdmin.js "Full Name" email@example.com "StrongPass123"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/weather_platform";
  await connectDB(uri);

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.error(`A user with email ${email} already exists (role: ${existing.role}).`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const user = new User({ name, email: email.toLowerCase(), role: "super_admin" });
  await user.setPassword(password);
  await user.save();

  console.log(`Created super_admin: ${user.email}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
