import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  cleanBase64,
  enrollFaceToCollection,
  searchFaceInCollection,
  deleteFaceFromCollection,
  describeCollectionSize,
} from '../services/rekognitionService';
import { supabase } from '../services/supabaseService';
import { compressImageForRekognition } from '../lib/imageUtils';
import { AppError } from '../types';

const COLLECTION_AUTHORIZED  = process.env.SG_COLLECTION_AUTHORIZED  ?? 'hv-siteguard-authorized';
const COLLECTION_BLACKLISTED = process.env.SG_COLLECTION_BLACKLISTED ?? 'hv-siteguard-blacklisted';
const AUTHORIZED_THRESHOLD   = Number(process.env.SG_AUTHORIZED_THRESHOLD  ?? 85);
const BLACKLIST_THRESHOLD    = Number(process.env.SG_BLACKLIST_THRESHOLD   ?? 90);

const router = Router();

router.use((req, _res, next) => {
  console.log('[SITEGUARD] route hit:', req.method, req.path, 'key:', req.headers['x-api-key']?.toString().slice(0, 12));
  next();
});

// ── Zod schemas ────────────────────────────────────────────────────────────────

const scanSchema = z.object({
  selfie_b64:  z.string().min(1),
  worker_id:   z.string().optional(),
  site_id:     z.string().optional(),
});

const enrollSchema = z.object({
  selfie_b64:     z.string().min(1),
  external_id:    z.string().min(1),
  name:           z.string().min(1),
  role:           z.string().optional().default(''),
  site_id:        z.string().optional().default(''),
  certifications: z.array(z.string()).optional().default([]),
});

const blacklistSchema = z.object({
  selfie_b64:  z.string().min(1),
  external_id: z.string().min(1),
  reason:      z.string().min(1),
  operator:    z.string().min(1),
});

// ── POST /scan ─────────────────────────────────────────────────────────────────

router.post('/scan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, worker_id, site_id } = scanSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'siteguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));

    const [blacklistResult, authorizedResult] = await Promise.allSettled([
      searchFaceInCollection(imageBytes, COLLECTION_BLACKLISTED, BLACKLIST_THRESHOLD),
      searchFaceInCollection(imageBytes, COLLECTION_AUTHORIZED,  AUTHORIZED_THRESHOLD),
    ]);

    const blacklist  = blacklistResult.status  === 'fulfilled' ? blacklistResult.value  : null;
    const authorized = authorizedResult.status === 'fulfilled' ? authorizedResult.value : null;

    // Priority: BLACKLISTED > UNAUTHORIZED > AUTHORIZED
    let verdict: 'AUTHORIZED' | 'UNAUTHORIZED' | 'BLACKLISTED';
    if (blacklist?.faceId)   verdict = 'BLACKLISTED';
    else if (authorized?.faceId) verdict = 'AUTHORIZED';
    else                         verdict = 'UNAUTHORIZED';

    const scanId    = randomUUID();
    const timestamp = new Date().toISOString();

    const result = {
      scanId,
      workerId:  worker_id ?? null,
      siteId:    site_id   ?? null,
      verdict,
      access:    verdict === 'AUTHORIZED',
      authorized: {
        detected:    Boolean(authorized?.faceId),
        faceId:      authorized?.faceId      ?? null,
        externalId:  authorized?.externalImageId ?? null,
        similarity:  authorized?.similarity   ?? null,
      },
      blacklist: {
        detected:    Boolean(blacklist?.faceId),
        faceId:      blacklist?.faceId       ?? null,
        externalId:  blacklist?.externalImageId ?? null,
        similarity:  blacklist?.similarity    ?? null,
      },
      faceConfidence: authorized?.similarity ?? blacklist?.similarity ?? 0,
      timestamp,
    };

    if (supabase) {
      supabase.from('siteguard_events').insert({
        id:               scanId,
        tenant_id:        tenantId,
        worker_id:        worker_id  ?? null,
        site_id:          site_id    ?? null,
        verdict,
        blacklist_sim:    blacklist?.similarity  ?? null,
        authorized_sim:   authorized?.similarity ?? null,
        face_confidence:  result.faceConfidence,
        scanned_at:       timestamp,
      }).then(
        ({ error: e }) => { if (e) console.error('[SITEGUARD] event insert failed:', e.message); },
        () => {}
      );
    }

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

// ── POST /enroll ───────────────────────────────────────────────────────────────

router.post('/enroll', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, external_id, name, role, site_id, certifications } = enrollSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'siteguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));
    const enrolled   = await enrollFaceToCollection(imageBytes, external_id, COLLECTION_AUTHORIZED);

    if (!enrolled) {
      res.status(422).json({ success: false, error: 'FACE_NOT_DETECTED', message: 'No face detected in image' });
      return;
    }

    const enrolledAt = new Date().toISOString();

    if (supabase) {
      const { error: e } = await supabase.from('siteguard_workers').upsert({
        face_id:        enrolled.faceId,
        tenant_id:      tenantId,
        external_id,
        name,
        role,
        site_id,
        certifications,
        enrolled_at:    enrolledAt,
      });
      if (e) console.error('[SITEGUARD] worker insert failed:', e.message);
    }

    res.status(201).json({ success: true, faceId: enrolled.faceId, externalId: external_id, name, role, siteId: site_id, enrolledAt });
  } catch (error) {
    next(error);
  }
});

