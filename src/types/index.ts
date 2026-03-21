export interface SessionRequest {
  tenant_id: string;
  user_id: string;
  face_image_b64: string;
  cognitive_session_id: string;
  cognitive_score_override?: number;
}

export interface EnrollRequest {
  tenant_id: string;
  user_id: string;
  face_image_b64: string;
}

export interface DeepfaceAnalyzeResponse {
  face_detected: boolean;
  liveness: boolean;
  confidence: number;
  embedding?: number[];
  error?: string;
}

export interface HcsScoreResponse {
  score: number;
  passed: boolean;
  test_type?: string;
  error?: string;
}

export interface TrustScoreBreakdown {
  facial_liveness: number;
  facial_confidence: number;
  cognitive_score: number;
  behavioral_bonus: number;
}

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type TrustScoreReason = 
  | 'NO_FACE' 
  | 'NO_FACE_DEGRADED'
  | 'SPOOF_DETECTED' 
  | 'BOT_DETECTED' 
  | 'FACIAL_UNAVAILABLE'
  | null;

export interface TrustScoreResult {
  trust_score: number;
  is_human: boolean;
  confidence_level: ConfidenceLevel;
  breakdown: TrustScoreBreakdown;
  reason: TrustScoreReason;
}

export interface SessionResponse {
  success: true;
  token: string;
  trust_score: number;
  confidence_level: ConfidenceLevel;
  is_human: boolean;
  breakdown: TrustScoreBreakdown;
  reason: TrustScoreReason;
  expires_in: number;
}

export interface EnrollResponse {
  success: true;
  user_id: string;
  enrolled_at: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
  message: string;
  timestamp: string;
}

export interface JwtPayload {
  sub: string;
  tenant_id: string;
  trust_score: number;
  is_human: boolean;
  confidence_level: ConfidenceLevel;
  iat: number;
  exp: number;
}

export interface EnrolledUser {
  user_id: string;
  tenant_id: string;
  embedding: number[];
  enrolled_at: string;
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}
