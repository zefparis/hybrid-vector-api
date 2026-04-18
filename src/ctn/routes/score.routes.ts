import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CTSService } from '../services/cts.service';
import { AppError } from '../../types';

const router = Router();
const ctsService = new CTSService();

const computeSchema = z.object({
  user_identifier: z.string().min(4, 'user_identifier must be at least 4 characters'),
});

function extractApiKey(req: Request): string {
  const raw = req.headers['x-api-key'];
  const key = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!key) throw new AppError(401, 'MISSING_API_KEY', 'x-api-key header is required');
  return key;
}

// POST /ctn/score
router.post('/ctn/score', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);

    const parsed = computeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      throw new AppError(400, 'VALIDATION_ERROR', msg);
    }

    const result = await ctsService.computeScore(apiKey, parsed.data.user_identifier);
    res.status(200).json(result);
  } catch (e) {
    next(e);
  }
});

// GET /ctn/score/:user_hash
router.get('/ctn/score/:user_hash', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);
    const { user_hash } = req.params;

    const result = await ctsService.getScore(apiKey, user_hash);
    if (!result) {
      throw new AppError(404, 'SCORE_NOT_FOUND', `No score found for user_hash: ${user_hash}`);
    }

    res.status(200).json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
