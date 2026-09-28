const express = require("express");
const router = express.Router();
const Report = require("../models/Report");
const { ingestReport, verifyReport } = require("../services/ingestService");
const { authenticate, optionalAuthenticate, requireRole } = require("../middleware/auth");
const { logAction } = require("../services/auditService");

/**
 * POST /api/reports
 * Ingest one report from any collector (Twitter/X listener, citizen app
 * gateway, IMD feed poller, news scraper, ...). Body shape:
 * {
 *   source, sourceUrl, authorHandle, authorFollowers, authorAccountAgeDays,
 *   authorVerifiedBadge, rawText, hashtags: [], postedAt, city, state,
 *   latitude, longitude, mediaPhotoUrl, mediaVideoUrl, externalId
 * }
 */
router.post("/", optionalAuthenticate, async (req, res) => {
  try {
    const report = await ingestReport(req.body);
    req.app.get("io").emit("report:new", report.toObject());
    res.status(201).json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/reports
 * Query params: dateFrom, dateTo, eventCategory (comma separated for
 * multi-select), state, city, verificationStatus, isDuplicate, search,
 * limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const { dateFrom, dateTo, eventCategory, state, city, verificationStatus, isDuplicate, search, limit = 200, offset = 0 } = req.query;
    const q = {};
    if (dateFrom || dateTo) {
      q.postedAt = {};
      if (dateFrom) q.postedAt.$gte = new Date(dateFrom);
      if (dateTo) q.postedAt.$lte = new Date(dateTo);
    }
    if (eventCategory) q.eventCategory = { $in: eventCategory.split(",") };
    if (state) q.state = state;
    if (city) q.city = city;
    if (verificationStatus) q.verificationStatus = verificationStatus;
    if (isDuplicate !== undefined) q.isDuplicate = isDuplicate === "true";
    if (search) q.$text = { $search: search };

    const reports = await Report.find(q)
      .sort({ postedAt: -1 })
      .skip(Number(offset))
      .limit(Math.min(Number(limit), 2000));
    res.json(reports);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  const report = await Report.findById(req.params.id);
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

/**
 * PATCH /api/reports/:id/verify
 * Requires district_admin or above. A district_admin/state_admin may only
 * verify reports within their own assigned state; super_admin can verify
 * anywhere. Body: { verificationStatus: 'verified'|'rejected'|'needs_review'|'pending', adminNotes }
 *
 * CLUSTER-LEVEL VERIFICATION: this decision is applied to every report in
 * the same duplicate cluster, not just the one targeted — see
 * services/ingestService.js#verifyReport. The response and the
 * report:updated broadcasts reflect every report that changed.
 */
router.patch("/:id/verify", authenticate, requireRole("district_admin"), async (req, res) => {
  try {
    const existing = await Report.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Report not found" });

    if (req.user.role !== "super_admin" && req.user.state && existing.state !== req.user.state) {
      return res.status(403).json({ error: `You can only verify reports in ${req.user.state}` });
    }

    const updated = await verifyReport(req.params.id, {
      verificationStatus: req.body.verificationStatus,
      verifiedBy: req.user.email,
      adminNotes: req.body.adminNotes,
    });
    if (!updated || !updated.length) return res.status(404).json({ error: "Report not found" });

    await logAction({
      action: "report_verify",
      user: req.user,
      targetType: "Report",
      targetId: updated[0]._id,
      detail: { verificationStatus: updated[0].verificationStatus, adminNotes: updated[0].adminNotes, clusterSize: updated.length },
      ip: req.ip,
    });

    const io = req.app.get("io");
    updated.forEach((r) => io.emit("report:updated", r.toObject()));

    res.json({ report: updated[0], updatedCount: updated.length, updatedReports: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /api/reports/bulk-verify
 * BULK ACTIONS: apply one decision to many selected reports at once from
 * the Admin Panel. Each report is individually state-scope-checked and
 * still runs through the same cluster-cascade + reporter-trust logic as
 * the single-report endpoint. Body:
 * { ids: [reportId, ...], verificationStatus, adminNotes }
 */
router.patch("/bulk-verify", authenticate, requireRole("district_admin"), async (req, res) => {
  try {
    const { ids, verificationStatus, adminNotes } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids must be a non-empty array" });
    if (ids.length > 200) return res.status(400).json({ error: "Bulk action limited to 200 reports at a time" });

    const io = req.app.get("io");
    const allUpdated = [];
    const alreadyHandled = new Set(); // avoid re-processing a report already covered by an earlier cluster cascade in this same batch
    const skipped = [];

    for (const id of ids) {
      if (alreadyHandled.has(id)) continue;
      const existing = await Report.findById(id);
      if (!existing) {
        skipped.push({ id, reason: "not_found" });
        continue;
      }
      if (req.user.role !== "super_admin" && req.user.state && existing.state !== req.user.state) {
        skipped.push({ id, reason: "out_of_state" });
        continue;
      }
      const updated = await verifyReport(id, { verificationStatus, verifiedBy: req.user.email, adminNotes });
      if (updated) {
        updated.forEach((r) => {
          alreadyHandled.add(String(r._id));
          if (!allUpdated.some((u) => String(u._id) === String(r._id))) allUpdated.push(r);
        });
      }
    }

    allUpdated.forEach((r) => io.emit("report:updated", r.toObject()));

    await logAction({
      action: "report_bulk_verify",
      user: req.user,
      detail: { requestedCount: ids.length, updatedCount: allUpdated.length, skipped, verificationStatus },
      ip: req.ip,
    });

    res.json({ updatedCount: allUpdated.length, updatedReports: allUpdated, skipped });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
