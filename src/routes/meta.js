const express = require("express");
const router = express.Router();
const Report = require("../models/Report");
const ReporterProfile = require("../models/ReporterProfile");

router.get("/states", async (req, res) => {
  const states = await Report.distinct("state");
  res.json(states.filter(Boolean).sort());
});

router.get("/cities", async (req, res) => {
  const q = {};
  if (req.query.state) q.state = req.query.state;
  const cities = await Report.distinct("city", q);
  res.json(cities.filter(Boolean).sort());
});

router.get("/reporters/leaderboard", async (req, res) => {
  const top = await ReporterProfile.find({ totalReports: { $gte: 1 } })
    .sort({ trustScore: -1, verifiedReports: -1 })
    .limit(25);
  res.json(top);
});

module.exports = router;
