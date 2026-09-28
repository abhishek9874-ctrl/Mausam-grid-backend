require("dotenv").config();
const { connectDB, mongoose } = require("../db");
const Report = require("../models/Report");
const ReporterProfile = require("../models/ReporterProfile");
const { generateSyntheticReport } = require("./simulator");
const { ingestReport } = require("../services/ingestService");

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/weather_platform";
  await connectDB(uri);

  console.log("[seed] clearing existing reports & reporter profiles...");
  await Report.deleteMany({});
  await ReporterProfile.deleteMany({});

  const N = 300;
  console.log(`[seed] generating ${N} synthetic reports...`);
  for (let i = 0; i < N; i++) {
    const roll = Math.random();
    let payload;
    if (roll < 0.06) payload = generateSyntheticReport({ forceFake: true });
    else payload = generateSyntheticReport();
    await ingestReport(payload);
    if ((i + 1) % 50 === 0) console.log(`[seed] ${i + 1}/${N}`);
  }

  console.log("[seed] done.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
