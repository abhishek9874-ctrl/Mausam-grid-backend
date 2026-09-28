require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const { Server } = require("socket.io");

const { connectDB } = require("./src/db");
const authRouter = require("./src/routes/auth");
const reportsRouter = require("./src/routes/reports");
const statsRouter = require("./src/routes/stats");
const anomaliesRouter = require("./src/routes/anomalies");
const metaRouter = require("./src/routes/meta");
const simulateRouter = require("./src/routes/simulate");
const { startSimulator, isRunning } = require("./src/ingestion/runner");

const PORT = process.env.PORT || 8000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/weather_platform";
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: CORS_ORIGIN, methods: ["GET", "POST", "PATCH"], credentials: true } });

  app.set("io", io);
  app.set("trust proxy", 1); // needed for correct req.ip behind a load balancer / rate limiting to work right
  app.use(helmet());
  app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(mongoSanitize()); // strips $ / . operators from req.body/query/params to block NoSQL injection
  app.use(morgan("dev"));

  app.get("/api/health", (req, res) => res.json({ status: "ok", simulatorRunning: isRunning() }));
  app.use("/api/auth", authRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/anomalies", anomaliesRouter);
  app.use("/api/meta", metaRouter);
  app.use("/api/simulate", simulateRouter);

  io.on("connection", (socket) => {
    socket.emit("connected", { message: "MAUSAM GRID live feed connected" });
  });

  await connectDB(MONGODB_URI);

  server.listen(PORT, () => {
    console.log(`[server] National Weather Big Data Analytics Platform API listening on :${PORT}`);
    if ((process.env.AUTOSTART_SIMULATOR || "false").toLowerCase() === "true") {
      startSimulator(io, 30);
    }
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
