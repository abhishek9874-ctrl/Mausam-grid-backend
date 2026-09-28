/**
 * Multi-source ingestion simulator.
 *
 * In production each of these is an independently deployed collector
 * (see docs/ARCHITECTURE.md): a Twitter/X filtered-stream + Facebook/
 * Instagram poller tracking #IMD and ~40 weather hashtags in English and
 * regional languages, a citizen mobile app webhook, a scheduled poller
 * for IMD bulletins and data.gov.in datasets, and RSS/scrapers for
 * regional news. Every collector normalises its payload to the same
 * shape and publishes it onto a `weather.raw_reports` Kafka topic in
 * production; this module plays that role for local development and
 * demos by fabricating realistic, geographically distributed reports
 * (including some fakes and some duplicates so the ML pipeline has
 * something to catch).
 */
const { v4: uuidv4 } = require("uuid");

const INDIA_CITIES = [
  ["Mumbai", "Maharashtra", 19.076, 72.8777],
  ["Delhi", "Delhi", 28.7041, 77.1025],
  ["Bengaluru", "Karnataka", 12.9716, 77.5946],
  ["Chennai", "Tamil Nadu", 13.0827, 80.2707],
  ["Kolkata", "West Bengal", 22.5726, 88.3639],
  ["Hyderabad", "Telangana", 17.385, 78.4867],
  ["Ahmedabad", "Gujarat", 23.0225, 72.5714],
  ["Pune", "Maharashtra", 18.5204, 73.8567],
  ["Jaipur", "Rajasthan", 26.9124, 75.7873],
  ["Lucknow", "Uttar Pradesh", 26.8467, 80.9462],
  ["Bhubaneswar", "Odisha", 20.2961, 85.8245],
  ["Guwahati", "Assam", 26.1445, 91.7362],
  ["Patna", "Bihar", 25.5941, 85.1376],
  ["Chandigarh", "Chandigarh", 30.7333, 76.7794],
  ["Bhopal", "Madhya Pradesh", 23.2599, 77.4126],
  ["Thiruvananthapuram", "Kerala", 8.5241, 76.9366],
  ["Dehradun", "Uttarakhand", 30.3165, 78.0322],
  ["Srinagar", "Jammu and Kashmir", 34.0837, 74.7973],
  ["Raipur", "Chhattisgarh", 21.2514, 81.6296],
  ["Ranchi", "Jharkhand", 23.3441, 85.3096],
];

const SOURCES = ["twitter", "citizen_app", "imd_api", "facebook", "news_verified", "instagram", "whatsapp_forward"];
const SOURCE_WEIGHTS = [30, 20, 15, 10, 10, 10, 5];

const TEMPLATES = {
  rainfall: [
    "Heavy rainfall since morning in {city}, roads getting wet #IMD #rain",
    "Continuous showers reported in {city}, {state}. #Rainfall #weatherupdate",
    "Cloudburst-like rain near {city} in the last hour, drains overflowing #IMD",
  ],
  flooding: [
    "Waterlogging on main road in {city}, cars stuck #flood #IMD",
    "Flood water entering homes in low-lying areas of {city}, {state} #floodalert",
    "Underpass near {city} completely submerged after heavy rain #IMDwarning",
  ],
  thunderstorm: [
    "Loud thunder and lightning over {city} right now #thunderstorm #IMD",
    "Severe thunderstorm warning issued for {city}, {state} #lightning",
  ],
  heatwave: [
    "Unbearable heat in {city} today, feels like 46C #heatwave #IMD",
    "Heatwave conditions continue in {city}, {state}, advisory issued #loo",
  ],
  fog: [
    "Dense fog reduces visibility on highway near {city} #fog #IMD",
    "Morning fog in {city}, {state} delaying flights and trains",
  ],
  dust_storm: [
    "Dust storm rolling in over {city}, sky turned orange #duststorm #IMD",
    "Strong dust storm warning for {city}, {state} this evening",
  ],
  strong_wind: [
    "Very strong winds uprooting trees in {city} #IMD #storm",
    "Gale force winds reported along coast near {city}, {state}",
  ],
  snowfall: ["Fresh snowfall reported around {city}, visibility dropping #snow #IMD"],
};

