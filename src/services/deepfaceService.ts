import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { DeepfaceAnalyzeResponse } from '../types';

const TIMEOUT_MS = 15000;

interface DeepfaceApiResponse {
  face_detected: boolean;
  liveness?: boolean;
  confidence?: number;
  embedding?: number[];
}

export async function analyzeface(
  imageB64: string,
  extractEmbedding: boolean = false
): Promise<DeepfaceAnalyzeResponse> {
  console.log('face_b64 length:', imageB64?.length ?? 0);
  console.log('face_b64 prefix (first 50):', imageB64?.slice(0, 50) ?? '');

  try {
    const response = await axios.post<DeepfaceApiResponse>(
      `${config.DEEPFACE_API_URL}/analyze`,
      {
        image_b64: imageB64,
        extract_embedding: extractEmbedding,
      },
      {
        headers: {
          'X-API-Key': config.DEEPFACE_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );

    const data = response.data;
    console.log('deepface response:', JSON.stringify(data));

    return {
      face_detected: data.face_detected ?? false,
      liveness: data.liveness ?? false,
      confidence: data.confidence ?? 0,
      embedding: data.embedding,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    
    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
      console.error('deepface error:', error);
      console.error('deepface timeout — code:', axiosError.code);
      return {
        face_detected: false,
        liveness: false,
        confidence: 0,
        error: 'DEEPFACE_UNAVAILABLE',
      };
    }

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
    const response = await axios.post<{ verified: boolean; confidence: number }>(
      `${config.DEEPFACE_API_URL}/analyze/verify`,
      {
        image1_b64: image1B64,
        image2_b64: image2B64,
      },
      {
        headers: {
          'X-API-Key': config.DEEPFACE_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
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
