import express, { Express, Request, Response, NextFunction } from 'express';
import { config } from './config';
import { apiKeyMiddleware } from './middleware/apiKey';
import { edguardApiKeyMiddleware } from './middleware/edguardApiKey';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import sessionRouter from './routes/session';
import enrollRouter from './routes/enroll';
import edguardRouter from './routes/edguard';
import adminRouter from './routes/admin';
import { ensureCollectionExists } from './services/rekognitionService';

const app: Express = express();

// ─── CORS ────────────────────────────────────────────────────────────────────

const VERCEL_APP_REGEX = /^https:\/\/[^.]+\.vercel\.app$/;

const STATIC_ALLOWED_ORIGINS: readonly string[] = [
  'https://hybrid-vector-frontend.vercel.app',
  'https://hybrid-vector.com',
  'https://www.hybrid-vector.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
  'http://localhost:3005',
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
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-HV-API-Key,X-Tenant-ID');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));

// Root endpoint
app.get('/', (_req: Request, res: Response): void => {
  res.json({
    message: 'API is running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      auth: '/auth/session',
      edguard: '/edguard/*',
    },
  });
});

app.use(healthRouter);

// Admin endpoints (read-only Supabase queries)
app.use('/admin', adminRouter);

// HV core endpoints are protected by the main HV API key middleware
// IMPORTANT: scope it ONLY to /auth/* so it doesn't block /edguard/*
app.use('/auth', apiKeyMiddleware);
app.use(sessionRouter);
app.use(enrollRouter);

// EDGUARD endpoints are protected by EDGUARD tenants keys (edguard_tenants table)
app.use('/edguard', edguardApiKeyMiddleware, edguardRouter);

app.use(errorHandler);

const PORT = config.PORT;

async function bootstrap(): Promise<void> {
  try {
    await ensureCollectionExists();
    console.log('[REKOGNITION] region:', process.env.AWS_REGION || 'eu-central-1');
    console.log('[REKOGNITION] key:', `${process.env.AWS_ACCESS_KEY_ID?.slice(0, 8) ?? ''}...`);
  } catch (error) {
    console.error('[BOOTSTRAP] Rekognition setup failed:', error);
    console.log('[BOOTSTRAP] Continuing without Rekognition...');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 hv-api running on port ${PORT}`);
    console.log(`📍 Environment: ${config.NODE_ENV}`);
    console.log(`📡 Listening on 0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('[BOOTSTRAP] Fatal error:', error);
  process.exit(1);
});

export default app;


