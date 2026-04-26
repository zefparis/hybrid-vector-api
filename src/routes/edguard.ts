import { createHash, randomBytes, randomUUID } from 'crypto';
import { Buffer } from 'node:buffer';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { cleanBase64, enrollFace, searchFaceByImage, verifyFace } from '../services/rekognitionService';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';
import { config } from '../config';
import { cachedGet, invalidateCache } from '../lib/cache';
import { redis } from '../lib/redis';
import { compressImageForRekognition } from '../lib/imageUtils';

type CognitiveBaseline = {
  stroop_score: number;
  reaction_time_ms: number;
  nback_score: number;
};

type AlertLevel = 'CLEAR' | 'WARNING' | 'ALERT';

interface EdguardEnrollmentRow {
  id?: string;
  tenant_id: string;
  student_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  institution_id?: string | null;
  role?: string | null;
  embedding?: string | number[] | null;
  rekognition_face_id: string | null;
  // Voice biometrics (JSONB + FLOAT in Supabase)
  vocal_embedding?: number[] | null;
  vocal_quality?: number | null;
  // Behavioral profile + Post-quantum fields
  behavioral_profile?: unknown | null;
  pq_public_key?: string | null;
  pq_signature?: string | null;
  cognitive_baseline?: CognitiveBaseline | null;
  enrolled_at: string;
  verified_count?: number;
}

const DEFAULT_TENANT_ID = 'edguard-demo';

function getTenantId(req: Request): string {
  return req.tenant_id ?? DEFAULT_TENANT_ID;
}

interface VerificationResult {
  enrollment: EdguardEnrollmentRow;
  similarity: number;
  verified: boolean;
  liveness: boolean;
  liveness_score: number;
  identity_confidence: number;
}

type RekognitionSearchResult = {
  faceId: string;
  similarity: number;
} | null;

const SESSION_SIMILARITY_THRESHOLD = 80;

const enrollSchema = z.object({
  selfie_b64: z.string().min(1, 'selfie_b64 is required'),
  first_name: z.string().min(1, 'first_name is required'),
  last_name: z.string().min(1, 'last_name is required'),
  email: z.string().email().optional(),
  tenant_id: z.string().min(1, 'tenant_id is required'),
});

const verifySchema = z.object({
  selfie_b64: z.string().min(1, 'selfie_b64 is required'),
  first_name: z.string().min(1, 'first_name is required'),
  last_name: z.string().min(1, 'last_name is required'),
  tenant_id: z.string().min(1, 'tenant_id is required'),
});

const lookupSchema = z.object({
  first_name: z.string().min(1, 'first_name is required'),
  last_name: z.string().min(1, 'last_name is required'),
  tenant_id: z.string().min(1, 'tenant_id is required'),
});

const checkpointSchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  checkpoint_number: z.number().int().positive(),
  face_b64: z.string().min(1, 'face_b64 is required'),
  cognitive_score: z.number().min(0).max(1).optional(),
  session_id: z.string().min(1, 'session_id is required'),
});

const router = Router();

// TEMP DEBUG: confirm the route is hit and the header is present (auth happens at app-level)
router.use((req, _res, next) => {
  console.log('[EDGUARD-DEBUG] route hit, key:', req.headers['x-api-key']);
  next();
});

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(): string {
  let time = Date.now();
  let encodedTime = '';

  for (let i = 9; i >= 0; i -= 1) {
    encodedTime = ULID_ALPHABET[time % 32] + encodedTime;
    time = Math.floor(time / 32);
  }

  const randomPart = randomBytes(16)
    .reduce((acc, byte) => acc + ULID_ALPHABET[byte % 32], '');

  return `${encodedTime}${randomPart}`;
}

function getSupabaseClient() {
  if (!supabase) {
    throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
  }

  return supabase;
}

