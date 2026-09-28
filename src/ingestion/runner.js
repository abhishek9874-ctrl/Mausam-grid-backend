const { generateSyntheticReport, INDIA_CITIES } = require("./simulator");
const { ingestReport } = require("../services/ingestService");

let running = false;
let timer = null;
let hotspotUntil = 0;
let activeHotspot = null;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * @param {import('socket.io').Server} io
 * @param {number} ratePerMinute
 */
function startSimulator(io, ratePerMinute = 30) {
  if (running) return;
  running = true;
  const tickMs = 6000;
  const perTick = Math.max(1, Math.round((ratePerMinute * tickMs) / 60000));

  timer = setInterval(async () => {
    try {
      for (let i = 0; i < perTick; i++) {
        const roll = Math.random();
        let payload;

        // Occasionally spin up a short-lived "hotspot" so the Emerging
        // Event Radar has something real to detect in a demo/dev session.
        if (Date.now() > hotspotUntil && Math.random() < 0.03) {
          const [city, state, lat, lon] = pick(INDIA_CITIES);
          activeHotspot = { city, state, lat, lon, eventCategory: pick(["flooding", "thunderstorm", "strong_wind", "rainfall"]) };
          hotspotUntil = Date.now() + 5 * 60000;
        }

        if (activeHotspot && Date.now() < hotspotUntil && roll < 0.55) {
          payload = generateSyntheticReport({ forceHotspot: activeHotspot });
        } else if (roll < 0.08) {
          payload = generateSyntheticReport({ forceFake: true });
        } else {
          payload = generateSyntheticReport();
        }

        const report = await ingestReport(payload);
        io.emit("report:new", report.toObject());
      }
    } catch (err) {
      console.error("[simulator] tick failed:", err.message);
    }
  }, tickMs);

  console.log(`[simulator] started at ~${ratePerMinute} reports/min`);
}

function stopSimulator() {
  running = false;
  clearInterval(timer);
  timer = null;
  console.log("[simulator] stopped");
}

function isRunning() {
  return running;
}

module.exports = { startSimulator, stopSimulator, isRunning };
