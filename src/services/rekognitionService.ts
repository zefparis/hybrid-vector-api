import { Buffer } from 'node:buffer';
import {
  CreateCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';

const DEFAULT_AWS_REGION = 'eu-west-1';
const REKOGNITION_TIMEOUT_MS = 4_500;

// Legacy fallback: this env var used to define a single, global collection.
// It can be removed from Fly.io secrets later once all deployments use tenant-scoped collections.
const LEGACY_COLLECTION_ID_FALLBACK = process.env.REKOGNITION_COLLECTION_ID || 'edguard-enrollments';

export function getCollectionId(tenantId: string): string {
  // Normalise: 'edguard-demo' -> 'edguard-enrollments'
  //            'payguard-demo' -> 'payguard-enrollments'
  // Keep a safe fallback for unexpected tenant ids.
  if (!tenantId || typeof tenantId !== 'string') {
    return LEGACY_COLLECTION_ID_FALLBACK;
  }

  const prefix = tenantId.replace(/-demo$/i, '');
  if (!prefix) {
    return LEGACY_COLLECTION_ID_FALLBACK;
  }

  return `${prefix}-enrollments`;
}

const client = new RekognitionClient({
  region: process.env.AWS_REGION || DEFAULT_AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const cleanBase64 = (b64: string): string => b64.replace(/^data:image\/\w+;base64,/, '').trim();

function getImageBytes(imageBase64: string | Buffer): Buffer {
  if (Buffer.isBuffer(imageBase64)) {
    return imageBase64;
  }

  return Buffer.from(cleanBase64(imageBase64), 'base64');
}

async function sendRekognitionCommand<T>(
  operation: string,
  command: any,
  payloadBytes?: Buffer,
): Promise<T> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), REKOGNITION_TIMEOUT_MS);

  try {
    if (payloadBytes) {
      console.log(`[REKOGNITION] ${operation} payload_bytes:`, payloadBytes.byteLength);
    }

    const result = await client.send(command, { abortSignal: controller.signal }) as T;
    console.log(`[REKOGNITION] ${operation} latency:`, Date.now() - startedAt, 'ms');
    return result;
  } catch (error) {
    console.error(`[REKOGNITION] ${operation} failed after`, Date.now() - startedAt, 'ms', error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ensureCollectionExists(): Promise<void> {
  const TENANTS = [
    'edguard-demo',
    'workguard-demo',
    'payguard-demo',
    'accessguard-demo',
    'signguard-demo',
    'playguard-demo',
  ];

  for (const tenantId of TENANTS) {
    await ensureCollectionForTenant(tenantId);
  }

  // PlayGuard uses a dedicated banned collection (not the standard enrollments pattern)
  await ensureCollectionByExactId('playguard-banned');
}

async function ensureCollectionByExactId(collectionId: string): Promise<void> {
  try {
    await sendRekognitionCommand(
      'DescribeCollection',
      new DescribeCollectionCommand({ CollectionId: collectionId })
    );
    console.log('[REKOGNITION] collection exists:', collectionId);
  } catch (error) {
    const err = error as { name?: string };
    if (err.name !== 'ResourceNotFoundException') throw error;
    const response = await sendRekognitionCommand<{ StatusCode?: number }>(
      'CreateCollection',
      new CreateCollectionCommand({ CollectionId: collectionId })
    );
    console.log('[REKOGNITION] collection created:', collectionId, 'status:', response.StatusCode ?? 'unknown');
  }
}

async function ensureCollectionForTenant(tenantId: string): Promise<void> {
  const collectionId = getCollectionId(tenantId);
  try {
    await sendRekognitionCommand(
      'DescribeCollection',
      new DescribeCollectionCommand({
        CollectionId: collectionId,
      })
    );
    console.log('[REKOGNITION] collection exists:', collectionId);
  } catch (error) {
    const err = error as { name?: string };

    if (err.name !== 'ResourceNotFoundException') {
      throw error;
    }

    const response = await sendRekognitionCommand<{ StatusCode?: number }>(
      'CreateCollection',
      new CreateCollectionCommand({
        CollectionId: collectionId,
      })
    );

    console.log('[REKOGNITION] collection created:', collectionId, 'status:', response.StatusCode ?? 'unknown');
  }
}

export async function enrollFace(
  imageBase64: string | Buffer,
  externalImageId: string,
  tenantId: string,
): Promise<{ faceId: string; confidence: number } | null> {
  const imageBytes = getImageBytes(imageBase64);
  const collectionId = getCollectionId(tenantId);
  const response = await sendRekognitionCommand<{ FaceRecords?: Array<{ Face?: { FaceId?: string; Confidence?: number } }> }>(
    'IndexFaces',
    new IndexFacesCommand({
      CollectionId: collectionId,
      Image: { Bytes: imageBytes },
      ExternalImageId: externalImageId,
      DetectionAttributes: ['DEFAULT'],
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    }),
    imageBytes,
  );

  const faceRecord = response.FaceRecords?.[0];
  const face = faceRecord?.Face as { FaceId?: string; Confidence?: number } | undefined;
  const faceId = face?.FaceId ?? '';
  const confidence = face?.Confidence ?? 0;

  if (!faceId) {
    console.warn('[REKOGNITION-ENROLL] No face id returned by IndexFaces');
    return null;
  }

  console.log('[REKOGNITION-ENROLL]', faceId, confidence);
  return { faceId, confidence };
}

export async function searchFaceByImage(
  imageBase64: string | Buffer,
  tenantId: string,
): Promise<{ faceId: string; similarity: number } | null> {
  const imageBytes = getImageBytes(imageBase64);
  const collectionId = getCollectionId(tenantId);
  const response = await sendRekognitionCommand<{ FaceMatches?: Array<{ Similarity?: number; Face?: { FaceId?: string } }> }>(
    'SearchFacesByImage',
    new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: imageBytes },
      MaxFaces: 1,
      FaceMatchThreshold: 70,
      QualityFilter: 'AUTO',
    }),
    imageBytes,
  );

  const match = response.FaceMatches?.[0];
  const face = match?.Face as { FaceId?: string } | undefined;
  const faceId = face?.FaceId ?? '';
  const similarity = match?.Similarity ?? 0;

  if (!match || !faceId) {
    console.log('[REKOGNITION-SEARCH] no match');
    return null;
  }

  console.log('[REKOGNITION-SEARCH]', faceId, similarity);
  return { faceId, similarity };
}

