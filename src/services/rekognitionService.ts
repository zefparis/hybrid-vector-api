import { Buffer } from 'node:buffer';
import {
  CreateCollectionCommand,
  DeleteFacesCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';

const COLLECTION_ID = 'edguard-enrollments';

const client = new RekognitionClient({
  region: process.env.AWS_REGION || 'eu-central-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const cleanBase64 = (b64: string): string => b64.replace(/^data:image\/\w+;base64,/, '').trim();

function getImageBytes(imageBase64: string): Buffer {
  return Buffer.from(cleanBase64(imageBase64), 'base64');
}

export async function ensureCollectionExists(): Promise<void> {
  try {
    await client.send(
      new DescribeCollectionCommand({
        CollectionId: COLLECTION_ID,
      })
    );
    console.log('[REKOGNITION] collection exists:', COLLECTION_ID);
  } catch (error) {
    const err = error as { name?: string };

    if (err.name !== 'ResourceNotFoundException') {
      throw error;
    }

    const response = await client.send(
      new CreateCollectionCommand({
        CollectionId: COLLECTION_ID,
      })
    );

    console.log('[REKOGNITION] collection created:', COLLECTION_ID, 'status:', response.StatusCode ?? 'unknown');
  }
}

export async function enrollFace(
  imageBase64: string,
  externalImageId: string,
): Promise<{ faceId: string; confidence: number } | null> {
  const response = await client.send(
    new IndexFacesCommand({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: getImageBytes(imageBase64) },
      ExternalImageId: externalImageId,
      DetectionAttributes: ['DEFAULT'],
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    })
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
  imageBase64: string,
): Promise<{ faceId: string; similarity: number } | null> {
  const response = await client.send(
    new SearchFacesByImageCommand({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: getImageBytes(imageBase64) },
      MaxFaces: 1,
      FaceMatchThreshold: 70,
      QualityFilter: 'AUTO',
    })
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
  imageBase64: string,
  expectedFaceId: string
): Promise<{ matched: boolean; similarity: number; faceId: string }> {
  const result = await searchFaceByImage(imageBase64);

  if (!result) {
    return { matched: false, similarity: 0, faceId: '' };
  }

  const matched = Boolean(result.faceId === expectedFaceId && result.similarity >= 80);

  console.log('[REKOGNITION-VERIFY]', result.similarity, matched);

  return { matched, similarity: result.similarity, faceId: result.faceId };
}

export async function deleteFace(faceId: string): Promise<boolean> {
  if (!faceId) {
    return false;
  }

  try {
    await client.send(
      new DeleteFacesCommand({
        CollectionId: COLLECTION_ID,
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
