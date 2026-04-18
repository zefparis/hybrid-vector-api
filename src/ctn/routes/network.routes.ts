import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { NetworkService } from '../services/network.service';
import { supabase } from '../../services/supabaseService';
import { AppError } from '../../types';

const router = Router();
const networkService = new NetworkService();

const joinSchema = z.object({
  institution_name: z.string().min(2, 'institution_name must be at least 2 characters'),
  cname_domain: z
    .string()
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i,
      'cname_domain must be a valid domain (e.g. node.example.com)',
    ),
  tier: z.enum(['shadow', 'standard', 'enterprise']),
});

// POST /ctn/join
router.post('/ctn/join', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      throw new AppError(400, 'VALIDATION_ERROR', msg);
    }

    const result = await networkService.joinNetwork(parsed.data);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// GET /ctn/nodes
router.get('/ctn/nodes', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawKey = req.headers['x-api-key'];
    const apiKey = typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;

    if (!apiKey) {
      throw new AppError(401, 'MISSING_API_KEY', 'x-api-key header is required');
    }

    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    const { data: caller, error: callerError } = await client
      .from('ctn_nodes')
      .select('id, status')
      .eq('api_key', apiKey)
      .maybeSingle();

    if (callerError) {
      throw new AppError(500, 'DB_QUERY_FAILED', callerError.message);
    }
    if (!caller) {
      throw new AppError(401, 'INVALID_API_KEY', 'Invalid or unrecognised API key');
    }
    if (caller.status !== 'active') {
      throw new AppError(403, 'NODE_NOT_ACTIVE', 'Your node is not yet active in the CTN');
    }

    const { data: nodes, error } = await client
      .from('ctn_nodes')
      .select('id, institution_name, tier, status, last_seen')
      .eq('status', 'active')
      .order('joined_at', { ascending: false });

    if (error) {
      throw new AppError(500, 'DB_QUERY_FAILED', error.message);
    }

    const result = (nodes ?? []).map((n) => ({
      node_id: n.id,
      institution_name: n.institution_name,
      tier: n.tier,
      status: n.status,
      last_seen: n.last_seen ?? null,
    }));

    res.json({ nodes: result, count: result.length });
  } catch (e) {
    next(e);
  }
});

export default router;
