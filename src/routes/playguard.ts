import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import {
  cleanBase64,
  detectFacesForAge,
  enrollFaceToCollection,
  searchFaceInCollection,
  deleteFaceFromCollection,
  describeCollectionSize,
} from '../services/rekognitionService';
import { supabase } from '../services/supabaseService';
import { compressImageForRekognition } from '../lib/imageUtils';
import { AppError } from '../types';

const PLAYGUARD_BANNED_COLLECTION = 'playguard-banned';
// Default raised to 21 (from 18) to compensate for AWS Rekognition's known
// tendency to over-age children. VERIFY_AGE verdict flags the ambiguous zone.
const DEFAULT_AGE_THRESHOLD = Number(process.env.PG_AGE_THRESHOLD ?? 21);
const DEFAULT_MATCH_THRESHOLD = Number(process.env.PG_MATCH_THRESHOLD ?? 80);

const router = Router();

router.use((req, _res, next) => {
  console.log('[PLAYGUARD] route hit:', req.method, req.path, 'key:', req.headers['x-api-key']?.toString().slice(0, 12));
  next();
});

const scanSchema = z.object({
  selfie_b64: z.string().min(1),
  player_id: z.string().optional(),
  board_id: z.string().optional(),
  platform: z.string().optional(),
});

const banSchema = z.object({
  selfie_b64: z.string().min(1),
  external_id: z.string().min(1),
  reason: z.string().min(1),
  operator: z.string().min(1),
});

router.post('/scan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, player_id, board_id, platform } = scanSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'playguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));

    const [ageResult, banResult] = await Promise.allSettled([
      detectFacesForAge(imageBytes),
      searchFaceInCollection(imageBytes, PLAYGUARD_BANNED_COLLECTION, DEFAULT_MATCH_THRESHOLD),
    ]);

    const age = ageResult.status === 'fulfilled' ? ageResult.value : null;
    const ban = banResult.status === 'fulfilled' ? banResult.value : null;

    if (!age || !age.ageRange) {
      res.status(422).json({ success: false, error: 'NO_FACE_DETECTED', message: 'No face detected in image' });
      return;
    }

    const ageHigh = age.ageRange.High;
    const ageLow  = age.ageRange.Low;
    const isMinor = ageHigh < DEFAULT_AGE_THRESHOLD;
    // Rekognition over-ages children; if Low < 25 and not already a minor by
    // our (conservative) threshold, the estimate is considered uncertain and
    // the operator must verify physical ID.
    const isAmbiguous = ageLow < 25 && !isMinor;
    const isBanned = Boolean(ban?.faceId);

    // Verdict priority: BANNED > MINOR > VERIFY_AGE > ALLOWED
    let verdict: 'ALLOWED' | 'MINOR' | 'BANNED' | 'VERIFY_AGE';
    if (isBanned)           verdict = 'BANNED';
    else if (isMinor)       verdict = 'MINOR';
    else if (isAmbiguous)   verdict = 'VERIFY_AGE';
    else                    verdict = 'ALLOWED';

    const result = {
      scanId: randomUUID(),
      verdict,
      access: verdict === 'ALLOWED',
      age: {
        range: age.ageRange,
        isMinor,
        isAmbiguous,
        threshold: DEFAULT_AGE_THRESHOLD,
        ambiguityNote: isAmbiguous
          ? 'AWS Rekognition age estimate uncertain — physical ID check required'
          : null,
        estimatedAge: Math.round((age.ageRange.Low + age.ageRange.High) / 2),
      },
      ban: {
        detected: isBanned,
        faceId: ban?.faceId ?? null,
        externalId: ban?.externalImageId ?? null,
        similarity: ban?.similarity ?? null,
      },
      faceConfidence: age.confidence,
      timestamp: new Date().toISOString(),
      playerId: player_id ?? null,
      boardId: board_id ?? null,
      platform: platform ?? null,
    };

    if (supabase) {
      supabase.from('playguard_events').insert({
        id: result.scanId,
        tenant_id: tenantId,
        player_id: player_id ?? null,
        board_id: board_id ?? null,
        platform: platform ?? null,
        verdict,
        age_low: age.ageRange.Low,
        age_high: age.ageRange.High,
        is_minor: isMinor,
        ban_detected: isBanned,
        ban_face_id: ban?.faceId ?? null,
        ban_similarity: ban?.similarity ?? null,
        face_confidence: age.confidence,
        scanned_at: result.timestamp,
      }).then(
        ({ error: e }) => { if (e) console.error('[PLAYGUARD] event insert failed:', e.message); },
        () => {}
      );
    }

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.post('/ban', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { selfie_b64, external_id, reason, operator } = banSchema.parse(req.body);
    const tenantId = req.tenant_id ?? 'playguard-demo';

    const imageBytes = await compressImageForRekognition(cleanBase64(selfie_b64));
    const enrolled = await enrollFaceToCollection(imageBytes, external_id, PLAYGUARD_BANNED_COLLECTION);

    if (!enrolled) {
      res.status(422).json({ success: false, error: 'FACE_NOT_DETECTED', message: 'No face detected in image' });
      return;
    }

    const bannedAt = new Date().toISOString();

    if (supabase) {
      const { error: e } = await supabase.from('playguard_bans').upsert({
        face_id: enrolled.faceId,
        tenant_id: tenantId,
        external_id,
        reason,
        operator,
        banned_at: bannedAt,
      });
      if (e) console.error('[PLAYGUARD] ban insert failed:', e.message);
    }

    res.status(201).json({ success: true, faceId: enrolled.faceId, externalId: external_id, bannedAt });
  } catch (error) {
    next(error);
  }
});

router.delete('/ban/:faceId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { faceId } = req.params;
    const tenantId = req.tenant_id ?? 'playguard-demo';

    await deleteFaceFromCollection(faceId, PLAYGUARD_BANNED_COLLECTION);

    if (supabase) {
      await supabase.from('playguard_bans').delete().eq('face_id', faceId).eq('tenant_id', tenantId);
    }

    res.json({ success: true, faceId });
  } catch (error) {
    next(error);
  }
});

router.get('/status', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const faceCount = await describeCollectionSize(PLAYGUARD_BANNED_COLLECTION);

    res.json({
      success: true,
      collection: PLAYGUARD_BANNED_COLLECTION,
      collectionSize: faceCount,
      ageThreshold: DEFAULT_AGE_THRESHOLD,
      matchThreshold: DEFAULT_MATCH_THRESHOLD,
      awsRegion: process.env.AWS_REGION ?? 'eu-west-1',
    });
  } catch (error) {
    next(error);
  }
});

router.get('/events', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'playguard-demo';
    const verdict = req.query.verdict as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    if (!supabase) {
      res.json({ success: true, events: [], source: 'unavailable' });
      return;
    }

    let query = supabase
      .from('playguard_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('scanned_at', { ascending: false })
      .limit(limit);

    if (verdict) query = query.eq('verdict', verdict);

    const { data, error } = await query;
    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ success: true, events: data ?? [], source: 'supabase' });
  } catch (error) {
    next(error);
  }
});

router.get('/bans', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = req.tenant_id ?? 'playguard-demo';
    const limit = Math.min(Number(req.query.limit ?? 100), 500);

    if (!supabase) {
      res.json({ success: true, bans: [] });
      return;
    }

    const { data, error } = await supabase
      .from('playguard_bans')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('banned_at', { ascending: false })
      .limit(limit);

    if (error) throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);

    res.json({ success: true, bans: data ?? [] });
  } catch (error) {
    next(error);
  }
});

export default router;
