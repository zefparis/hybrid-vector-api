import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { analyzeface } from '../services/deepfaceService';
import { supabase } from '../services/supabaseService';
import { AppError, DeepfaceAnalyzeResponse } from '../types';

type CognitiveBaseline = {
  stroop_score: number;
  reaction_time_ms: number;
  nback_score: number;
};

type AlertLevel = 'CLEAR' | 'WARNING' | 'ALERT';

interface EdguardEnrollmentRow {
  id: string;
  tenant_id: string;
  student_id: string;
  institution_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string;
  embedding: string | number[];
  cognitive_baseline: CognitiveBaseline | null;
  enrolled_at: string;
  verified_count: number;
}

const DEFAULT_TENANT_ID = 'demo-tenant';

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

const VERIFY_SIMILARITY_THRESHOLD = 0.4;
const SESSION_SIMILARITY_THRESHOLD = 0.55;

const enrollSchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  institution_id: z.string().min(1, 'institution_id is required'),
  selfie_b64: z.string().min(1, 'selfie_b64 is required'),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(['student', 'teacher', 'beneficiary']).optional().default('student'),
  cognitive_score_override: z.number().min(0).max(1).optional(),
  cognitive_baseline: z
    .object({
      stroop_score: z.number().min(0).max(1),
      reaction_time_ms: z.number().positive(),
      nback_score: z.number().min(0).max(1),
    })
    .optional(),
});

const verifySchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  selfie_b64: z.string().min(1, 'selfie_b64 is required'),
  include_cognitive: z.boolean().default(false),
});

const checkpointSchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  checkpoint_number: z.number().int().positive(),
  face_b64: z.string().min(1, 'face_b64 is required'),
  cognitive_score: z.number().min(0).max(1).optional(),
  session_id: z.string().min(1, 'session_id is required'),
});

const router = Router();

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

function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value) && value.length > 0) {
    // Coerce string numbers to actual numbers (e.g., ["0.123", ...] → [0.123, ...])
    const coerced = value.map(Number);
    if (coerced.every((n) => !isNaN(n))) {
      return coerced;
    }
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const coerced = parsed.map(Number);
        if (coerced.every((n) => !isNaN(n))) {
          return coerced;
        }
      }
    } catch {
      return null;
    }
  }

  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < length; index += 1) {
    const aValue = a[index];
    const bValue = b[index];
    dot += aValue * bValue;
    magA += aValue * aValue;
    magB += bValue * bValue;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / Math.sqrt(magA * magB);
}

async function fetchEnrollment(tenantId: string, studentId: string): Promise<EdguardEnrollmentRow | null> {
  const client = getSupabaseClient();
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
}

