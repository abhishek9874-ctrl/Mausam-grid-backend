/**
 * ML / NLP pipeline for the National Weather Big Data Analytics Platform.
 *
 * Every ingested report passes through three explainable, rule + lexicon
 * based stages before it is stored:
 *   1. classifyEvent()      -> event category + confidence
 *   2. classifySeverity()   -> low / moderate / severe / extreme
 *   3. scoreCredibility()   -> 0-100 trust score + fake flag
 *   4. findDuplicate()      -> near-duplicate detection against a recent window
 *
 * Production upgrade path (see docs/ARCHITECTURE.md):
 *   - classifyEvent: fine-tuned multilingual transformer (IndicBERT/MuRIL)
 *   - scoreCredibility: gradient-boosted model trained on historical
 *     verified-vs-rejected labels, with network/bot-graph features added
 *   - findDuplicate: MinHash + LSH over Spark for near-constant-time
 *     duplicate candidate lookup at high ingestion volume
 */

const EVENT_LEXICON = {
  flooding: ["flood", "flooded", "flooding", "waterlogged", "waterlogging", "inundat", "submerged", "overflow", "बाढ़", "जलभराव"],
  thunderstorm: ["thunderstorm", "lightning", "thunder", "lightening strike", "gajat", "बिजली", "आंधी तूफान", "squall"],
  rainfall: ["rain", "rainfall", "downpour", "showers", "drizzle", "monsoon", "cloudburst", "बारिश", "वर्षा"],
  heatwave: ["heatwave", "heat wave", "scorching", "extreme heat", "loo", "sunstroke", "लू", "गर्मी"],
  fog: ["fog", "foggy", "mist", "misty", "low visibility", "कोहरा", "धुंध"],
  dust_storm: ["dust storm", "duststorm", "dust-storm", "aandhi", "sandstorm", "धूल भरी आंधी"],
  strong_wind: ["strong wind", "high wind", "gusty wind", "gale", "storm surge", "cyclone", "तेज़ हवा", "चक्रवात"],
  snowfall: ["snowfall", "snowing", "snow", "बर्फबारी"],
};

const SEVERITY_KEYWORDS = {
  extreme: ["extreme", "catastrophic", "red alert", "life-threatening", "severe damage"],
  severe: ["severe", "heavy", "orange alert", "warning", "danger"],
  moderate: ["moderate", "yellow alert", "advisory"],
};

function classifyEvent(text) {
  const t = (text || "").toLowerCase();
  const scores = {};
  for (const [category, keywords] of Object.entries(EVENT_LEXICON)) {
    const hits = keywords.filter((kw) => t.includes(kw.toLowerCase())).length;
    if (hits) scores[category] = hits;
  }
  const entries = Object.entries(scores);
  if (!entries.length) return { category: "other", confidence: 0.35 };

  entries.sort((a, b) => b[1] - a[1]);
  const [bestCategory, bestHits] = entries[0];
  const totalHits = entries.reduce((s, [, v]) => s + v, 0);
  const confidence = Math.min(0.99, 0.55 + 0.15 * bestHits + 0.05 * (totalHits - bestHits));
  return { category: bestCategory, confidence: Math.round(confidence * 100) / 100 };
}

function classifySeverity(text) {
  const t = (text || "").toLowerCase();
  for (const level of ["extreme", "severe", "moderate"]) {
    if (SEVERITY_KEYWORDS[level].some((kw) => t.includes(kw))) return level;
  }
  return "low";
}

const SENSATIONAL_PATTERNS = [
  /\bshare\s+before\s+it'?s\s+deleted\b/i,
  /\bgovernment\s+hiding\b/i,
  /\bthey\s+don'?t\s+want\s+you\s+to\s+know\b/i,
  /!!!+/,
  /breaking\s*:?\s*breaking/i,
];

const CREDIBLE_SOURCE_BONUS = {
  imd_api: 40,
  news_verified: 20,
  citizen_app: 5,
  twitter: 0,
  facebook: -5,
  instagram: -5,
  whatsapp_forward: -20,
};

