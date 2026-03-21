import { randomBytes, randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { cleanBase64, enrollFace, searchFaceByImage, verifyFace } from '../services/rekognitionService';
import { supabase } from '../services/supabaseService';
import { AppError } from '../types';

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
  cognitive_baseline?: CognitiveBaseline | null;
  enrolled_at: string;
  verified_count?: number;
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

async function lookupEnrollmentByName(
  tenantId: string,
  firstName: string,
  lastName: string,
): Promise<Pick<EdguardEnrollmentRow, 'student_id' | 'first_name' | 'last_name'> | null> {
  const client = getSupabaseClient();
  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName.trim();

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

  if (!enrollment.rekognition_face_id) {
    throw new AppError(500, 'STORED_FACE_ID_MISSING', 'Stored Rekognition face id is missing');
  }

  const liveResult = await verifyFace(faceB64, enrollment.rekognition_face_id);
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
      const validatedBody = enrollSchema.parse(req.body);
      const {
        selfie_b64,
        first_name,
        last_name,
        email,
        tenant_id,
      } = validatedBody;

      logEnrollStep('received body', { tenant_id, first_name, last_name, has_email: Boolean(email) });

      const student_id = ulid();
      logEnrollStep('generated student_id', { student_id });

      const clean_b64 = cleanBase64(selfie_b64);
      logEnrollStep('cleaned base64', { length: clean_b64.length });

      const enrollmentFace = await enrollFace(clean_b64, student_id);
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
        institution_id: tenant_id,
        first_name,
        last_name,
        email: email ?? null,
        tenant_id,
        rekognition_face_id: enrollmentFace.faceId,
        enrolled_at: enrolledAt,
      } satisfies Partial<EdguardEnrollmentRow>;

      const { error: insertError } = await client
        .from('edguard_enrollments')
        .insert(enrollmentRow as Record<string, unknown>);

      if (insertError) {
        console.error('[ENROLL] step:', 'supabase insert failed', insertError.message);
        throw new AppError(500, 'SUPABASE_INSERT_FAILED', insertError.message);
      }

      logEnrollStep('supabase insert complete', {
        student_id,
        institution_id: tenant_id,
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
    try {
      const validatedBody = verifySchema.parse(req.body);
      const { selfie_b64, first_name, last_name, tenant_id } = validatedBody;

      logVerifyStep('received body', { tenant_id, first_name, last_name });

      const clean_b64 = cleanBase64(selfie_b64);
      logVerifyStep('cleaned base64', { length: clean_b64.length });

      const searchResult = await searchFaceByImage(clean_b64);
      if (!searchResult) {
        logVerifyStep('no rekognition match');
        res.json({ verified: false, similarity: 0 });
        return;
      }

      logVerifyStep('rekognition match found', {
        face_id: searchResult.faceId,
        similarity: searchResult.similarity,
      });

      const enrollment = await fetchEnrollmentByFaceId(tenant_id, searchResult.faceId);
      if (!enrollment) {
        logVerifyStep('supabase enrollment not found for face', {
          face_id: searchResult.faceId,
          similarity: searchResult.similarity,
        });
        sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Enrollment not found for matched face');
        return;
      }

      logVerifyStep('verification success', {
        face_id: searchResult.faceId,
        similarity: searchResult.similarity,
        student_id: enrollment.student_id,
        first_name: enrollment.first_name,
      });

      res.json({
        verified: true,
        similarity: searchResult.similarity,
        student_id: enrollment.student_id,
        first_name: enrollment.first_name ?? '',
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
