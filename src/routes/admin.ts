import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';

const router = Router();

function extractAdminKey(req: Request): string | undefined {
  const raw = req.headers['x-admin-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function requireSupabase() {
  if (!supabase) {
    throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
  }
  return supabase;
}

function adminAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') return next();

  const expected = process.env.HV_ADMIN_KEY;
  const provided = extractAdminKey(req);

  if (!expected) {
    next(new AppError(500, 'HV_ADMIN_KEY_NOT_CONFIGURED', 'HV_ADMIN_KEY is not configured'));
    return;
  }

  if (!provided) {
    next(new AppError(403, 'MISSING_ADMIN_KEY', 'X-Admin-Key header is required'));
    return;
  }

  if (provided !== expected) {
    next(new AppError(403, 'INVALID_ADMIN_KEY', 'Invalid admin key'));
    return;
  }

  next();
}

router.use(adminAuth);

router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const client = requireSupabase();

    const [
      sessionsRes,
      humanRes,
      enrollRes,
      activeTenantsRes,
    ] = await Promise.all([
      client.from('hv_sessions').select('id', { count: 'exact', head: true }),
      client.from('hv_sessions').select('id', { count: 'exact', head: true }).eq('is_human', true),
      client.from('edguard_enrollments').select('student_id', { count: 'exact', head: true }),
      client.from('hv_sessions').select('tenant_id', { count: 'exact', head: true }),
    ]);

    if (sessionsRes.error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', sessionsRes.error.message);
    if (humanRes.error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', humanRes.error.message);
    if (enrollRes.error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', enrollRes.error.message);
    if (activeTenantsRes.error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', activeTenantsRes.error.message);

    const totalSessions = sessionsRes.count ?? 0;
    const humanCount = humanRes.count ?? 0;

    res.json({
      totalSessions,
      humanCount,
      humanRate: totalSessions > 0 ? Math.round((humanCount / totalSessions) * 1000) / 10 : 0,
      totalEnrollments: enrollRes.count ?? 0,
      // Placeholder — distinct tenant count would require a separate query or RPC.
      activeTenants: null,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = requireSupabase();

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const tenant_id = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
    const is_human = typeof req.query.is_human === 'string' ? req.query.is_human : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;

    let q = client
      .from('hv_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (tenant_id) q = q.eq('tenant_id', tenant_id);
    if (is_human === 'true') q = q.eq('is_human', true);
    if (is_human === 'false') q = q.eq('is_human', false);
    if (since) q = q.gte('created_at', since);

    const { data, error } = await q;
    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ sessions: data ?? [] });
  } catch (e) {
    next(e);
  }
});

router.get('/edguard/enrollments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = requireSupabase();

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const tenant_id = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
    const institution_id = typeof req.query.institution_id === 'string' ? req.query.institution_id : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    let q = client
      .from('edguard_enrollments')
      .select('*')
      .order('enrolled_at', { ascending: false })
      .limit(limit);

    if (tenant_id) q = q.eq('tenant_id', tenant_id);
    if (institution_id) q = q.eq('institution_id', institution_id);
    if (search) {
      const term = `%${search.replace(/%/g, '')}%`;
      q = q.or(`student_id.ilike.${term},institution_id.ilike.${term}`);
    }

    const { data, error } = await q;
    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ enrollments: data ?? [] });
  } catch (e) {
    next(e);
  }
});

export default router;
