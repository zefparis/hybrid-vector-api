import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ThreatPoolService } from '../services/threat-pool.service';
import { AppError } from '../../types';

const router = Router();
const threatPoolService = new ThreatPoolService();

const threatSchema = z.object({
  pattern: z.string().min(8, 'pattern must be at least 8 characters'),
  vector_type: z.enum(['bot', 'spoofing', 'replay', 'cognitive_attack']),
  severity: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
});

function extractApiKey(req: Request): string {
  const raw = req.headers['x-api-key'];
  const key = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!key) {
    throw new AppError(401, 'MISSING_API_KEY', 'x-api-key header is required');
  }
  return key;
}

// POST /ctn/threat
router.post('/ctn/threat', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);

    const parsed = threatSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      throw new AppError(400, 'VALIDATION_ERROR', msg);
    }

    await threatPoolService.submitThreat(apiKey, parsed.data);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// GET /ctn/feed
router.get('/ctn/feed', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);
    const feed = await threatPoolService.getFeed(apiKey);
    res.json(feed);
  } catch (e) {
    next(e);
  }
});

export default router;