/**
 * @param {object} p
 * @param {number} [p.reporterTrustScore] - 0-100 running trust score for
 *   this author from ReporterProfile, if one exists yet. This is the
 *   "reporter trust network" feed-back loop: a good track record lifts
 *   the credibility of everything that author files next; a history of
 *   rejected reports drags it down, even before content is examined.
 */
function scoreCredibility({
  source,
  authorVerifiedBadge,
  authorFollowers = 0,
  authorAccountAgeDays = 0,
  hasMedia,
  text,
  latitude,
  longitude,
  reporterTrustScore = null,
}) {
  let score = 50;
  score += CREDIBLE_SOURCE_BONUS[source] ?? -5;

  if (authorVerifiedBadge) score += 15;
  if (authorFollowers >= 10000) score += 8;
  else if (authorFollowers >= 1000) score += 4;
  else if (authorFollowers < 20) score -= 8;

  if (authorAccountAgeDays < 7) score -= 20;
  else if (authorAccountAgeDays < 30) score -= 8;
  else if (authorAccountAgeDays > 365) score += 5;

  if (hasMedia) score += 10;

  const t = (text || "").toLowerCase();
  for (const pattern of SENSATIONAL_PATTERNS) {
    if (pattern.test(t)) score -= 15;
  }
  if ((text || "").trim().length < 8) score -= 10;
  if (text && text === text.toUpperCase() && text.length > 10) score -= 10;

  if (latitude != null && longitude != null) {
    const inIndia = latitude >= 6.0 && latitude <= 37.5 && longitude >= 68.0 && longitude <= 97.5;
    if (!inIndia) score -= 30;
  } else {
    score -= 5;
  }

  // Reporter trust network feedback: blend 25% of the author's historical
  // trust score into this single report's credibility.
  if (reporterTrustScore != null) {
    score = score * 0.75 + reporterTrustScore * 0.25;
  }

  score = Math.max(0, Math.min(100, score));
  const isLikelyFake = score < 35;
  return { score: Math.round(score * 10) / 10, isLikelyFake };
}

const DEDUP_TIME_WINDOW_MIN = 45;
const DEDUP_TEXT_SIMILARITY_THRESHOLD = 0.6;
const DEDUP_GEO_RADIUS_KM = 15;

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// Lightweight Dice/token-overlap similarity — dependency-free stand-in for
// production MinHash/LSH text similarity.
function textSimilarity(a, b) {
  const tok = (s) => new Set(s.toLowerCase().split(/[^a-z0-9\u0900-\u097F]+/).filter(Boolean));
  const sa = tok(a);
  const sb = tok(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

/**
 * @param {object} candidate {text, postedAt, latitude, longitude, city}
 * @param {Array} recentReports - Mongoose docs already filtered by caller
 *   to the same eventCategory and a nearby time window.
 * @returns matching report doc, or null
 */
function findDuplicate(candidate, recentReports) {
  for (const existing of recentReports) {
    if (!existing.postedAt || !candidate.postedAt) continue;
    const deltaMin = Math.abs(candidate.postedAt - existing.postedAt) / 60000;
    if (deltaMin > DEDUP_TIME_WINDOW_MIN) continue;

    let samePlace = existing.city?.toLowerCase() === candidate.city?.toLowerCase();
    const exCoords = existing.location?.coordinates;
    if (!samePlace && exCoords && candidate.longitude != null && candidate.latitude != null) {
      const dist = haversineKm(exCoords[1], exCoords[0], candidate.latitude, candidate.longitude);
      samePlace = dist <= DEDUP_GEO_RADIUS_KM;
    }
    if (!samePlace) continue;

    const sim = textSimilarity(existing.rawText, candidate.text);
    if (sim >= DEDUP_TEXT_SIMILARITY_THRESHOLD) return existing;
  }
  return null;
}

module.exports = {
  classifyEvent,
  classifySeverity,
  scoreCredibility,
  findDuplicate,
  textSimilarity,
  haversineKm,
  DEDUP_TIME_WINDOW_MIN,
};
