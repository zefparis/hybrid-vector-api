import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';

const DEFAULT_TENANT_ID = 'demo-tenant';

// In-memory cache: api_key → tenant_id (avoids DB hit on every request)
const tenantCache = new Map<string, { tenant_id: string; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveTenantId(apiKey: string): Promise<string> {
  const cached = tenantCache.get(apiKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.tenant_id;
  }

  if (supabase) {
    try {
      const { data } = await supabase
        .from('tenants')
        .select('tenant_id')
        .eq('api_key', apiKey)
        .maybeSingle();

      const tenantId = (data as { tenant_id: string } | null)?.tenant_id ?? DEFAULT_TENANT_ID;
      tenantCache.set(apiKey, { tenant_id: tenantId, expiry: Date.now() + CACHE_TTL_MS });
      return tenantId;
    } catch {
      // Supabase lookup failed — fall through to default
    }
  }

  return DEFAULT_TENANT_ID;
}

export async function apiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method === 'OPTIONS') return next();

  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  if (apiKey !== config.HV_API_KEY) {
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  req.tenant_id = await resolveTenantId(typeof apiKey === 'string' ? apiKey : apiKey[0]);
  next();
}
