const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * A single weather-related report collected from any source: Twitter/X,
 * Facebook, Instagram, the citizen reporting mobile app, the IMD public
 * API, partner news sites, etc. Every collector normalises its payload to
 * this shape before it reaches the ingestion service (see
 * src/services/ingestService.js), so switching or adding a source never
 * touches the schema, the ML pipeline, or the dashboard.
 */
const ReportSchema = new Schema(
  {
    externalId: { type: String, index: true, unique: true, sparse: true },
    source: {
      type: String,
      enum: ["twitter", "citizen_app", "imd_api", "facebook", "instagram", "news_verified", "whatsapp_forward"],
      required: true,
      index: true,
    },
    sourceUrl: String,

    authorHandle: String,
    authorFollowers: { type: Number, default: 0 },
    authorAccountAgeDays: { type: Number, default: 0 },
    authorVerifiedBadge: { type: Boolean, default: false },

    rawText: { type: String, required: true },
    hashtags: [String],

    postedAt: { type: Date, required: true, index: true },
    ingestedAt: { type: Date, default: Date.now },

    city: { type: String, required: true, index: true },
    state: { type: String, required: true, index: true },
    location: {
      // GeoJSON point, enables MongoDB $geoNear / $geoWithin queries in production
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },

    mediaPhotoUrl: String,
    mediaVideoUrl: String,
    hasMedia: { type: Boolean, default: false },

    eventCategory: {
      type: String,
      enum: ["rainfall", "flooding", "thunderstorm", "heatwave", "fog", "dust_storm", "strong_wind", "snowfall", "other"],
      default: "other",
      index: true,
    },
    eventConfidence: { type: Number, default: 0.35 },
    severity: { type: String, enum: ["low", "moderate", "severe", "extreme"], default: "low" },

    credibilityScore: { type: Number, default: 50, min: 0, max: 100 },
    isLikelyFake: { type: Boolean, default: false, index: true },

    isDuplicate: { type: Boolean, default: false, index: true },
    duplicateOfId: { type: Schema.Types.ObjectId, ref: "Report", default: null },
    clusterId: { type: String, index: true, default: null },

    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected", "needs_review"],
      default: "pending",
      index: true,
    },
    verifiedBy: String,
    verifiedAt: Date,
    adminNotes: String,
  },
  { timestamps: true }
);

ReportSchema.index({ location: "2dsphere" });
ReportSchema.index({ state: 1, city: 1 });
ReportSchema.index({ eventCategory: 1, postedAt: -1 });
ReportSchema.index({ rawText: "text" });

module.exports = mongoose.model("Report", ReportSchema);
