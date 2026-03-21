import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';

type CognitiveBaseline = {
  stroop_score: number;
  reaction_time_ms: number;
  nback_score: number;
};

type AlertLevel = 'CLEAR' | 'WARNING' | 'ALERT';

interface EdguardEnrollmentRow {
  id: string;
  student_id: string;
  institution_id: string;
  embedding: string | number[];
  cognitive_baseline: CognitiveBaseline | null;
  enrolled_at: string;
  verified_count: number;
}

interface VerificationResult {
  enrollment: EdguardEnrollmentRow;
  similarity: number;
  verified: boolean;
  liveness: boolean;
  liveness_score: number;
  identity_confidence: number;
}

const DESCRIPTOR_COSINE_THRESHOLD = 0.45;

const enrollSchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  institution_id: z.string().min(1, 'institution_id is required'),
  face_descriptor: z.array(z.number()).min(1, 'face_descriptor is required'),
  identity_confidence: z.number().min(0).max(1),
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
  face_descriptor: z.array(z.number()).min(1, 'face_descriptor is required'),
  include_cognitive: z.boolean().default(false),
});

const checkpointSchema = z.object({
  student_id: z.string().min(1, 'student_id is required'),
  checkpoint_number: z.number().int().positive(),
  face_descriptor: z.array(z.number()).min(1, 'face_descriptor is required'),
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
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'number')) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSimilarity(similarity: number): number {
  if (!Number.isFinite(similarity)) {
    return 0;
  }

  return Math.max(0, Math.min(1, similarity));
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

async function fetchEnrollment(studentId: string): Promise<EdguardEnrollmentRow | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('edguard_enrollments')
    .select('*')
    .eq('student_id', studentId)
    .maybeSingle();

  if (error) {
    throw new AppError(500, 'SUPABASE_QUERY_FAILED', error.message);
  }

  return (data as EdguardEnrollmentRow | null) ?? null;
}

async function incrementVerifiedCount(studentId: string, currentCount: number): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client
    .from('edguard_enrollments')
    .update({ verified_count: currentCount + 1 })
    .eq('student_id', studentId);

  if (error) {
    throw new AppError(500, 'SUPABASE_UPDATE_FAILED', error.message);
  }
}

async function verifyEnrollmentDescriptor(studentId: string, liveDescriptor: number[]): Promise<VerificationResult> {
  const enrollment = await fetchEnrollment(studentId);

  if (!enrollment) {
    throw new AppError(404, 'STUDENT_NOT_ENROLLED', 'Student is not enrolled');
  }

  const storedEmbedding = parseEmbedding(enrollment.embedding);
  if (!storedEmbedding) {
    throw new AppError(500, 'STORED_EMBEDDING_INVALID', 'Stored embedding is invalid');
  }

  const rawSimilarity = cosineSimilarity(storedEmbedding, liveDescriptor);
  const similarity = normalizeSimilarity(rawSimilarity);
  const verified = rawSimilarity >= DESCRIPTOR_COSINE_THRESHOLD;
  // Liveness is client-trusted (face-api.js detected a face)
  const liveness = true;
  const livenessScore = 1;
  const identityConfidence = similarity;

  if (verified) {
    await incrementVerifiedCount(studentId, enrollment.verified_count ?? 0);
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
      const validatedBody = enrollSchema.parse(req.body);
      const {
        student_id,
        institution_id,
        face_descriptor,
        identity_confidence,
        cognitive_score_override,
        cognitive_baseline: rawBaseline,
      } = validatedBody;

      // If frontend sends cognitive_score_override, convert to cognitive_baseline format
      const cognitive_baseline: CognitiveBaseline | undefined =
        rawBaseline ?? (typeof cognitive_score_override === 'number'
          ? { stroop_score: cognitive_score_override, reaction_time_ms: 500, nback_score: cognitive_score_override }
          : undefined);

      // Face analysis is done client-side via face-api.js
      // The frontend sends the descriptor and the identity confidence from comparing official photo vs selfie
      console.log('[EDGUARD-ENROLL] client descriptor dims:', face_descriptor.length, 'confidence:', identity_confidence);

      if (identity_confidence < 0.5) {
        sendApiError(res, 422, 'IDENTITY_MISMATCH', 'Identity verification failed (client-side comparison too low)', {
          confidence: identity_confidence,
        });
        return;
      }

      const client = getSupabaseClient();
      const existingEnrollment = await fetchEnrollment(student_id);
      const enrolledAt = new Date().toISOString();
      const enrollmentRow: EdguardEnrollmentRow = {
        id: existingEnrollment?.id ?? randomUUID(),
        student_id,
        institution_id,
        embedding: JSON.stringify(face_descriptor),
        cognitive_baseline: cognitive_baseline ?? existingEnrollment?.cognitive_baseline ?? null,
        enrolled_at: enrolledAt,
        verified_count: existingEnrollment?.verified_count ?? 0,
      };

      const { error } = await client
        .from('edguard_enrollments')
        .upsert(enrollmentRow, { onConflict: 'student_id' });

      if (error) {
        throw new AppError(500, 'SUPABASE_UPSERT_FAILED', error.message);
      }

      res.status(201).json({
        success: true,
        student_id,
        institution_id,
        enrolled: true,
        identity_confidence,
        embedding_dims: face_descriptor.length,
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
      const validatedBody = verifySchema.parse(req.body);
      const { student_id, face_descriptor } = validatedBody;

      const verification = await verifyEnrollmentDescriptor(student_id, face_descriptor);

      res.json({
        success: true,
        student_id,
        verified: verification.verified,
        similarity: verification.similarity,
        threshold: DESCRIPTOR_COSINE_THRESHOLD,
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
      const validatedBody = checkpointSchema.parse(req.body);
      const { student_id, checkpoint_number, face_descriptor, cognitive_score, session_id } =
        validatedBody;

      const verification = await verifyEnrollmentDescriptor(student_id, face_descriptor);
      const baseline = parseCognitiveBaseline(verification.enrollment.cognitive_baseline);
      const cognitiveDeviation =
        typeof cognitive_score === 'number' && baseline
          ? Math.abs(cognitive_score - baseline.stroop_score)
          : 0;
      const cognitiveAlert = cognitiveDeviation > 0.35;

      const facialMatch = verification.similarity >= DESCRIPTOR_COSINE_THRESHOLD ? 1 : 0;
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
