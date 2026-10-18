// LeadGuard server entry point: security middleware, API routes, webhooks, static client, worker.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { errorHandler } from './lib/http.js';
import { loadSession, csrfGuard } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import webhookRoutes from './routes/webhooks.js';
import teamRoutes from './routes/team.js';
import crmRoutes from './routes/crm.js';
import oppRoutes from './routes/opportunities.js';
import configRoutes from './routes/config.js';
import leadRoutes from './routes/leads.js';
import integrationRoutes from './routes/integrations.js';
import engageRoutes, { oauthRouter } from './routes/engage.js';
import { startWorker } from './services/worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = express();
app.set('trust proxy', 1); // Render / tunnels terminate HTTPS in front of us
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: config.isProd ? {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
}));

// Health check (used by Render and to verify the database connection)
app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS db_time');
    res.json({ ok: true, dbTime: rows[0].db_time });
  } catch (err) {
    res.status(503).json({ ok: false, error: `Database not reachable: ${err.message}` });
  }
});

// Webhooks need their raw/urlencoded bodies, so they are mounted before the JSON parser.
app.use('/webhooks', webhookRoutes);

app.use(express.json({ limit: '200kb' }));
app.use(loadSession);
app.use('/oauth', oauthRouter);
app.use('/api/public', publicRoutes);
app.use('/api', csrfGuard);
app.use('/api/auth', authRoutes);
app.use('/api', teamRoutes, crmRoutes, oppRoutes, configRoutes, leadRoutes, integrationRoutes, engageRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
app.use(errorHandler);

async function start() {
  console.log('[db] applying schema...');
  await migrate();
  if (config.isProd) {
    const dist = path.join(root, 'client/dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) console.warn('[web] client/dist missing — run "npm run build" first');
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // Development: Vite serves the React app from the same port (hot reload, no CORS).
    // Config is passed inline (configFile: false) so Vite does not write a temporary bundled config
    // file, which would make `node --watch` restart the server in an endless loop.
    const { createServer } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    const vite = await createServer({
      configFile: false, root: path.join(root, 'client'), plugins: [react()],
      server: { middlewareMode: true }, appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  app.use(errorHandler);
  app.listen(config.port, () => {
    console.log(`\n  LeadGuard running at ${config.appUrl}  (local: http://localhost:${config.port})\n`);
    startWorker();
  });
}

start().catch((e) => {
  console.error('[startup] failed:', e.message);
  if (/ENOTFOUND|ECONNREFUSED|password authentication|getaddrinfo/i.test(e.message)) console.error('  → Check DATABASE_URL in your .env file.');
  process.exit(1);
});