// ── POST /blacklist ────────────────────────────────────────────────────────────

router.post('/blacklist', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, external_id, reason, operator } = blacklistSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'siteguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));
    const enrolled   = await enrollFaceToCollection(imageBytes, external_id, COLLECTION_BLACKLISTED);

    if (!enrolled) {
      res.status(422).json({ success: false, error: 'FACE_NOT_DETECTED', message: 'No face detected in image' });
      return;
    }

    const bannedAt = new Date().toISOString();

    if (supabase) {
      const { error: e } = await supabase.from('siteguard_blacklist').upsert({
        face_id:     enrolled.faceId,
        tenant_id:   tenantId,
        external_id,
        reason,
        operator,
        banned_at:   bannedAt,
      });
      if (e) console.error('[SITEGUARD] blacklist insert failed:', e.message);
    }

    res.status(201).json({ success: true, faceId: enrolled.faceId, externalId: external_id, reason, bannedAt });
  } catch (error) {
    next(error);
  }
});

// ── DELETE /enroll/:faceId ─────────────────────────────────────────────────────

router.delete('/enroll/:faceId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { faceId } = req.params;
    const tenantId   = req.tenant_id ?? 'siteguard-demo';

    await deleteFaceFromCollection(faceId, COLLECTION_AUTHORIZED);

    if (supabase) {
      await supabase.from('siteguard_workers').delete().eq('face_id', faceId).eq('tenant_id', tenantId);
    }

    res.json({ success: true, faceId });
  } catch (error) {
    next(error);
  }
});

// ── DELETE /blacklist/:faceId ──────────────────────────────────────────────────

router.delete('/blacklist/:faceId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { faceId } = req.params;
    const tenantId   = req.tenant_id ?? 'siteguard-demo';

    await deleteFaceFromCollection(faceId, COLLECTION_BLACKLISTED);

    if (supabase) {
      await supabase.from('siteguard_blacklist').delete().eq('face_id', faceId).eq('tenant_id', tenantId);
    }

    res.json({ success: true, faceId });
  } catch (error) {
    next(error);
  }
});

// ── GET /blacklist ─────────────────────────────────────────────────────────────

router.get('/blacklist', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'siteguard-demo';
    const limit    = Math.min(Number(req.query.limit ?? 100), 500);

    if (!supabase) {
      res.json({ success: true, blacklist: [], source: 'unavailable' });
      return;
    }

    const { data, error } = await supabase
      .from('siteguard_blacklist')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('banned_at', { ascending: false })
      .limit(limit);

    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ success: true, blacklist: data ?? [], source: 'supabase' });
  } catch (error) {
    next(error);
  }
});

// ── GET /status ────────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [authorizedCount, blacklistedCount] = await Promise.allSettled([
      describeCollectionSize(COLLECTION_AUTHORIZED),
      describeCollectionSize(COLLECTION_BLACKLISTED),
    ]).then(r => r.map(v => v.status === 'fulfilled' ? v.value : 0));

    res.json({
      success:             true,
      collectionAuthorized:  COLLECTION_AUTHORIZED,
      collectionBlacklisted: COLLECTION_BLACKLISTED,
      authorizedCount,
      blacklistedCount,
      authorizedThreshold:   AUTHORIZED_THRESHOLD,
      blacklistThreshold:    BLACKLIST_THRESHOLD,
      awsRegion:             process.env.AWS_REGION ?? 'af-south-1',
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /events ────────────────────────────────────────────────────────────────

router.get('/events', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'siteguard-demo';
    const verdict  = req.query.verdict as string | undefined;
    const siteId   = req.query.site_id as string | undefined;
    const limit    = Math.min(Number(req.query.limit ?? 50), 200);

    if (!supabase) {
      res.json({ success: true, events: [], source: 'unavailable' });
      return;
    }

    let query = supabase
      .from('siteguard_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('scanned_at', { ascending: false })
      .limit(limit);

    if (verdict) query = query.eq('verdict', verdict);
    if (siteId)  query = query.eq('site_id', siteId);

    const { data, error } = await query;
    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ success: true, events: data ?? [], source: 'supabase' });
  } catch (error) {
    next(error);
  }
});

// ── GET /workers ───────────────────────────────────────────────────────────────

router.get('/workers', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'siteguard-demo';
    const siteId   = req.query.site_id as string | undefined;
    const limit    = Math.min(Number(req.query.limit ?? 100), 500);

    if (!supabase) {
      res.json({ success: true, workers: [], source: 'unavailable' });
      return;
    }

    let query = supabase
      .from('siteguard_workers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('enrolled_at', { ascending: false })
      .limit(limit);

    if (siteId) query = query.eq('site_id', siteId);

    const { data, error } = await query;
    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ success: true, workers: data ?? [], source: 'supabase' });
  } catch (error) {
    next(error);
  }
});

export default router;
