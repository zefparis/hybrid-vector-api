import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';
import { cachedGet } from '../lib/cache';

type DriveguardTenantRow = { tenant_id: string };

function extractApiKey(req: Request): string | undefined {
  const raw = req.headers['x-api-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

export async function driveguardApiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === 'OPTIONS') return next();

  const apiKey = extractApiKey(req);
  console.log('[DRIVEGUARD-AUTH] key:', apiKey?.slice(0, 12));

  if (!apiKey) {
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  const staticKey = process.env.DG_API_KEY;
  if (staticKey && apiKey === staticKey) {
    req.tenant_id = process.env.DG_TENANT_ID || 'driveguard-demo';
    console.log('[DRIVEGUARD-AUTH] static key accepted, tenant:', req.tenant_id);
    return next();
  }

  if (!supabase) {
    next(new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured'));
    return;
  }

  let tenant: DriveguardTenantRow | null = null;
  try {
    tenant = await cachedGet<DriveguardTenantRow | null>(
      `driveguard-tenant-by-key:${apiKey}`,
      async () => {
        const { data, error } = await supabase!
          .from('driveguard_tenants')
          .select('tenant_id')
          .eq('api_key', apiKey)
          .maybeSingle();
        if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
        return (data as DriveguardTenantRow | null) ?? null;
      },
      300
    );
  } catch (e) {
    next(e);
    return;
  }

  if (!tenant?.tenant_id) {
    console.log('[DRIVEGUARD-AUTH] REJECTING key:', apiKey?.slice(0, 12));
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  req.tenant_id = tenant.tenant_id;
  next();
}