const FAKE_INJECTIONS = [
  "BREAKING BREAKING!!! Government hiding real flood death toll in {city}, share before it's deleted!!!",
  "URGENT cyclone will hit {city} tomorrow 100% confirmed, they don't want you to know!!!",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weightedPick(arr, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}
function randomRecentTime(maxMinutesAgo = 180) {
  return new Date(Date.now() - Math.random() * maxMinutesAgo * 60000);
}

/**
 * @param {object} opts
 * @param {object} [opts.forceDuplicateOf] - an existing report-like object to clone the text/location of
 * @param {boolean} [opts.forceFake]
 * @param {object} [opts.forceHotspot] - {city, state, lat, lon, eventCategory} to concentrate reports into,
 *   used by the demo "spike" trigger for the Emerging Event Radar
 */
function generateSyntheticReport(opts = {}) {
  let city, state, lat, lon, event, text, source, followers, acctAge, verifiedBadge;

  if (opts.forceHotspot) {
    ({ city, state, lat, lon, eventCategory: event } = opts.forceHotspot);
    text = pick(TEMPLATES[event] || TEMPLATES.rainfall).replace("{city}", city).replace("{state}", state);
    source = weightedPick(SOURCES, SOURCE_WEIGHTS);
    followers = Math.floor(Math.random() * 50000);
    acctAge = 30 + Math.floor(Math.random() * 3000);
    verifiedBadge = Math.random() < 0.1;
  } else if (opts.forceFake) {
    [city, state, lat, lon] = pick(INDIA_CITIES);
    text = pick(FAKE_INJECTIONS).replace("{city}", city);
    event = "other";
    source = pick(["whatsapp_forward", "twitter"]);
    followers = Math.floor(Math.random() * 15);
    acctAge = Math.floor(Math.random() * 5);
    verifiedBadge = false;
  } else if (opts.forceDuplicateOf) {
    const base = opts.forceDuplicateOf;
    city = base.city;
    state = base.state;
    lat = base.latitude;
    lon = base.longitude;
    text = base.rawText;
    event = base.eventCategory;
    source = weightedPick(SOURCES, SOURCE_WEIGHTS);
    followers = Math.floor(Math.random() * 50000);
    acctAge = 60 + Math.floor(Math.random() * 3000);
    verifiedBadge = Math.random() < 0.1;
  } else {
    [city, state, lat, lon] = pick(INDIA_CITIES);
    event = pick(Object.keys(TEMPLATES));
    text = pick(TEMPLATES[event]).replace("{city}", city).replace("{state}", state);
    source = weightedPick(SOURCES, SOURCE_WEIGHTS);
    followers = Math.floor(Math.random() * 200000);
    acctAge = 1 + Math.floor(Math.random() * 4000);
    verifiedBadge = Math.random() < 0.08;
  }

  const latJ = lat + (Math.random() - 0.5) * (opts.forceHotspot ? 0.02 : 0.1);
  const lonJ = lon + (Math.random() - 0.5) * (opts.forceHotspot ? 0.02 : 0.1);
  const hasMedia = Math.random() < 0.55;

  return {
    externalId: uuidv4(),
    source,
    sourceUrl: `https://example-social.invalid/status/${Math.floor(Math.random() * 1e10)}`,
    authorHandle: `user_${Math.floor(Math.random() * 99999)}`,
    authorFollowers: followers,
    authorAccountAgeDays: acctAge,
    authorVerifiedBadge: verifiedBadge,
    rawText: text,
    hashtags: ["#IMD", "#weather", `#${event}`],
    postedAt: opts.forceHotspot ? randomRecentTime(15) : randomRecentTime(180),
    city,
    state,
    latitude: Math.round(latJ * 10000) / 10000,
    longitude: Math.round(lonJ * 10000) / 10000,
    mediaPhotoUrl: hasMedia && Math.random() < 0.8 ? `https://picsum.photos/seed/${Math.floor(Math.random() * 99999)}/480/320` : undefined,
  };
}

module.exports = { generateSyntheticReport, INDIA_CITIES, SOURCES, TEMPLATES };
