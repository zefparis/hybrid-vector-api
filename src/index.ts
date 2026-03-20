import express, { Express, Request, Response, NextFunction } from 'express';
import { config } from './config';
import { apiKeyMiddleware } from './middleware/apiKey';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import sessionRouter from './routes/session';
import enrollRouter from './routes/enroll';
import edguardRouter from './routes/edguard';

const app: Express = express();

// ─── CORS ────────────────────────────────────────────────────────────────────

const VERCEL_APP_REGEX = /^https:\/\/[^.]+\.vercel\.app$/;

const STATIC_ALLOWED_ORIGINS: readonly string[] = [
  'https://hybrid-vector-frontend.vercel.app',
  'https://hybrid-vector.com',
  'https://www.hybrid-vector.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

function buildAllowedOrigins(): Set<string> {
  const set = new Set<string>(STATIC_ALLOWED_ORIGINS);
  if (config.ALLOWED_ORIGINS) {
    config.ALLOWED_ORIGINS.split(',').forEach(o => {
      const trimmed = o.trim();
      if (trimmed) set.add(trimmed);
    });
  }
  return set;
}

function isOriginAllowed(origin: string): boolean {
  if (VERCEL_APP_REGEX.test(origin)) return true;
  return buildAllowedOrigins().has(origin);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

app.use(healthRouter);

app.use(apiKeyMiddleware);
app.use(sessionRouter);
app.use(enrollRouter);
app.use('/edguard', apiKeyMiddleware, edguardRouter);

app.use(errorHandler);

const PORT = config.PORT;

app.listen(PORT, () => {
  console.log(`🚀 hv-api running on port ${PORT}`);
  console.log(`📍 Environment: ${config.NODE_ENV}`);

  // Pre-warm deepface-api 30s after startup
  setTimeout(async () => {
    try {
      await fetch(`${config.DEEPFACE_API_URL}/health`);
      console.log('deepface-api pre-warmed on startup');
    } catch {}
  }, 30000);

  // Keep deepface-api warm - ping every 2 minutes
  setInterval(async () => {
    try {
      await fetch(`${config.DEEPFACE_API_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      console.log('deepface-api keep-alive ping OK');
    } catch {
      console.log('deepface-api keep-alive ping failed - cold start expected');
    }
  }, 2 * 60 * 1000);
});

export default app;
