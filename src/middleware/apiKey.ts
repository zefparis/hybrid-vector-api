import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AppError } from '../types';
// NOTE: ce middleware est pour la clé API HV (statique) — il ne doit pas faire de lookup Supabase.

const DEFAULT_TENANT_ID = 'edguard-demo';

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

  // NOTE: pour les requêtes HV, on n’utilise pas la clé EDGUARD (x-api-key)
  // comme lookup dans edguard_tenants — on force le tenant par défaut.
  // Cela évite de mettre en cache une association incohérente.
  req.tenant_id = DEFAULT_TENANT_ID;
  next();
}
