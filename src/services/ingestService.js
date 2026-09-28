const Report = require("../models/Report");
const ReporterProfile = require("../models/ReporterProfile");
const { classifyEvent, classifySeverity, scoreCredibility, findDuplicate, DEDUP_TIME_WINDOW_MIN } = require("../ml/pipeline");

/**
 * SMART TRIAGE — auto-verification for high-confidence trusted reports.
 * Manual review doesn't scale to national volume, so reports that are
 * both (a) from an inherently trustworthy source and (b) score very
 * highly on credibility are auto-verified at ingestion time, skipping
 * the human review queue entirely. Everything else still goes through
 * an admin — this is triage, not blanket automation, which keeps a
 * human accountable for anything genuinely ambiguous.
 */
const AUTO_VERIFY_TRUSTED_SOURCES = ["imd_api", "news_verified"];
const AUTO_VERIFY_MIN_CREDIBILITY = 80;
const AUTO_VERIFIED_BY = "auto-verification-system";

function determineInitialStatus({ isLikelyFake, isDuplicate, source, credibilityScore }) {
  if (isLikelyFake) return { status: "rejected", verifiedBy: null, verifiedAt: null };
  if (isDuplicate) return { status: "needs_review", verifiedBy: null, verifiedAt: null };
  if (AUTO_VERIFY_TRUSTED_SOURCES.includes(source) && credibilityScore >= AUTO_VERIFY_MIN_CREDIBILITY) {
    return { status: "verified", verifiedBy: AUTO_VERIFIED_BY, verifiedAt: new Date() };
  }
  return { status: "pending", verifiedBy: null, verifiedAt: null };
}

/**
 * Ingest one normalised report payload through the full pipeline:
 * classify -> score credibility (incl. reporter trust feedback) ->
 * deduplicate -> persist -> update reporter reputation.
 *
 * @param {object} payload - see routes/reports.js for the expected shape
 * @returns {Promise<Report>} the saved Mongoose document
 */
async function ingestReport(payload) {
  const postedAt = payload.postedAt ? new Date(payload.postedAt) : new Date();
  const { category: eventCategory, confidence: eventConfidence } = classifyEvent(payload.rawText);
  const severity = classifySeverity(payload.rawText);

  let reporterTrustScore = null;
  let reporterProfile = null;
  if (payload.authorHandle) {
    reporterProfile = await ReporterProfile.findOne({ authorHandle: payload.authorHandle });
    if (reporterProfile) reporterTrustScore = reporterProfile.trustScore;
  }

  const hasMedia = Boolean(payload.mediaPhotoUrl || payload.mediaVideoUrl);
  const { score: credibilityScore, isLikelyFake } = scoreCredibility({
    source: payload.source,
    authorVerifiedBadge: payload.authorVerifiedBadge,
    authorFollowers: payload.authorFollowers,
    authorAccountAgeDays: payload.authorAccountAgeDays,
    hasMedia,
    text: payload.rawText,
    latitude: payload.latitude,
    longitude: payload.longitude,
    reporterTrustScore,
  });

  // Deduplication: look at recent reports of the same event category within
  // the dedup time window, then compare text + place.
  const windowStart = new Date(postedAt.getTime() - DEDUP_TIME_WINDOW_MIN * 60000);
  const windowEnd = new Date(postedAt.getTime() + DEDUP_TIME_WINDOW_MIN * 60000);
  const recent = await Report.find({
    eventCategory,
    postedAt: { $gte: windowStart, $lte: windowEnd },
  })
    .sort({ postedAt: -1 })
    .limit(200)
    .lean();

  const duplicateOf = findDuplicate(
    { text: payload.rawText, postedAt, city: payload.city, latitude: payload.latitude, longitude: payload.longitude },
    recent
  );

  const location =
    payload.longitude != null && payload.latitude != null
      ? { type: "Point", coordinates: [payload.longitude, payload.latitude] }
      : undefined;

  const { status: verificationStatus, verifiedBy: autoVerifiedBy, verifiedAt: autoVerifiedAt } = determineInitialStatus({
    isLikelyFake,
    isDuplicate: Boolean(duplicateOf),
    source: payload.source,
    credibilityScore,
  });

  const report = await Report.create({
    externalId: payload.externalId,
    source: payload.source,
    sourceUrl: payload.sourceUrl,
    authorHandle: payload.authorHandle,
    authorFollowers: payload.authorFollowers || 0,
    authorAccountAgeDays: payload.authorAccountAgeDays || 0,
    authorVerifiedBadge: Boolean(payload.authorVerifiedBadge),
    rawText: payload.rawText,
    hashtags: payload.hashtags || [],
    postedAt,
    city: payload.city,
    state: payload.state,
    location,
    mediaPhotoUrl: payload.mediaPhotoUrl,
    mediaVideoUrl: payload.mediaVideoUrl,
    hasMedia,
    eventCategory,
    eventConfidence,
    severity,
    credibilityScore,
    isLikelyFake,
    isDuplicate: Boolean(duplicateOf),
    duplicateOfId: duplicateOf ? duplicateOf._id : null,
    clusterId: duplicateOf ? duplicateOf.clusterId || String(duplicateOf._id) : null,
    verificationStatus,
    verifiedBy: autoVerifiedBy,
    verifiedAt: autoVerifiedAt,
  });

  if (payload.authorHandle) {
    await ReporterProfile.findOneAndUpdate(
      { authorHandle: payload.authorHandle },
      {
        $inc: { totalReports: 1 },
        $set: { source: payload.source, lastReportAt: postedAt },
        $setOnInsert: { trustScore: 50 },
      },
      { upsert: true }
    );
  }

  return report;
}

