/**
 * EMERGING EVENT RADAR
 * ---------------------------------------------------------------------
 * This is the platform's headline differentiator. Ordinary weather sites
 * only ever show you two things: a forecast, and (at best) the last
 * officially-confirmed observation. Neither tells you that something is
 * *starting to happen right now* in a specific neighbourhood, before any
 * agency has issued a bulletin about it.
 *
 * Emerging Event Radar watches the *velocity* of incoming citizen +
 * social reports for every (city, event category) pair in a rolling
 * window, compares it against that pair's own recent baseline rate, and
 * — critically — weights the spike by how many *independent* people and
 * platforms are corroborating it (not just one account being retweeted).
 * A location "goes hot" only when report volume is both statistically
 * unusual AND independently corroborated, which is what separates a real
 * emerging flood/storm from a single viral (and possibly fake) post.
 *
 * Output: a ranked list of "hotspots" with a velocity ratio, a
 * corroboration index, and a composite emergingScore, suitable for a
 * live "Early Warning Radar" panel that can beat an official bulletin to
 * the punch by minutes to hours.
 */

const RECENT_WINDOW_MIN = 20;
const BASELINE_WINDOW_MIN = 180;
const MIN_RECENT_REPORTS = 4;
const MIN_VELOCITY_RATIO = 2.2;
const MIN_DISTINCT_AUTHORS = 3;
const MIN_AVG_CREDIBILITY = 40;

/**
 * @param {Array} reports - plain objects or Mongoose docs with:
 *   postedAt (Date), city, state, eventCategory, authorHandle, source,
 *   credibilityScore, isLikelyFake, latitude/longitude or location.coordinates
 * @param {Date} [now]
 */
function computeEmergingEvents(reports, now = new Date()) {
  const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_MIN * 60000);
  const baselineCutoff = new Date(now.getTime() - BASELINE_WINDOW_MIN * 60000);

  const groups = new Map(); // key: city|event -> {recent:[], baselineCount}

  for (const r of reports) {
    const postedAt = r.postedAt instanceof Date ? r.postedAt : new Date(r.postedAt);
    if (postedAt < baselineCutoff || postedAt > now) continue;
    if (r.isLikelyFake) continue; // fake-flagged reports never contribute to a spike

    const key = `${r.city}|||${r.eventCategory}`;
    if (!groups.has(key)) groups.set(key, { city: r.city, state: r.state, eventCategory: r.eventCategory, recent: [], baselineCount: 0 });
    const g = groups.get(key);

    if (postedAt >= recentCutoff) {
      g.recent.push(r);
    } else {
      g.baselineCount += 1;
    }
  }

  const baselineMinutes = BASELINE_WINDOW_MIN - RECENT_WINDOW_MIN;
  const results = [];

  for (const g of groups.values()) {
    const recentCount = g.recent.length;
    if (recentCount < MIN_RECENT_REPORTS) continue;

    const baselineRatePerMin = g.baselineCount / baselineMinutes;
    const expectedRecent = Math.max(baselineRatePerMin * RECENT_WINDOW_MIN, 0.5);
    const velocityRatio = recentCount / expectedRecent;

    const distinctAuthors = new Set(g.recent.map((r) => r.authorHandle)).size;
    const distinctSources = new Set(g.recent.map((r) => r.source)).size;
    const corroborationIndex = Math.min(1, (distinctAuthors + distinctSources * 1.5) / 9);

    const avgCredibility = g.recent.reduce((s, r) => s + (r.credibilityScore ?? 50), 0) / recentCount;

    const emergingScore = velocityRatio * (0.45 + 0.55 * corroborationIndex) * (avgCredibility / 100);

    const isEmerging =
      velocityRatio >= MIN_VELOCITY_RATIO &&
      distinctAuthors >= MIN_DISTINCT_AUTHORS &&
      avgCredibility >= MIN_AVG_CREDIBILITY;

    results.push({
      city: g.city,
      state: g.state,
      eventCategory: g.eventCategory,
      recentCount,
      baselineCount: g.baselineCount,
      velocityRatio: Math.round(velocityRatio * 10) / 10,
      distinctAuthors,
      distinctSources,
      corroborationIndex: Math.round(corroborationIndex * 100) / 100,
      avgCredibility: Math.round(avgCredibility * 10) / 10,
      emergingScore: Math.round(emergingScore * 100) / 100,
      isEmerging,
      sampleTexts: g.recent.slice(0, 3).map((r) => r.rawText),
      windowMinutes: RECENT_WINDOW_MIN,
    });
  }

  results.sort((a, b) => b.emergingScore - a.emergingScore);
  return results;
}

module.exports = { computeEmergingEvents, RECENT_WINDOW_MIN, BASELINE_WINDOW_MIN };
