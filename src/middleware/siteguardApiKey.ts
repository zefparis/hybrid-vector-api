import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';
import { cachedGet } from '../lib/cache';

type SiteguardTenantRow = {
  tenant_id: string;
};

function extractApiKey(req: Request): string | undefined {
  const raw = req.headers['x-api-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/**
 * SITEGUARD auth middleware
 * - Reads `x-api-key`
 * - Validates against `siteguard_tenants` table in Supabase
 * - Falls back to static SG_API_KEY env var for dev/bootstrap
 * - Sets `req.tenant_id` from the matched row
 */
export async function siteguardApiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === 'OPTIONS') return next();

  const apiKey = extractApiKey(req);
  console.log('[SITEGUARD-AUTH] key:', apiKey?.slice(0, 12));

  if (!apiKey) {
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  // Static fallback: SG_API_KEY env var (for dev / bootstrap before DB row exists)
  const staticKey = process.env.SG_API_KEY;
  if (staticKey && apiKey === staticKey) {
    req.tenant_id = process.env.SG_TENANT_ID || 'siteguard-demo';
    console.log('[SITEGUARD-AUTH] static key accepted, tenant:', req.tenant_id);
    return next();
  }

  if (!supabase) {
    next(new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured'));
    return;
  }

  let tenant: SiteguardTenantRow | null = null;
  try {
    tenant = await cachedGet<SiteguardTenantRow | null>(
      `siteguard-tenant-by-key:${apiKey}`,
      async () => {
        const { data, error } = await supabase!
          .from('siteguard_tenants')
          .select('tenant_id')
          .eq('api_key', apiKey)
          .maybeSingle();

        if (error) {
          throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
        }

        return (data as SiteguardTenantRow | null) ?? null;
      },
      300
    );
  } catch (e) {
    next(e);
    return;
  }

  console.log('[SITEGUARD-AUTH] tenant found:', tenant?.tenant_id);

  if (!tenant?.tenant_id) {
    console.log('[SITEGUARD-AUTH] REJECTING key:', apiKey?.slice(0, 12));
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  req.tenant_id = tenant.tenant_id;
  next();
}
