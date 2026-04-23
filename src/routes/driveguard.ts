import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  cleanBase64,
  enrollFaceToCollection,
  searchFaceInCollection,
  deleteFaceFromCollection,
} from '../services/rekognitionService';
import { supabase } from '../services/supabaseService';
import { compressImageForRekognition } from '../lib/imageUtils';
import { driveguardApiKeyMiddleware } from '../middleware/driveguardApiKey';

const COLLECTION_AUTHORIZED  = process.env.DG_COLLECTION_AUTHORIZED  ?? 'hv-driveguard-authorized';
const COLLECTION_BLACKLISTED = process.env.DG_COLLECTION_BLACKLISTED ?? 'hv-driveguard-blacklisted';
const AUTHORIZED_THRESHOLD   = Number(process.env.DG_AUTHORIZED_THRESHOLD ?? 85);
const BLACKLIST_THRESHOLD    = Number(process.env.DG_BLACKLIST_THRESHOLD  ?? 90);

const router = Router();
router.use(driveguardApiKeyMiddleware);

router.use((req, _res, next) => {
  console.log('[DRIVEGUARD] route hit:', req.method, req.path, 'key:', req.headers['x-api-key']?.toString().slice(0, 12));
  next();
});

// ── Zod schemas ───────────────────────────────────────────────────────────────

const scanSchema = z.object({
  selfie_b64: z.string().min(1),
  driver_id:  z.string().optional(),
  vehicle_id: z.string().optional(),
});

const enrollSchema = z.object({
  selfie_b64:  z.string().min(1),
  external_id: z.string().min(1),
  name:        z.string().min(1),
  role:        z.string().optional().default(''),
  vehicle_id:  z.string().optional().default(''),
  licences:    z.array(z.string()).optional().default([]),
});

const blacklistSchema = z.object({
  selfie_b64:  z.string().min(1),
  external_id: z.string().min(1),
  reason:      z.string().min(1),
  operator:    z.string().min(1),
});

// ── POST /scan ────────────────────────────────────────────────────────────────

router.post('/scan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, driver_id, vehicle_id } = scanSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'driveguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));

    const [blacklistResult, authorizedResult] = await Promise.allSettled([
      searchFaceInCollection(imageBytes, COLLECTION_BLACKLISTED, BLACKLIST_THRESHOLD),
      searchFaceInCollection(imageBytes, COLLECTION_AUTHORIZED,  AUTHORIZED_THRESHOLD),
    ]);

    const blacklist  = blacklistResult.status  === 'fulfilled' ? blacklistResult.value  : null;
    const authorized = authorizedResult.status === 'fulfilled' ? authorizedResult.value : null;

    let verdict: 'AUTHORIZED' | 'UNAUTHORIZED' | 'BLACKLISTED';
    if (blacklist?.faceId)       verdict = 'BLACKLISTED';
    else if (authorized?.faceId) verdict = 'AUTHORIZED';
    else                         verdict = 'UNAUTHORIZED';

    const scanId    = randomUUID();
    const timestamp = new Date().toISOString();

    const result = {
      scanId,
      driverId:  driver_id  ?? null,
      vehicleId: vehicle_id ?? null,
      verdict,
      access:    verdict === 'AUTHORIZED',
      authorizedSim:  authorized?.similarity ?? null,
      blacklistSim:   blacklist?.similarity  ?? null,
      faceConfidence: authorized?.similarity ?? blacklist?.similarity ?? 0,
      timestamp,
    };

    if (supabase) {
      supabase.from('driveguard_events').insert({
        id:              scanId,
        tenant_id:       tenantId,
        driver_id:       driver_id  ?? null,
        vehicle_id:      vehicle_id ?? null,
        verdict,
        blacklist_sim:   blacklist?.similarity   ?? null,
        authorized_sim:  authorized?.similarity  ?? null,
        face_confidence: result.faceConfidence,
        scanned_at:      timestamp,
      }).then(
        ({ error: e }) => { if (e) console.error('[DRIVEGUARD] event insert failed:', e.message); },
        () => {}
      );
    }

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

// ── POST /enroll ──────────────────────────────────────────────────────────────

