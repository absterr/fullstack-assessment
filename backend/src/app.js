const express = require("express");
const cors = require("cors");
const env = require("./config/env");
const productsRoutes = require("./routes/productsRoutes");
const ordersRoutes = require("./routes/ordersRoutes");
const paymentsRoutes = require("./routes/paymentsRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();

app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true,
  }),
);

// Limit request body size to prevent memory exhaustion
app.use(express.json({ limit: "500kb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/products", productsRoutes);
app.use("/orders", ordersRoutes);
app.use("/payments", paymentsRoutes);

app.use("/admin", (req, res, next) => {
  const auth = req.headers["authorization"];
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || token !== env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use("/admin", adminRoutes);

app.use((error, req, res, next) => {
  console.error("Request failed", error);
  const status = error.status || 500;
  res.status(status).json({
    error: status < 500 ? error.message : "Internal server error",
  });
});

module.exports = app;
