import { z } from 'zod';

const envSchema = z.object({
  DEEPFACE_API_URL: z.string().url(),
  DEEPFACE_API_KEY: z.string().min(1),
  DEEPFACE_HMAC_SECRET: z.string().optional(),
  DEEPFACE_DETECTOR_BACKEND: z.string().default('opencv'),
  HCS_API_URL: z.string().url(),
  HCS_API_KEY: z.string().min(1),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  HV_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(3600),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HCS_INGEST_URL: z.string().url().optional(),
  HCS_WORKER_SHARED_SECRET: z.string().min(1).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

function validateEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    result.error.issues.forEach((issue: { path: (string | number)[]; message: string }) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  return result.data;
}

export const config = validateEnv();
