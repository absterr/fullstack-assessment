require("dotenv").config();

function requireEnv(key, required = true) {
  if (required && (typeof process.env[key] !== "string" || !process.env[key])) {
    throw new Error(`> ${key} not set, check your env vars`, {
      cause: { [key]: process.env[key] },
    });
  }

  return process.env[key] ?? "";
}

function requireNumericEnv(key, defaultValue) {
  const raw = process.env[key];
  const value = Number(raw ?? defaultValue);
  if (Number.isNaN(value)) {
    throw new Error(`${key} must be a valid number, got: "${raw}"`);
  }

  return value;
}

module.exports = {
  PORT: requireNumericEnv("PORT", 3000),
  DATABASE_URL: requireEnv("DATABASE_URL"),
  REDIS_URL: requireEnv("REDIS_URL"),
  PAYMENT_FAILURE_RATE: requireNumericEnv("PAYMENT_FAILURE_RATE", 0.1),
  PAYMENT_DELAY_MIN_MS: requireNumericEnv("PAYMENT_DELAY_MIN_MS", 50),
  PAYMENT_DELAY_MAX_MS: requireNumericEnv("PAYMENT_DELAY_MAX_MS", 600),
  ADMIN_TOKEN: requireEnv("ADMIN_TOKEN"),
  FRONTEND_ORIGIN: requireEnv("FRONTEND_ORIGIN"),
  WEBHOOK_SECRET: requireEnv("WEBHOOK_SECRET"),
};