router.post('/enroll', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, external_id, name, role, vehicle_id, licences } = enrollSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'driveguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));
    const enrolled   = await enrollFaceToCollection(imageBytes, external_id, COLLECTION_AUTHORIZED);

    if (!enrolled) {
      res.status(422).json({ success: false, error: 'FACE_NOT_DETECTED', message: 'No face detected in image' });
      return;
    }

    const enrolledAt = new Date().toISOString();

    if (supabase) {
      const { error: e } = await supabase.from('driveguard_drivers').upsert({
        face_id:     enrolled.faceId,
        tenant_id:   tenantId,
        external_id,
        name,
        role,
        vehicle_id,
        licences,
        enrolled_at: enrolledAt,
      });
      if (e) console.error('[DRIVEGUARD] driver insert failed:', e.message);
    }

    res.status(201).json({ success: true, faceId: enrolled.faceId, enrolledAt });
  } catch (error) {
    next(error);
  }
});

// ── DELETE /enroll/:faceId ────────────────────────────────────────────────────

router.delete('/enroll/:faceId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { faceId } = req.params;
    const tenantId   = req.tenant_id ?? 'driveguard-demo';
    await deleteFaceFromCollection(faceId, COLLECTION_AUTHORIZED);
    if (supabase) await supabase.from('driveguard_drivers').delete().eq('face_id', faceId).eq('tenant_id', tenantId);
    res.json({ success: true, faceId });
  } catch (error) {
    next(error);
  }
});

// ── POST /blacklist ───────────────────────────────────────────────────────────

router.post('/blacklist', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, external_id, reason, operator } = blacklistSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'driveguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));
    const enrolled   = await enrollFaceToCollection(imageBytes, external_id, COLLECTION_BLACKLISTED);

    if (!enrolled) {
      res.status(422).json({ success: false, error: 'FACE_NOT_DETECTED', message: 'No face detected in image' });
      return;
    }

    const bannedAt = new Date().toISOString();

    if (supabase) {
      const { error: e } = await supabase.from('driveguard_blacklist').insert({
        face_id:     enrolled.faceId,
        tenant_id:   tenantId,
        external_id,
        reason,
        operator,
        banned_at:   bannedAt,
      });
      if (e) console.error('[DRIVEGUARD] blacklist insert failed:', e.message);
    }

    res.json({ success: true, faceId: enrolled.faceId, bannedAt });
  } catch (error) {
    next(error);
  }
});

// ── GET /blacklist ────────────────────────────────────────────────────────────

router.get('/blacklist', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'driveguard-demo';
    const limit    = Math.min(parseInt(req.query.limit as string) || 100, 500);
    if (!supabase) { res.json({ success: true, blacklist: [] }); return; }
    const { data, error } = await supabase
      .from('driveguard_blacklist')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('banned_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, blacklist: data ?? [] });
  } catch (error) {
    next(error);
  }
});

// ── DELETE /blacklist/:faceId ─────────────────────────────────────────────────

router.delete('/blacklist/:faceId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { faceId } = req.params;
    const tenantId   = req.tenant_id ?? 'driveguard-demo';
    await deleteFaceFromCollection(faceId, COLLECTION_BLACKLISTED);
    if (supabase) await supabase.from('driveguard_blacklist').delete().eq('face_id', faceId).eq('tenant_id', tenantId);
    res.json({ success: true, faceId });
  } catch (error) {
    next(error);
  }
});

// ── GET /drivers ──────────────────────────────────────────────────────────────

router.get('/drivers', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId  = req.tenant_id ?? 'driveguard-demo';
    const limit     = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const vehicleId = req.query.vehicle_id as string | undefined;
    if (!supabase) { res.json({ success: true, drivers: [] }); return; }
    let query = supabase
      .from('driveguard_drivers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('enrolled_at', { ascending: false })
      .limit(limit);
    if (vehicleId) query = query.eq('vehicle_id', vehicleId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, drivers: data ?? [] });
  } catch (error) {
    next(error);
  }
});

// ── GET /events ───────────────────────────────────────────────────────────────

router.get('/events', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId  = req.tenant_id ?? 'driveguard-demo';
    const limit     = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const verdict   = req.query.verdict    as string | undefined;
    const vehicleId = req.query.vehicle_id as string | undefined;
    if (!supabase) { res.json({ success: true, events: [] }); return; }
    let query = supabase
      .from('driveguard_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('scanned_at', { ascending: false })
      .limit(limit);
    if (verdict)   query = query.eq('verdict',    verdict);
    if (vehicleId) query = query.eq('vehicle_id', vehicleId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, events: data ?? [] });
  } catch (error) {
    next(error);
  }
});

export default router;