export async function verifyFace(
  imageBase64: string | Buffer,
  expectedFaceId: string,
  tenantId: string,
): Promise<{ matched: boolean; similarity: number; faceId: string }> {
  const result = await searchFaceByImage(imageBase64, tenantId);

  if (!result) {
    return { matched: false, similarity: 0, faceId: '' };
  }

  const matched = Boolean(result.faceId === expectedFaceId && result.similarity >= 80);

  console.log('[REKOGNITION-VERIFY]', result.similarity, matched);

  return { matched, similarity: result.similarity, faceId: result.faceId };
}

export async function detectFacesForAge(
  imageBytes: Buffer
): Promise<{ ageRange: { Low: number; High: number } | null; confidence: number }> {
  const response = await sendRekognitionCommand<{ FaceDetails?: Array<{ AgeRange?: { Low?: number; High?: number }; Confidence?: number }> }>(
    'DetectFaces',
    new DetectFacesCommand({ Image: { Bytes: imageBytes }, Attributes: ['ALL'] }),
    imageBytes
  );
  const face = response.FaceDetails?.[0];
  if (!face) return { ageRange: null, confidence: 0 };
  return {
    ageRange: face.AgeRange ? { Low: face.AgeRange.Low ?? 0, High: face.AgeRange.High ?? 0 } : null,
    confidence: face.Confidence ?? 0,
  };
}

export async function enrollFaceToCollection(
  imageBytes: Buffer,
  externalImageId: string,
  collectionId: string
): Promise<{ faceId: string; confidence: number } | null> {
  const response = await sendRekognitionCommand<{ FaceRecords?: Array<{ Face?: { FaceId?: string; Confidence?: number } }> }>(
    'IndexFaces',
    new IndexFacesCommand({
      CollectionId: collectionId,
      Image: { Bytes: imageBytes },
      ExternalImageId: externalImageId,
      DetectionAttributes: ['DEFAULT'],
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    }),
    imageBytes
  );
  const face = response.FaceRecords?.[0]?.Face as { FaceId?: string; Confidence?: number } | undefined;
  const faceId = face?.FaceId ?? '';
  if (!faceId) return null;
  return { faceId, confidence: face?.Confidence ?? 0 };
}

export async function searchFaceInCollection(
  imageBytes: Buffer,
  collectionId: string,
  threshold = 80
): Promise<{ faceId: string; similarity: number; externalImageId?: string } | null> {
  const response = await sendRekognitionCommand<{ FaceMatches?: Array<{ Similarity?: number; Face?: { FaceId?: string; ExternalImageId?: string } }> }>(
    'SearchFacesByImage',
    new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: imageBytes },
      MaxFaces: 1,
      FaceMatchThreshold: threshold,
      QualityFilter: 'AUTO',
    }),
    imageBytes
  );
  const match = response.FaceMatches?.[0];
  const face = match?.Face as { FaceId?: string; ExternalImageId?: string } | undefined;
  const faceId = face?.FaceId ?? '';
  if (!match || !faceId) return null;
  return { faceId, similarity: match.Similarity ?? 0, externalImageId: face?.ExternalImageId };
}

export async function deleteFaceFromCollection(faceId: string, collectionId: string): Promise<boolean> {
  if (!faceId) return false;
  try {
    await sendRekognitionCommand(
      'DeleteFaces',
      new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: [faceId] })
    );
    console.log('[REKOGNITION-DELETE-COLLECTION]', faceId, collectionId);
    return true;
  } catch (error) {
    console.error('[REKOGNITION-DELETE-COLLECTION] failed:', error);
    return false;
  }
}

export async function describeCollectionSize(collectionId: string): Promise<number> {
  try {
    const response = await sendRekognitionCommand<{ FaceCount?: number }>(
      'DescribeCollection',
      new DescribeCollectionCommand({ CollectionId: collectionId })
    );
    return response.FaceCount ?? 0;
  } catch {
    return 0;
  }
}

export async function deleteFace(faceId: string): Promise<boolean> {
  if (!faceId) {
    return false;
  }

  try {
    await sendRekognitionCommand(
      'DeleteFaces',
      new DeleteFacesCommand({
        // Backward-compat: delete still targets the legacy collection.
        // If we need tenant-scoped deletes later, we can add tenantId as a parameter.
        CollectionId: LEGACY_COLLECTION_ID_FALLBACK,
        FaceIds: [faceId],
      })
    );
    console.log('[REKOGNITION-DELETE]', faceId);
    return true;
  } catch (error) {
    console.error('[REKOGNITION-DELETE] failed:', error);
    return false;
  }
}
