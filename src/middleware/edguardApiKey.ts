import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';
import { cachedGet } from '../lib/cache';

type EdguardTenantRow = {
  tenant_id: string;
};

function extractApiKey(req: Request): string | undefined {
  const raw = req.headers['x-api-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

/**
 * EDGUARD auth middleware
 * - Reads `x-api-key`
 * - Validates against `edguard_tenants` table ONLY
 * - Sets `req.tenant_id` from the matched row
 */
export async function edguardApiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === 'OPTIONS') return next();

  const apiKey = extractApiKey(req);
  console.log('[EDGUARD-AUTH] key:', apiKey?.slice(0, 12));

  if (!apiKey) {
    console.log('[EDGUARD-AUTH] REJECTING key:', req.headers['x-api-key']);
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  if (!supabase) {
    next(new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured'));
    return;
  }

  let tenant: EdguardTenantRow | null = null;
  try {
    tenant = await cachedGet<EdguardTenantRow | null>(
      `edguard-tenant-by-key:${apiKey}`,
      async () => {
        const { data, error } = await supabase!
          .from('edguard_tenants')
          .select('tenant_id')
          .eq('api_key', apiKey)
          .maybeSingle();

        if (error) {
          throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
        }

        return (data as EdguardTenantRow | null) ?? null;
      },
      300
    );
  } catch (e) {
    next(e);
    return;
  }
  console.log('[EDGUARD-AUTH] tenant found:', tenant?.tenant_id);

  if (!tenant?.tenant_id) {
    console.log('[EDGUARD-AUTH] REJECTING key:', req.headers['x-api-key']);
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  req.tenant_id = tenant.tenant_id;
  next();
}
