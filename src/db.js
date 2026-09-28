const mongoose = require("mongoose");

async function connectDB(uri) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
  });
  console.log(`[db] connected to MongoDB at ${uri.replace(/\/\/.*@/, "//***@")}`);
  return mongoose.connection;
}

module.exports = { connectDB, mongoose };
