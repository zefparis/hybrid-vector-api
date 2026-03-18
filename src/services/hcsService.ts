import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { HcsScoreResponse } from '../types';

const TIMEOUT_MS = 15000;

interface HcsApiResponse {
  score: number;
  passed: boolean;
  test_type?: string;
}

export async function getCognitiveScore(
  cognitiveSessionId: string
): Promise<HcsScoreResponse> {
  try {
    const response = await axios.get<HcsApiResponse>(
      `${config.HCS_API_URL}/api/sessions/${cognitiveSessionId}/score`,
      {
        headers: {
          'X-API-Key': config.HCS_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );

    const data = response.data;

    return {
      score: data.score ?? 0,
      passed: data.passed ?? false,
      test_type: data.test_type,
    };
  } catch (error) {
    const axiosError = error as AxiosError;

    if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
      console.error('HCS API timeout');
      return {
        score: 0,
        passed: false,
        error: 'HCS_UNAVAILABLE',
      };
    }

    console.error('HCS API error:', axiosError.message);
    return {
      score: 0,
      passed: false,
      error: 'HCS_UNAVAILABLE',
    };
  }
}
