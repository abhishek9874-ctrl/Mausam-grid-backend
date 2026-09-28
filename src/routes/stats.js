const express = require("express");
const router = express.Router();
const Report = require("../models/Report");

router.get("/", async (req, res) => {
  try {
    const hours = Number(req.query.hours || 24);
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const match = { postedAt: { $gte: since } };

    const [total, verified, pending, rejected, needsReview, likelyFake, duplicates] = await Promise.all([
      Report.countDocuments(match),
      Report.countDocuments({ ...match, verificationStatus: "verified" }),
      Report.countDocuments({ ...match, verificationStatus: "pending" }),
      Report.countDocuments({ ...match, verificationStatus: "rejected" }),
      Report.countDocuments({ ...match, verificationStatus: "needs_review" }),
      Report.countDocuments({ ...match, isLikelyFake: true }),
      Report.countDocuments({ ...match, isDuplicate: true }),
    ]);

    const byEventAgg = await Report.aggregate([{ $match: match }, { $group: { _id: "$eventCategory", count: { $sum: 1 } } }]);
    const byStateAgg = await Report.aggregate([{ $match: match }, { $group: { _id: "$state", count: { $sum: 1 } } }]);
    const bySeverityAgg = await Report.aggregate([{ $match: match }, { $group: { _id: "$severity", count: { $sum: 1 } } }]);

    const timelineAgg = await Report.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%dT%H:00", date: "$postedAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      totalReports: total,
      verified,
      pending,
      rejected,
      needsReview,
      likelyFake,
      duplicates,
      byEvent: Object.fromEntries(byEventAgg.map((r) => [r._id, r.count])),
      byState: Object.fromEntries(byStateAgg.map((r) => [r._id, r.count])),
      bySeverity: Object.fromEntries(bySeverityAgg.map((r) => [r._id, r.count])),
      timeline: timelineAgg.map((r) => ({ hour: r._id, count: r.count })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
