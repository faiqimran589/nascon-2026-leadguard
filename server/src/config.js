// Central configuration. Every value comes from environment variables (.env locally,
// the hosting provider's "Environment" settings in production). Nothing secret lives in code.
import 'dotenv/config';

function required(name, hint) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n[config] Missing environment variable ${name}. ${hint}\n`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT || 3000);
// Render sets RENDER=true, so a deployed server always runs in production mode.
const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

export const config = {
  port,
  isProd,
  databaseUrl: required('DATABASE_URL', 'Copy .env.example to .env and paste your Neon connection string.'),
  encryptionSecret: required('ENCRYPTION_KEY', 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'),
  // Public base URL. Render sets RENDER_EXTERNAL_URL automatically.
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  sessionIdleHours: Number(process.env.SESSION_IDLE_HOURS || 12),
  sessionMaxDays: Number(process.env.SESSION_MAX_DAYS || 7),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 2000),
  runWorker: process.env.RUN_WORKER !== 'false',
};

if (config.encryptionSecret.length < 32) {
  console.error('[config] ENCRYPTION_KEY must be at least 32 characters long.');
  process.exit(1);
}
