/**
 * WorkGuard behavioral signals — fire-and-forget ingestion.
 *
 * POST /api/signals
 *   Auth:     none (high-frequency, low-value per-event)
 *   Body:     { channel: string, batch: unknown[], source: string }
 *   Response: { ok: true }
 *
 * Persisted to Supabase table `workguard_signals` (see
 * supabase/migrations/20260424_workguard_signals.sql).
 *
 * NOTE: this endpoint is unauthenticated by design. Add basic safeguards
 * (body size limit, per-IP rate limit at the edge / Fly proxy) before it
 * takes real traffic in production.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../services/supabaseService';

const router = Router();

router.post('/signals', async (req: Request, res: Response) => {
  // Respond early: fire-and-forget — client shouldn't wait on DB write.
  res.status(200).json({ ok: true });

  try {
    const body = (req.body ?? {}) as {
      channel?: unknown;
      batch?: unknown;
      source?: unknown;
    };

    const channel = typeof body.channel === 'string' ? body.channel : 'unknown';
    const source = typeof body.source === 'string' ? body.source : 'unknown';
    const batch = Array.isArray(body.batch) ? body.batch : [];

    if (!supabase) {
      // Supabase not configured — log and drop, don't throw (response is already sent).
      console.warn('[signals] SUPABASE_NOT_CONFIGURED — dropping', { channel, source, size: batch.length });
      return;
    }

    const { error } = await supabase.from('workguard_signals').insert({
      id: randomUUID(),
      channel,
      source,
      batch,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.warn('[signals] insert failed', { channel, source, error: error.message });
    }
  } catch (err) {
    console.warn('[signals] handler error', err instanceof Error ? err.message : err);
  }
});

export default router;
