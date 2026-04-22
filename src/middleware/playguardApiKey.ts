import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';
import { cachedGet } from '../lib/cache';

type PlayguardTenantRow = {
  tenant_id: string;
};

function extractApiKey(req: Request): string | undefined {
  const raw = req.headers['x-api-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/**
 * PLAYGUARD auth middleware
 * - Reads `x-api-key`
 * - Validates against `playguard_tenants` table in Supabase
 * - Falls back to static PG_API_KEY env var for dev/bootstrap
 * - Sets `req.tenant_id` from the matched row
 */
export async function playguardApiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === 'OPTIONS') return next();

  const apiKey = extractApiKey(req);
  console.log('[PLAYGUARD-AUTH] key:', apiKey?.slice(0, 12));

  if (!apiKey) {
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  // Static fallback: PG_API_KEY env var (for dev / bootstrap before DB row exists)
  const staticKey = process.env.PG_API_KEY;
  if (staticKey && apiKey === staticKey) {
    req.tenant_id = process.env.PG_TENANT_ID || 'playguard-demo';
    console.log('[PLAYGUARD-AUTH] static key accepted, tenant:', req.tenant_id);
    return next();
  }

  if (!supabase) {
    next(new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured'));
    return;
  }

  let tenant: PlayguardTenantRow | null = null;
  try {
    tenant = await cachedGet<PlayguardTenantRow | null>(
      `playguard-tenant-by-key:${apiKey}`,
      async () => {
        const { data, error } = await supabase!
          .from('playguard_tenants')
          .select('tenant_id')
          .eq('api_key', apiKey)
          .maybeSingle();

        if (error) {
          throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
        }

        return (data as PlayguardTenantRow | null) ?? null;
      },
      300
    );
  } catch (e) {
    next(e);
    return;
  }

  console.log('[PLAYGUARD-AUTH] tenant found:', tenant?.tenant_id);

  if (!tenant?.tenant_id) {
    console.log('[PLAYGUARD-AUTH] REJECTING key:', apiKey?.slice(0, 12));
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  req.tenant_id = tenant.tenant_id;
  next();
}
