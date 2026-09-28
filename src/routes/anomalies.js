const express = require("express");
const router = express.Router();
const Report = require("../models/Report");
const { computeEmergingEvents, BASELINE_WINDOW_MIN } = require("../ml/anomaly");

/**
 * GET /api/anomalies
 * Returns the ranked Emerging Event Radar feed: locations where report
 * *velocity* for a given event category is spiking well above its own
 * recent baseline and is independently corroborated by multiple authors
 * and sources — a leading indicator that can surface minutes to hours
 * before an official bulletin.
 */
router.get("/", async (req, res) => {
  try {
    const since = new Date(Date.now() - BASELINE_WINDOW_MIN * 60000);
    const reports = await Report.find({ postedAt: { $gte: since } })
      .select("postedAt city state eventCategory authorHandle source credibilityScore isLikelyFake rawText")
      .lean();
    const results = computeEmergingEvents(reports);
    res.json({
      generatedAt: new Date().toISOString(),
      windowMinutes: BASELINE_WINDOW_MIN,
      hotspots: results.slice(0, 25),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
