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

// ── Helper: resolve API key from header ──────────────────────────────────────
function extractApiKey(req: Request): string | undefined {
  const raw = req.headers['x-api-key'];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

// DELETE /ctn/node/:node_id — owner-only node deletion
router.delete('/ctn/node/:node_id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);
    if (!apiKey) throw new AppError(401, 'MISSING_API_KEY', 'x-api-key header is required');

    const { node_id } = req.params;

    const client = supabase;
    if (!client) throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');

    // Verify ownership: the api_key must match the target node
    const { data: node, error: fetchError } = await client
      .from('ctn_nodes')
      .select('id')
      .eq('id', node_id)
      .eq('api_key', apiKey)
      .maybeSingle();

    if (fetchError) throw new AppError(500, 'DB_QUERY_FAILED', fetchError.message);
    if (!node) throw new AppError(403, 'FORBIDDEN', 'You do not own this node or it does not exist');

    const { error: deleteError } = await client
      .from('ctn_nodes')
      .delete()
      .eq('id', node_id);

    if (deleteError) throw new AppError(500, 'DB_DELETE_FAILED', deleteError.message);

    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// DELETE /ctn/reset-test — HMH master only: purge all test nodes
router.delete('/ctn/reset-test', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);
    if (!apiKey) throw new AppError(401, 'MISSING_API_KEY', 'x-api-key header is required');

    const client = supabase;
    if (!client) throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');

    // Verify caller is the HMH master node
    const { data: caller, error: callerError } = await client
      .from('ctn_nodes')
      .select('id, institution_name')
      .eq('api_key', apiKey)
      .maybeSingle();

    if (callerError) throw new AppError(500, 'DB_QUERY_FAILED', callerError.message);
    if (!caller) throw new AppError(401, 'INVALID_API_KEY', 'Invalid or unrecognised API key');
    if (caller.institution_name !== 'HMH Cognitive Trust Network') {
      throw new AppError(403, 'FORBIDDEN', 'This endpoint is reserved for the HMH master node');
    }

    // Delete all nodes whose institution_name contains "test" (case-insensitive)
    const { data: deleted, error: deleteError } = await client
      .from('ctn_nodes')
      .delete()
      .ilike('institution_name', '%test%')
      .select('id');

    if (deleteError) throw new AppError(500, 'DB_DELETE_FAILED', deleteError.message);

    res.status(200).json({ deleted: (deleted ?? []).length });
  } catch (e) {
    next(e);
  }
});

export default router;