function sendApiError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
): void {
  res.status(statusCode).json({
    success: false,
    error,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function logEnrollStep(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[ENROLL] step:', step, meta);
}

function logVerifyStep(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[VERIFY] step:', step, meta);
}

async function fetchEnrollmentByFaceId(
  tenantId: string,
  rekognitionFaceId: string,
): Promise<Pick<EdguardEnrollmentRow, 'student_id' | 'first_name' | 'last_name' | 'rekognition_face_id'> | null> {
  const client = getSupabaseClient();
  return cachedGet(
    `edguard-enrollment-by-face:${tenantId}:${rekognitionFaceId}`,
    async () => {
      const { data, error } = await client
        .from('edguard_enrollments')
        .select('student_id, first_name, last_name, rekognition_face_id')
        .eq('tenant_id', tenantId)
        .eq('rekognition_face_id', rekognitionFaceId)
        .maybeSingle();

      if (error) {
        throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
      }

      return (data as Pick<EdguardEnrollmentRow, 'student_id' | 'first_name' | 'last_name' | 'rekognition_face_id'> | null) ?? null;
    },
    300
  );
}

function isCognitiveBaseline(value: unknown): value is CognitiveBaseline {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<CognitiveBaseline>;
  return (
    typeof candidate.stroop_score === 'number' &&
    typeof candidate.reaction_time_ms === 'number' &&
    typeof candidate.nback_score === 'number'
  );
}

function parseCognitiveBaseline(value: unknown): CognitiveBaseline | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (isCognitiveBaseline(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isCognitiveBaseline(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function fetchEnrollment(tenantId: string, studentId: string): Promise<EdguardEnrollmentRow | null> {
  const client = getSupabaseClient();
  return cachedGet(
    `edguard-enrollment:${tenantId}:${studentId}`,
    async () => {
      const { data, error } = await client
        .from('edguard_enrollments')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('student_id', studentId)
        .maybeSingle();

      if (error) {
        throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
      }

      return (data as EdguardEnrollmentRow | null) ?? null;
    },
    60
  );
}

async function lookupEnrollmentByName(
  tenantId: string,
  firstName: string,
  lastName: string,
): Promise<Pick<EdguardEnrollmentRow, 'student_id' | 'first_name' | 'last_name'> | null> {
  const client = getSupabaseClient();
  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName.trim();

  return cachedGet(
    `edguard-enrollment-by-name:${tenantId}:${normalizedFirstName.toLowerCase()}:${normalizedLastName.toLowerCase()}`,
    async () => {
      const { data, error } = await client
        .from('edguard_enrollments')
        .select('student_id, first_name, last_name')
        .eq('tenant_id', tenantId)
        .filter('first_name', 'ilike', normalizedFirstName)
        .filter('last_name', 'ilike', normalizedLastName)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
      }

      return (data as Pick<EdguardEnrollmentRow, 'student_id' | 'first_name' | 'last_name'> | null) ?? null;
    },
    60
  );
}

async function incrementVerifiedCount(
  tenantId: string,
  studentId: string,
  currentCount: number,
  rekognitionFaceId?: string | null
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client
    .from('edguard_enrollments')
    .update({ verified_count: currentCount + 1 })
    .eq('tenant_id', tenantId)
    .eq('student_id', studentId);

  if (error) {
    throw new AppError(500, 'SUPABASE_UPDATE_FAILED', error.message);
  }

  // Invalidation best-effort
  await invalidateCache(`edguard-enrollment:${tenantId}:${studentId}`);
  if (rekognitionFaceId) {
    await invalidateCache(`edguard-enrollment-by-face:${tenantId}:${rekognitionFaceId}`);
  }
}

async function verifyEnrollmentFace(
  tenantId: string,
  studentId: string,
  faceB64: string,
  threshold: number
): Promise<VerificationResult> {
  const enrollment = await fetchEnrollment(tenantId, studentId);

  if (!enrollment) {
    throw new AppError(404, 'STUDENT_NOT_ENROLLED', 'Student is not enrolled');
  }

  if (!enrollment.rekognition_face_id) {
    throw new AppError(500, 'STORED_FACE_ID_MISSING', 'Stored Rekognition face id is missing');
  }

  const faceBytes = Buffer.from(cleanBase64(faceB64), 'base64');
  const liveResult = await verifyFace(faceBytes, enrollment.rekognition_face_id, tenantId);
  const similarity = liveResult.similarity;
  const verified = liveResult.matched;

  console.log('[EDGUARD-VERIFY] rekognition faceId:', liveResult.faceId);
  console.log('[EDGUARD-VERIFY] rekognition similarity:', similarity);
  console.log('[EDGUARD-VERIFY] threshold:', threshold);
  console.log('[EDGUARD-VERIFY] verified:', verified);
  const liveness = verified;
  const livenessScore = similarity / 100;
  const identityConfidence = similarity / 100;

  if (verified) {
    await incrementVerifiedCount(
      tenantId,
      studentId,
      enrollment.verified_count ?? 0,
      enrollment.rekognition_face_id
    );
  }

  return {
    enrollment,
    similarity,
    verified,
    liveness,
    liveness_score: livenessScore,
    identity_confidence: identityConfidence,
  };
}

router.post(
  '/enroll',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as {
        cognitive_baseline?: {
          vocal_embedding?: unknown;
          vocal_quality?: unknown;
          behavioral?: unknown;
          pq_public_key?: unknown;
          pq_signature?: unknown;
        };
      };

      const {
        vocal_embedding,
        vocal_quality,
        behavioral,
        pq_public_key,
        pq_signature,
      } = body.cognitive_baseline || {};

      console.log(
        '[ENROLL] vocal_embedding dims:',
        Array.isArray(vocal_embedding) ? vocal_embedding.length : 'none'
      );

      console.log('[ENROLL] behavioral:', Boolean(behavioral));
      console.log('[ENROLL] pq_public_key:', Boolean(pq_public_key));

      const vocalEmbedding = Array.isArray(vocal_embedding) ? (vocal_embedding as number[]) : null;
      const vocalQuality = typeof vocal_quality === 'number' ? vocal_quality : null;
      const behavioralProfile = behavioral ?? null;
      const pqPublicKey = typeof pq_public_key === 'string' ? pq_public_key : null;
      const pqSignature = typeof pq_signature === 'string' ? pq_signature : null;

      const validatedBody = enrollSchema.parse(req.body);
      const {
        selfie_b64,
        first_name,
        last_name,
        email,
        tenant_id,
      } = validatedBody;

      const resolvedTenantId = req.tenant_id ?? tenant_id;

      if (req.tenant_id && req.tenant_id !== tenant_id) {
        sendApiError(
          res,
          403,
          'TENANT_MISMATCH',
          'tenant_id does not match the API key'
        );
        return;
      }

      logEnrollStep('received body', { tenant_id: resolvedTenantId, first_name, last_name, has_email: Boolean(email) });

      const student_id = ulid();
      logEnrollStep('generated student_id', { student_id });

      const clean_b64 = cleanBase64(selfie_b64);
      logEnrollStep('cleaned base64', { length: clean_b64.length });

      const selfieBytes = await compressImageForRekognition(clean_b64);
      const enrollmentFace = await enrollFace(selfieBytes, student_id, resolvedTenantId);
      logEnrollStep('rekognition index complete', {
        has_face_id: Boolean(enrollmentFace?.faceId),
        confidence: enrollmentFace?.confidence ?? 0,
      });
      if (!enrollmentFace) {
        logEnrollStep('no face detected');
        sendApiError(res, 422, 'FACE_NOT_DETECTED', 'No face detected in the provided image');
        return;
      }

      logEnrollStep('upserting into supabase');
      const client = getSupabaseClient();
      const enrolledAt = new Date().toISOString();
      const enrollmentRow = {
        student_id,
        institution_id: resolvedTenantId,
        first_name,
        last_name,
        email: email ?? null,
        tenant_id: resolvedTenantId,
        rekognition_face_id: enrollmentFace.faceId,
        vocal_embedding: vocalEmbedding ?? null,
        vocal_quality: vocalQuality ?? null,
        behavioral_profile: behavioralProfile,
        pq_public_key: pqPublicKey,
        pq_signature: pqSignature,
        enrolled_at: enrolledAt,
      } satisfies Partial<EdguardEnrollmentRow>;

      const { error: insertError } = await client
        .from('edguard_enrollments')
        .insert(enrollmentRow as Record<string, unknown>);

      if (insertError) {
        console.error('[ENROLL] step:', 'supabase insert failed', insertError.message);
        throw new AppError(500, 'SUPABASE_INSERT_FAILED', insertError.message);
      }

      // Invalidate any possible cached lookups for this student (best-effort)
      await invalidateCache(`edguard-enrollment:${resolvedTenantId}:${student_id}`);

      logEnrollStep('supabase insert complete', {
        student_id,
        institution_id: resolvedTenantId,
        face_id: enrollmentFace.faceId,
        enrolled_at: enrolledAt,
      });

      res.status(201).json({
        success: true,
        student_id,
        confidence: enrollmentFace.confidence,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/lookup',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedBody = lookupSchema.parse(req.body);
      const { first_name, last_name, tenant_id } = validatedBody;

      const result = await lookupEnrollmentByName(tenant_id, first_name, last_name);
      console.log('[EDGUARD-LOOKUP]', first_name, last_name, result);

      if (!result) {
        res.json({ found: false });
        return;
      }

      res.json({
        found: true,
        student_id: result.student_id,
        first_name: result.first_name ?? first_name,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/verify',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();
    try {
      const validatedBody = verifySchema.parse(req.body);
      const { selfie_b64, first_name, last_name, tenant_id } = validatedBody;

      const resolvedTenantId = req.tenant_id ?? tenant_id;

      if (req.tenant_id && req.tenant_id !== tenant_id) {
        sendApiError(
          res,
          403,
          'TENANT_MISMATCH',
          'tenant_id does not match the API key'
        );
        return;
      }

      logVerifyStep('received body', { tenant_id: resolvedTenantId, first_name, last_name });

      const clean_b64 = cleanBase64(selfie_b64);
      logVerifyStep('cleaned base64', { length: clean_b64.length });

      // Redis cache (max 120s) sur le match Rekognition brut (PAS la décision finale)
      // Important: ne jamais cacher un "no match" → si null, on ne set pas Redis.
      const imageHash = createHash('sha256').update(clean_b64).digest('hex').slice(0, 32);
      const cacheKey = `rekognition:search:${resolvedTenantId}:${imageHash}`;

      let searchResult: RekognitionSearchResult = null;
      try {
        const cached = await redis.get<RekognitionSearchResult>(cacheKey);
        const hit = cached !== null;
        console.log(`[cache] ${hit ? 'HIT' : 'MISS'} ${cacheKey}`);
        if (hit) {
          searchResult = cached;
        }
      } catch {
        // Silent: si Redis down → fallback Rekognition direct
      }

      if (searchResult === null) {
        const selfieBytes = await compressImageForRekognition(clean_b64);
        searchResult = await searchFaceByImage(selfieBytes, resolvedTenantId);

        // Store only on match
        if (searchResult !== null) {
          try {
            await redis.set(cacheKey, searchResult, { ex: 120 });
          } catch {
            // Silent
          }
        }
      }
      if (!searchResult) {
        logVerifyStep('no rekognition match');

        // Fire-and-forget: insert failed verification into edguard_sessions
        if (supabase) {
          supabase
            .from('edguard_sessions')
            .insert({
              tenant_id: resolvedTenantId,
              enrollment_id: null,
              student_id: null,
              first_name,
              last_name,
              result: 'no_match',
              similarity_score: 0,
              created_at: new Date().toISOString(),
            })
            .then(
              ({ error: insertErr }) => { if (insertErr) console.error('[EDGUARD] session insert failed:', insertErr.message); },
              () => {}
            );
        }

        res.json({ verified: false, similarity: 0 });
        return;
      }

      // Narrow type for TS (searchResult is non-null from here)
      const match = searchResult;

      logVerifyStep('rekognition match found', {
        face_id: match.faceId,
        similarity: match.similarity,
      });

      const enrollment = await fetchEnrollmentByFaceId(resolvedTenantId, match.faceId);
      if (!enrollment) {
        logVerifyStep('supabase enrollment not found for face', {
          face_id: match.faceId,
          similarity: match.similarity,
        });

        // Fire-and-forget: insert failed verification into edguard_sessions
        if (supabase) {
          supabase
            .from('edguard_sessions')
            .insert({
              tenant_id: resolvedTenantId,
              enrollment_id: null,
              student_id: null,
              first_name,
              last_name,
              result: 'no_match',
              similarity_score: match.similarity,
              created_at: new Date().toISOString(),
            })
            .then(
              ({ error: insertErr }) => { if (insertErr) console.error('[EDGUARD] session insert failed:', insertErr.message); },
              () => {}
            );
        }

        sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Enrollment not found for matched face');
        return;
      }

      logVerifyStep('verification success', {
        face_id: match.faceId,
        similarity: match.similarity,
        student_id: enrollment.student_id,
        first_name: enrollment.first_name,
      });

      // Fire-and-forget: insert into edguard_sessions
      if (supabase) {
        supabase
          .from('edguard_sessions')
          .insert({
            tenant_id: resolvedTenantId,
            enrollment_id: enrollment.student_id,
            student_id: enrollment.student_id,
            first_name,
            last_name,
            result: match.similarity >= 80 ? 'match' : 'no_match',
            similarity_score: match.similarity,
            created_at: new Date().toISOString(),
          })
          .then(
            ({ error: insertErr }) => { if (insertErr) console.error('[EDGUARD] session insert failed:', insertErr.message); },
            () => {}
          );
      }

      res.json({
        verified: true,
        similarity: match.similarity,
        student_id: enrollment.student_id,
        first_name: enrollment.first_name ?? '',
      });

      // Fire-and-forget: push verification event to HCS-U7 dashboard
      // Payload aligned with HvSessionIngestSchema
      // (hcs-u7-backend/src/routes/hybrid-vector/hybrid-vector.routes.ts).
      if (config.HCS_INGEST_URL && config.HCS_WORKER_SHARED_SECRET) {
        const ingestUrl = config.HCS_INGEST_URL;
        const secret = config.HCS_WORKER_SHARED_SECRET;
        const verified = match.similarity >= 80;
        const similarity = match.similarity;
        // Schema requires breakdown values in [0..1], not [0..100].
        const facialNormalized = Math.max(0, Math.min(1, similarity / 100));
        const confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' =
          similarity >= 90 ? 'HIGH' : similarity >= 70 ? 'MEDIUM' : 'LOW';

        setImmediate(() => {
          fetch(ingestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Worker-Auth': secret,
              'X-HCS-Worker-Auth': secret,
            },
            body: JSON.stringify({
              hv_session_id: randomUUID(),
              tenant_id: resolvedTenantId,
              trust_score: Math.round(similarity),
              is_human: verified,
              confidence_level: confidenceLevel,
              breakdown: {
                facial: facialNormalized,
                vocal: 0,
                reflex: 0,
                behavioral: 0,
                mouse: 0,
              },
              metadata: {
                device_type: 'mobile',
                processing_ms: Date.now() - startTime,
                timestamp: new Date().toISOString(),
                deepface_model: 'rekognition',
                guard_type: 'edguard',
                student_id: enrollment.student_id,
                first_name: enrollment.first_name,
                last_name: enrollment.last_name,
              },
            }),
          }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[EdGuard ingest error]', message);
          });
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/session/checkpoint',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenant_id = getTenantId(req);
      console.log('[CHECKPOINT] tenant_id:', tenant_id);
      const validatedBody = checkpointSchema.parse(req.body);
      const { student_id, checkpoint_number, face_b64, cognitive_score, session_id } =
        validatedBody;

      const verification = await verifyEnrollmentFace(tenant_id, student_id, face_b64, SESSION_SIMILARITY_THRESHOLD);
      const baseline = parseCognitiveBaseline(verification.enrollment.cognitive_baseline);
      const cognitiveDeviation =
        typeof cognitive_score === 'number' && baseline
          ? Math.abs(cognitive_score - baseline.stroop_score)
          : 0;
      const cognitiveAlert = cognitiveDeviation > 0.35;

      const facialMatch = verification.similarity >= (SESSION_SIMILARITY_THRESHOLD * 100) ? 1 : 0;
      const livenessOk = verification.liveness ? 1 : 0;
      const cognitiveOk = cognitiveAlert ? 0 : 1;
      const trustScore = (facialMatch * 0.5 + livenessOk * 0.3 + cognitiveOk * 0.2) * 100;

      let alertLevel: AlertLevel = 'ALERT';
      if (trustScore >= 80) {
        alertLevel = 'CLEAR';
      } else if (trustScore >= 60) {
        alertLevel = 'WARNING';
      }

      const flags: string[] = [];
      if (facialMatch === 0) {
        flags.push('FACE_MISMATCH');
      }
      if (livenessOk === 0) {
        flags.push('LIVENESS_FAILED');
      }
      if (cognitiveAlert) {
        flags.push('COGNITIVE_DEVIATION');
      }

      const roundedTrustScore = Math.round(trustScore);
      const isHuman = roundedTrustScore >= 65;
      const now = new Date().toISOString();

      res.json({
        success: true,
        session_id,
        student_id,
        checkpoint_number,
        trust_score: roundedTrustScore,
        alert_level: alertLevel,
        verified: verification.verified,
        liveness: verification.liveness,
        cognitive_deviation: cognitiveDeviation,
        flags,
        timestamp: now,
      });

      // Fire-and-forget: persist checkpoint to Supabase
      if (supabase) {
        supabase
          .from('edguard_checkpoints')
          .insert({
            id: randomUUID(),
            tenant_id,
            student_id,
            session_id,
            checkpoint_number,
            trust_score: roundedTrustScore,
            is_human: isHuman,
            alert_level: alertLevel,
            flags,
            created_at: now,
          })
          .then(
            ({ error: insertErr }) => { if (insertErr) console.error('[EDGUARD] checkpoint insert failed:', insertErr.message); },
            () => {}
          );
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;
