import axios, { AxiosError } from 'axios';
import crypto from 'crypto';
import { config } from '../config';
import { DeepfaceAnalyzeResponse } from '../types';

const ANALYZE_FIRST_TIMEOUT_MS = 8000;
const ANALYZE_RETRY_TIMEOUT_MS = 25000;
const VERIFY_TIMEOUT_MS = 30000;

interface DeepfaceApiResponse {
  face_detected: boolean;
  liveness?: boolean;
  confidence?: number;
  embedding?: number[];
}

function signRequest(body: string, secret: string): {
  'X-Timestamp': string;
  'X-Signature': string;
} {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return {
    'X-Timestamp': timestamp,
    'X-Signature': `sha256=${mac}`,
  };
}

function isTimeoutError(error: unknown): boolean {
  const axiosError = error as AxiosError;
  return axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT';
}

async function analyzeDeepfaceOnce(
  imageB64: string,
  extractEmbedding: boolean,
  timeoutMs: number,
  t0: number
): Promise<DeepfaceApiResponse> {
  const rawB64 = imageB64.replace(/^data:image\/\w+;base64,/, '');
  console.log('[DEEPFACE] image length:', rawB64.length);
  console.log('[DEEPFACE] first 50 chars:', rawB64.substring(0, 50));
  if (rawB64.length < 10000) {
    console.warn('[DEEPFACE] WARNING: image suspiciously small, likely corrupted or blank');
  }
  if (rawB64.startsWith('data:')) {
    console.warn('[DEEPFACE] WARNING: base64 prefix strip failed, still starts with data:');
  }
  const bodyStr = JSON.stringify({
    image_b64: rawB64,
    extract_embedding: extractEmbedding,
  });
  const extraHeaders = config.DEEPFACE_HMAC_SECRET
    ? signRequest(bodyStr, config.DEEPFACE_HMAC_SECRET)
    : {};

  const response = await axios.post<DeepfaceApiResponse>(
    `${config.DEEPFACE_API_URL}/analyze`,
    bodyStr,
    {
      headers: {
        'X-API-Key': config.DEEPFACE_API_KEY,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }
  );

  console.log(`[DEEPFACE] fetch done: ${Date.now() - t0}ms`);
  console.log('[DEEPFACE] status:', response.status);

  const data = response.data;
  console.log(`[DEEPFACE] parsed: ${Date.now() - t0}ms`);
  console.log('[DEEPFACE] face_detected:', data.face_detected);
  console.log('[DEEPFACE] liveness:', data.liveness);

  return data;
}

export async function analyzeface(
  imageB64: string,
  extractEmbedding: boolean = false
): Promise<DeepfaceAnalyzeResponse> {
  const t0 = Date.now();
  const url = `${config.DEEPFACE_API_URL}/analyze`;
  console.log('[DEEPFACE] calling:', url);
  console.log('[DEEPFACE] face_b64 length:', imageB64?.length ?? 0);

  try {
    console.log('[DEEPFACE] fetch start');
    const data = await analyzeDeepfaceOnce(
      imageB64,
      extractEmbedding,
      ANALYZE_FIRST_TIMEOUT_MS,
      t0
    );

    return {
      face_detected: data.face_detected ?? false,
      liveness: data.liveness ?? false,
      confidence: data.confidence ?? 0,
      embedding: data.embedding,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      console.log('[DEEPFACE] cold start detected, retrying...');

      try {
        console.log('[DEEPFACE] fetch start');
        const data = await analyzeDeepfaceOnce(
          imageB64,
          extractEmbedding,
          ANALYZE_RETRY_TIMEOUT_MS,
          t0
        );

        return {
          face_detected: data.face_detected ?? false,
          liveness: data.liveness ?? false,
          confidence: data.confidence ?? 0,
          embedding: data.embedding,
        };
      } catch (retryError) {
        const axiosRetryError = retryError as AxiosError;
        console.error('deepface error:', retryError);
        console.error('deepface timeout — code:', axiosRetryError.code);
        return {
          face_detected: false,
          liveness: false,
          confidence: 0,
          error: 'DEEPFACE_UNAVAILABLE',
        };
      }
    }

    const axiosError = error as AxiosError;
    console.error('deepface error:', error);
    console.error('deepface error detail — status:', axiosError.response?.status, 'body:', JSON.stringify(axiosError.response?.data));
    return {
      face_detected: false,
      liveness: false,
      confidence: 0,
      error: 'DEEPFACE_UNAVAILABLE',
    };
  }
}

export async function verifyFaces(
  image1B64: string,
  image2B64: string
): Promise<{ verified: boolean; confidence: number; error?: string }> {
  try {
    const raw1 = image1B64.replace(/^data:image\/\w+;base64,/, '');
    const raw2 = image2B64.replace(/^data:image\/\w+;base64,/, '');
    const bodyStr = JSON.stringify({
      image1_b64: raw1,
      image2_b64: raw2,
    });
    const extraHeaders = config.DEEPFACE_HMAC_SECRET
      ? signRequest(bodyStr, config.DEEPFACE_HMAC_SECRET)
      : {};

    const response = await axios.post<{ verified: boolean; confidence: number }>(
      `${config.DEEPFACE_API_URL}/analyze/verify`,
      bodyStr,
      {
        headers: {
          'X-API-Key': config.DEEPFACE_API_KEY,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        timeout: VERIFY_TIMEOUT_MS,
      }
    );

    return {
      verified: response.data.verified ?? false,
      confidence: response.data.confidence ?? 0,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    console.error('DeepFace verify error:', axiosError.message);
    return {
      verified: false,
      confidence: 0,
      error: 'DEEPFACE_UNAVAILABLE',
    };
  }
}
