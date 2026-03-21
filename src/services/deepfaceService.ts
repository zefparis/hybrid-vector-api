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

function isRetryableStatus(error: unknown): boolean {
  const axiosError = error as AxiosError;
  const status = axiosError.response?.status;
  return status === 502 || status === 503;
}

function truncateBody(data: unknown, maxLen = 200): string {
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  if (!raw) return '(empty)';
  return raw.length > maxLen ? raw.substring(0, maxLen) + `... (${raw.length} chars total)` : raw;
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
    detector_backend: config.DEEPFACE_DETECTOR_BACKEND,
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
  console.log('[DEEPFACE] full response:', JSON.stringify(data));

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
    const axiosError = error as AxiosError;

    // Retry on timeout or 502/503 (Render cold start / deploy in progress)
    if (isTimeoutError(error) || isRetryableStatus(error)) {
      const reason = isTimeoutError(error) ? 'timeout' : `HTTP ${axiosError.response?.status}`;
      console.log(`[DEEPFACE] ${reason} detected, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));

      try {
        console.log('[DEEPFACE] retry fetch start');
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
        console.error('[DEEPFACE] retry failed — code:', axiosRetryError.code, 'status:', axiosRetryError.response?.status);
        return {
          face_detected: false,
          liveness: false,
          confidence: 0,
          error: 'DEEPFACE_UNAVAILABLE',
        };
      }
    }

    console.error('[DEEPFACE] error — status:', axiosError.response?.status, 'message:', axiosError.message, 'body:', truncateBody(axiosError.response?.data));
    return {
      face_detected: false,
      liveness: false,
      confidence: 0,
      error: 'DEEPFACE_UNAVAILABLE',
    };
  }
}

async function verifyFacesOnce(
  raw1: string,
  raw2: string,
  timeoutMs: number,
  t0: number
): Promise<{ verified: boolean; confidence: number }> {
  const bodyStr = JSON.stringify({
    image1_b64: raw1,
    image2_b64: raw2,
    detector_backend: config.DEEPFACE_DETECTOR_BACKEND,
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
      timeout: timeoutMs,
    }
  );

  console.log(`[DEEPFACE-VERIFY] done: ${Date.now() - t0}ms, status:`, response.status);
  console.log('[DEEPFACE-VERIFY] verified:', response.data.verified, 'confidence:', response.data.confidence);

  return {
    verified: response.data.verified ?? false,
    confidence: response.data.confidence ?? 0,
  };
}

export async function verifyFaces(
  image1B64: string,
  image2B64: string
): Promise<{ verified: boolean; confidence: number; error?: string }> {
  const t0 = Date.now();
  const raw1 = image1B64.replace(/^data:image\/\w+;base64,/, '');
  const raw2 = image2B64.replace(/^data:image\/\w+;base64,/, '');
  console.log('[DEEPFACE-VERIFY] image1 length:', raw1.length, 'image2 length:', raw2.length);

  try {
    return await verifyFacesOnce(raw1, raw2, ANALYZE_FIRST_TIMEOUT_MS, t0);
  } catch (error) {
    const axiosError = error as AxiosError;

    // Retry on timeout or 502/503 (Render cold start / deploy in progress)
    if (isTimeoutError(error) || isRetryableStatus(error)) {
      const reason = isTimeoutError(error) ? 'timeout' : `HTTP ${axiosError.response?.status}`;
      console.log(`[DEEPFACE-VERIFY] ${reason} detected, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return await verifyFacesOnce(raw1, raw2, VERIFY_TIMEOUT_MS, t0);
      } catch (retryError) {
        const axiosRetryError = retryError as AxiosError;
        console.error('[DEEPFACE-VERIFY] retry failed — code:', axiosRetryError.code, 'status:', axiosRetryError.response?.status);
        return { verified: false, confidence: 0, error: 'DEEPFACE_UNAVAILABLE' };
      }
    }

    console.error('[DEEPFACE-VERIFY] error — status:', axiosError.response?.status, 'message:', axiosError.message, 'body:', truncateBody(axiosError.response?.data));
    return { verified: false, confidence: 0, error: 'DEEPFACE_UNAVAILABLE' };
  }
}
