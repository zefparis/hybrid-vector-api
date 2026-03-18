import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AppError } from '../types';

export function apiKeyMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    next(new AppError(403, 'MISSING_API_KEY', 'X-API-Key header is required'));
    return;
  }

  if (apiKey !== config.HV_API_KEY) {
    next(new AppError(403, 'INVALID_API_KEY', 'Invalid API key'));
    return;
  }

  next();
}
