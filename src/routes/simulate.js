const express = require("express");
const router = express.Router();
const { startSimulator, stopSimulator, isRunning } = require("../ingestion/runner");
const { authenticate, requireRole } = require("../middleware/auth");

router.post("/start", authenticate, requireRole("district_admin"), (req, res) => {
  const rate = Number(req.query.ratePerMin || 30);
  startSimulator(req.app.get("io"), rate);
  res.json({ status: "started", ratePerMin: rate });
});

router.post("/stop", authenticate, requireRole("district_admin"), (req, res) => {
  stopSimulator();
  res.json({ status: "stopped" });
});

router.get("/status", (req, res) => {
  res.json({ running: isRunning() });
});

module.exports = router;
