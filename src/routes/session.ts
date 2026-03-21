import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as jose from 'jose';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { analyzeface } from '../services/deepfaceService';
import { getCognitiveScore } from '../services/hcsService';
import { computeTrustScore } from '../services/trustScore';
import { supabase } from '../services/supabaseService';
import {
  SessionResponse,
  JwtPayload,
  DeepfaceAnalyzeResponse,
  HcsScoreResponse,
} from '../types';

const router = Router();

const sessionRequestSchema = z.object({
  tenant_id: z.string().min(1, 'tenant_id is required'),
  user_id: z.string().min(1, 'user_id is required'),
  face_image_b64: z.string().min(1, 'face_image_b64 is required'),
  cognitive_session_id: z.string().min(1, 'cognitive_session_id is required'),
  cognitive_score_override: z.number().min(0).max(1).optional(),
});

async function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): Promise<string> {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const expiresIn = config.JWT_EXPIRES_IN;

  const jwt = await new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(secret);

  return jwt;
}

router.post(
  '/auth/session',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const t0 = Date.now();
    console.log('[HV] session start');

    try {
      const validatedBody = sessionRequestSchema.parse(req.body);
      console.log(`[HV] validation: ${Date.now() - t0}ms`);
      const { tenant_id, user_id, face_image_b64, cognitive_session_id, cognitive_score_override } = validatedBody;

      console.log('[HV] calling deepface + HCS in parallel');
      const [deepfaceSettled, hcsSettled] = await Promise.allSettled([
        analyzeface(face_image_b64, false),
        getCognitiveScore(cognitive_session_id, cognitive_score_override),
      ]);
      console.log(`[HV] allSettled done: ${Date.now() - t0}ms`);

      let deepfaceResult: DeepfaceAnalyzeResponse;
      if (deepfaceSettled.status === 'fulfilled') {
        deepfaceResult = deepfaceSettled.value;
      } else {
        console.error('DeepFace call failed:', deepfaceSettled.reason);
        deepfaceResult = {
          face_detected: false,
          liveness: false,
          confidence: 0,
          error: 'DEEPFACE_UNAVAILABLE',
        };
      }
      console.log('[HV] deepface result:', JSON.stringify(deepfaceResult));

      let hcsResult: HcsScoreResponse;
      if (hcsSettled.status === 'fulfilled') {
        hcsResult = hcsSettled.value;
      } else {
        console.error('HCS call failed:', hcsSettled.reason);
        hcsResult = {
          score: 0,
          passed: false,
          error: 'HCS_UNAVAILABLE',
        };
      }
      console.log('[HV] hcs result:', JSON.stringify(hcsResult));

      const trustScoreResult = computeTrustScore(deepfaceResult, hcsResult);
      console.log(`[HV] trust score computed: ${Date.now() - t0}ms`);
      console.log(`[HV] trust_score=${trustScoreResult.trust_score} is_human=${trustScoreResult.is_human}`);

      const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
        sub: user_id,
        tenant_id,
        trust_score: trustScoreResult.trust_score,
        is_human: trustScoreResult.is_human,
        confidence_level: trustScoreResult.confidence_level,
      };

      const token = await signJwt(jwtPayload);

      const processingMs = Date.now() - t0;

      console.log(
        `Session: tenant=${tenant_id}, user=${user_id}, trust_score=${trustScoreResult.trust_score}, is_human=${trustScoreResult.is_human}, processing_ms=${processingMs}`
      );

      res.setHeader('X-Processing-Ms', processingMs.toString());

      const response: SessionResponse = {
        success: true,
        token,
        trust_score: trustScoreResult.trust_score,
        confidence_level: trustScoreResult.confidence_level,
        is_human: trustScoreResult.is_human,
        breakdown: trustScoreResult.breakdown,
        reason: trustScoreResult.reason,
        expires_in: config.JWT_EXPIRES_IN,
      };

      res.json(response);
      console.log(`[HV] response sent: ${Date.now() - t0}ms TOTAL`);

      // Fire-and-forget: persist session to Supabase
      if (supabase) {
        const bd = trustScoreResult.breakdown;
        supabase
          .from('hv_sessions')
          .insert({
            id: randomUUID(),
            tenant_id,
            user_id,
            trust_score: trustScoreResult.trust_score,
            is_human: trustScoreResult.is_human,
            confidence_level: trustScoreResult.confidence_level,
            facial_liveness: bd.facial_liveness,
            facial_confidence: bd.facial_confidence,
            cognitive_score: bd.cognitive_score,
            behavioral_bonus: bd.behavioral_bonus,
            reason: trustScoreResult.reason,
            created_at: new Date().toISOString(),
          })
          .then(
            ({ error }) => { if (error) console.error('[HV] hv_sessions insert failed:', error.message); },
            () => {}
          );
      }

      // Fire-and-forget: push session to HCS-U7 backend (never blocks, never throws)
      if (config.HCS_INGEST_URL && config.HCS_WORKER_SHARED_SECRET) {
        const hvSessionId = randomUUID();
        const ingestUrl = config.HCS_INGEST_URL;
        const secret = config.HCS_WORKER_SHARED_SECRET;
        const bd = trustScoreResult.breakdown;

        setImmediate(() => {
          fetch(ingestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Worker-Auth': secret,
              'X-HCS-Worker-Auth': secret,
            },
            body: JSON.stringify({
              hv_session_id: hvSessionId,
              tenant_id,
              trust_score: trustScoreResult.trust_score,
              is_human: trustScoreResult.is_human,
              confidence_level: trustScoreResult.confidence_level,
              breakdown: {
                facial: bd.facial_confidence,
                vocal: bd.cognitive_score,
                reflex: bd.cognitive_score,
                behavioral: bd.behavioral_bonus,
                mouse: null,
              },
              metadata: {
                device_type: 'desktop',
                processing_ms: processingMs,
                timestamp: new Date().toISOString(),
                deepface_model: 'ArcFace',
              },
            }),
          }).catch(() => {}); // Silent — never block, never throw
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;
