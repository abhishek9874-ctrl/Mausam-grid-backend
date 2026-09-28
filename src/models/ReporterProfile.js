const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Tracks a per-author trust record across every report they've submitted.
 * This is what powers the "Reporter Trust Network" feature: an author's
 * track record of verified vs. rejected reports feeds back into the
 * credibility score of their *next* report (see ml/pipeline.js), and the
 * aggregate standings power the public Reporters leaderboard. This kind
 * of longitudinal, cross-report reputation system is not something
 * mainstream weather sites offer — they treat every report/observation
 * as anonymous and disconnected.
 */
const ReporterProfileSchema = new Schema(
  {
    authorHandle: { type: String, required: true, unique: true, index: true },
    source: String,
    totalReports: { type: Number, default: 0 },
    verifiedReports: { type: Number, default: 0 },
    rejectedReports: { type: Number, default: 0 },
    trustScore: { type: Number, default: 50, min: 0, max: 100 },
    badges: [String], // e.g. "Storm Spotter", "First Responder", "Flood Watch"
    lastReportAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReporterProfile", ReporterProfileSchema);
