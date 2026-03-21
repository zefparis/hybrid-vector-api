import {
  DeepfaceAnalyzeResponse,
  HcsScoreResponse,
  TrustScoreResult,
  TrustScoreBreakdown,
  ConfidenceLevel,
  TrustScoreReason,
} from '../types';

const WEIGHTS = {
  facial_liveness: 0.25,
  facial_confidence: 0.25,
  cognitive_score: 0.40,
  behavioral_bonus: 0.10,
};

const THRESHOLDS = {
  is_human: 65,
  low_confidence: 40,
  high_confidence: 75,
  min_cognitive: 0.3,
};

function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= THRESHOLDS.high_confidence) return 'HIGH';
  if (score >= THRESHOLDS.low_confidence) return 'MEDIUM';
  return 'LOW';
}

export function computeTrustScore(
  deepfaceResult: DeepfaceAnalyzeResponse,
  hcsResult: HcsScoreResponse
): TrustScoreResult {
  const breakdown: TrustScoreBreakdown = {
    facial_liveness: 0,
    facial_confidence: 0,
    cognitive_score: 0,
    behavioral_bonus: 0,
  };

  let reason: TrustScoreReason = null;

  if (deepfaceResult.error === 'DEEPFACE_UNAVAILABLE') {
    const cognitiveScore = hcsResult.score;
    const trustScore = Math.round(cognitiveScore * 60);

    breakdown.cognitive_score = cognitiveScore;

    return {
      trust_score: trustScore,
      is_human: cognitiveScore > 0.5,
      confidence_level: getConfidenceLevel(trustScore),
      breakdown,
      reason: 'FACIAL_UNAVAILABLE',
    };
  }

  if (!deepfaceResult.face_detected) {
    breakdown.cognitive_score = hcsResult.score;
    return {
      trust_score: 0,
      is_human: false,
      confidence_level: 'LOW',
      breakdown,
      reason: 'NO_FACE',
    };
  }

  if (!deepfaceResult.liveness) {
    breakdown.cognitive_score = hcsResult.score;
    return {
      trust_score: 0,
      is_human: false,
      confidence_level: 'LOW',
      breakdown,
      reason: 'SPOOF_DETECTED',
    };
  }

  if (hcsResult.score < THRESHOLDS.min_cognitive) {
    breakdown.cognitive_score = hcsResult.score;
    return {
      trust_score: 0,
      is_human: false,
      confidence_level: 'LOW',
      breakdown,
      reason: 'BOT_DETECTED',
    };
  }

  const livenessScore = deepfaceResult.liveness ? 1.0 : 0;
  const confidenceScore = deepfaceResult.confidence;
  const cognitiveScore = hcsResult.score;

  const bothAgree = livenessScore > 0.5 && cognitiveScore > 0.5;
  const behavioralBonus = bothAgree ? 1.0 : 0;

  breakdown.facial_liveness = livenessScore;
  breakdown.facial_confidence = confidenceScore;
  breakdown.cognitive_score = cognitiveScore;
  breakdown.behavioral_bonus = behavioralBonus;

  const weightedSum =
    breakdown.facial_liveness * WEIGHTS.facial_liveness +
    breakdown.facial_confidence * WEIGHTS.facial_confidence +
    breakdown.cognitive_score * WEIGHTS.cognitive_score +
    breakdown.behavioral_bonus * WEIGHTS.behavioral_bonus;

  const trustScore = Math.round(weightedSum * 100);

  const isHuman = trustScore >= THRESHOLDS.is_human;
  const confidenceLevel = getConfidenceLevel(trustScore);

  return {
    trust_score: trustScore,
    is_human: isHuman,
    confidence_level: confidenceLevel,
    breakdown,
    reason,
  };
}