/**
 * Apply an admin verification decision. This cascades to every report in
 * the same duplicate cluster (CLUSTER-LEVEL VERIFICATION): reviewing 50
 * duplicate reports of the same flood one-by-one doesn't scale, so
 * verifying (or rejecting) any single report in a cluster applies that
 * same decision to the whole cluster in one write. It also runs the
 * reporter-trust feedback loop for every distinct author in the cluster,
 * nudging their running trust score up or down so their *next* report
 * starts from an adjusted baseline credibility.
 *
 * @returns {Promise<Report[]|null>} every report that was updated
 *   (the target report plus any cluster siblings), primary report first
 */
async function verifyReport(reportId, { verificationStatus, verifiedBy, adminNotes }) {
  const report = await Report.findById(reportId);
  if (!report) return null;

  const clusterKey = report.clusterId || String(report._id);
  const clusterMembers = await Report.find({ $or: [{ clusterId: clusterKey }, { _id: clusterKey }] });
  // ensure the target report itself is included even if it fell outside the $or match somehow
  if (!clusterMembers.some((r) => String(r._id) === String(report._id))) clusterMembers.push(report);

  const now = new Date();
  const cascadeNote =
    clusterMembers.length > 1 && adminNotes
      ? `${adminNotes} (applied via cluster verification)`
      : clusterMembers.length > 1
      ? "Applied via cluster verification"
      : adminNotes;

  await Report.updateMany(
    { _id: { $in: clusterMembers.map((r) => r._id) } },
    { $set: { verificationStatus, verifiedBy, verifiedAt: now, adminNotes: cascadeNote } }
  );

  const delta = verificationStatus === "verified" ? 4 : verificationStatus === "rejected" ? -8 : 0;
  if (delta !== 0) {
    const authorHandles = [...new Set(clusterMembers.map((r) => r.authorHandle).filter(Boolean))];
    for (const authorHandle of authorHandles) {
      const profile = await ReporterProfile.findOneAndUpdate(
        { authorHandle },
        [
          {
            $set: {
              trustScore: { $max: [0, { $min: [100, { $add: [{ $ifNull: ["$trustScore", 50] }, delta] }] }] },
              verifiedReports: { $add: [{ $ifNull: ["$verifiedReports", 0] }, verificationStatus === "verified" ? 1 : 0] },
              rejectedReports: { $add: [{ $ifNull: ["$rejectedReports", 0] }, verificationStatus === "rejected" ? 1 : 0] },
            },
          },
        ],
        { new: true, upsert: true }
      );
      if (profile && profile.trustScore >= 85 && !profile.badges.includes("Trusted Spotter")) {
        profile.badges.push("Trusted Spotter");
        await profile.save();
      }
    }
  }

  const updatedIds = clusterMembers.map((r) => r._id);
  const updatedReports = await Report.find({ _id: { $in: updatedIds } });
  // put the originally-targeted report first so callers can treat it as "the" result
  updatedReports.sort((a, b) => (String(a._id) === String(report._id) ? -1 : String(b._id) === String(report._id) ? 1 : 0));
  return updatedReports;
}

module.exports = { ingestReport, verifyReport };