async function incrementVerifiedCount(tenantId: string, studentId: string, currentCount: number): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client
    .from('edguard_enrollments')
    .update({ verified_count: currentCount + 1 })
    .eq('tenant_id', tenantId)
    .eq('student_id', studentId);

  if (error) {
    throw new AppError(500, 'SUPABASE_UPDATE_FAILED', error.message);
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

  const storedEmbedding = parseEmbedding(enrollment.embedding);
  console.log('[EDGUARD-VERIFY] stored embedding found:', !!storedEmbedding, 'dims:', storedEmbedding?.length);
  if (!storedEmbedding) {
    throw new AppError(500, 'STORED_EMBEDDING_INVALID', 'Stored embedding is invalid');
  }

  // Analyze the live face via deepface-api
  let liveResult: DeepfaceAnalyzeResponse;
  try {
    liveResult = await analyzeface(faceB64, true);
  } catch {
    liveResult = {
      face_detected: false,
      liveness: false,
      confidence: 0,
      embedding: undefined,
    };
  }

  const liveEmbedding = parseEmbedding(liveResult.embedding);
  console.log('[EDGUARD-VERIFY] live embedding dims:', liveEmbedding?.length);

  let similarity = 0;
  if (liveEmbedding && storedEmbedding) {
    similarity = cosineSimilarity(storedEmbedding, liveEmbedding);
  }

  console.log('[EDGUARD-VERIFY] cosine similarity:', similarity);
  console.log('[EDGUARD-VERIFY] threshold used:', threshold);

  const verified = similarity >= threshold;
  console.log('[EDGUARD-VERIFY] verified:', verified);
  const liveness = liveResult.liveness ?? false;
  const livenessScore = liveResult.confidence ?? 0;
  const identityConfidence = similarity;

  if (verified) {
    await incrementVerifiedCount(tenantId, studentId, enrollment.verified_count ?? 0);
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
      const tenant_id = getTenantId(req);
      const validatedBody = enrollSchema.parse(req.body);
      const {
        student_id,
        institution_id,
        selfie_b64,
        first_name,
        last_name,
        email,
        role,
        cognitive_score_override,
        cognitive_baseline: rawBaseline,
      } = validatedBody;

      // If frontend sends cognitive_score_override, convert to cognitive_baseline format
      const cognitive_baseline: CognitiveBaseline | undefined =
        rawBaseline ?? (typeof cognitive_score_override === 'number'
          ? { stroop_score: cognitive_score_override, reaction_time_ms: 500, nback_score: cognitive_score_override }
          : undefined);

      // Extract ArcFace 512d embedding from selfie via deepface-api
      console.log('[EDGUARD-ENROLL] starting analyzeface (extract embedding)...');
      let embeddingResult: DeepfaceAnalyzeResponse;
      try {
        embeddingResult = await analyzeface(selfie_b64, true);
      } catch {
        embeddingResult = {
          face_detected: false,
          liveness: false,
          confidence: 0,
          embedding: undefined,
          error: 'DEEPFACE_UNAVAILABLE',
        };
      }
      console.log('[EDGUARD-ENROLL] analyzeface done:', JSON.stringify({
        face_detected: embeddingResult.face_detected,
        liveness: embeddingResult.liveness,
        has_embedding: Array.isArray(embeddingResult.embedding),
        embedding_dims: Array.isArray(embeddingResult.embedding) ? embeddingResult.embedding.length : 0,
      }));

      console.log('[EDGUARD-ENROLL] embedding raw:',
        typeof embeddingResult.embedding,
        Array.isArray(embeddingResult.embedding),
        Array.isArray(embeddingResult.embedding) ? embeddingResult.embedding.length : 'NOT_ARRAY',
        embeddingResult.error ?? 'no_error'
      );
      const embedding = parseEmbedding(embeddingResult.embedding);
      if (!embedding) {
        console.log('[EDGUARD-ENROLL] early return: embedding is null/invalid after parseEmbedding — raw type:', typeof embeddingResult.embedding, 'isArray:', Array.isArray(embeddingResult.embedding), 'error:', embeddingResult.error);
        sendApiError(res, 422, 'EMBEDDING_FAILED', 'Failed to extract face embedding');
        return;
      }

      const identityConfidence = embeddingResult.confidence ?? 0;

      console.log('[EDGUARD-ENROLL] body received:', JSON.stringify({
        student_id,
        first_name,
        last_name,
        email,
        tenant_id,
      }));

      console.log('[EDGUARD-ENROLL] gate 1: supabase client exists:', !!supabase);
      const client = getSupabaseClient();
      console.log('[EDGUARD-ENROLL] gate 2: fetching existing enrollment for', tenant_id, student_id);
      const existingEnrollment = await fetchEnrollment(tenant_id, student_id);
      console.log('[EDGUARD-ENROLL] gate 3: existingEnrollment:', existingEnrollment ? 'found (id=' + existingEnrollment.id + ')' : 'null (new enrollment)');
      const enrolledAt = new Date().toISOString();
      const enrollmentRow: EdguardEnrollmentRow = {
        id: existingEnrollment?.id ?? randomUUID(),
        tenant_id,
        student_id,
        institution_id,
        first_name: first_name ?? existingEnrollment?.first_name ?? null,
        last_name: last_name ?? existingEnrollment?.last_name ?? null,
        email: email ?? existingEnrollment?.email ?? null,
        role: role ?? existingEnrollment?.role ?? 'student',
        embedding: JSON.stringify(embedding),
        cognitive_baseline: cognitive_baseline ?? existingEnrollment?.cognitive_baseline ?? null,
        enrolled_at: enrolledAt,
        verified_count: existingEnrollment?.verified_count ?? 0,
      };

      console.log('[EDGUARD-ENROLL] attempting Supabase upsert...');
      try {
        const { data: supabaseResult, error: upsertError } = await client
          .from('edguard_enrollments')
          .upsert(enrollmentRow, { onConflict: 'tenant_id,student_id' })
          .select();

        console.log('[EDGUARD-ENROLL] upsert error:', upsertError);
        console.log('[EDGUARD-ENROLL] upsert data:', JSON.stringify(supabaseResult));

        if (upsertError) {
          console.error('[EDGUARD-ENROLL] Supabase error detail:', upsertError.message, upsertError.code, upsertError.details);
          throw upsertError;
        }
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        console.error('[EDGUARD-ENROLL] CATCH:', e.message, e.code, e.details);
        throw new AppError(500, 'SUPABASE_UPSERT_FAILED', String(e.message ?? 'Unknown upsert error'));
      }

      res.status(201).json({
        success: true,
        student_id,
        institution_id,
        enrolled: true,
        identity_confidence: identityConfidence,
        embedding_dims: embedding.length,
        enrolled_at: enrolledAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/verify',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenant_id = getTenantId(req);
      const validatedBody = verifySchema.parse(req.body);
      const { student_id, selfie_b64 } = validatedBody;
      const threshold = VERIFY_SIMILARITY_THRESHOLD;

      console.log('[EDGUARD-VERIFY] student_id:', student_id);

      const verification = await verifyEnrollmentFace(tenant_id, student_id, selfie_b64, threshold);

      res.json({
        success: true,
        student_id,
        verified: verification.verified,
        similarity: verification.similarity,
        threshold,
        liveness: verification.liveness,
        liveness_score: verification.liveness_score,
        identity_confidence: verification.identity_confidence,
      });
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

      const facialMatch = verification.similarity >= SESSION_SIMILARITY_THRESHOLD ? 1 : 0;
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
