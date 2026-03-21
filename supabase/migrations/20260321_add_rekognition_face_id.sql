-- Add Rekognition face ID storage for EDGUARD enrollments.
-- Safe to run multiple times.
ALTER TABLE public.edguard_enrollments
ADD COLUMN IF NOT EXISTS rekognition_face_id TEXT;

COMMENT ON COLUMN public.edguard_enrollments.rekognition_face_id IS
  'AWS Rekognition FaceId stored during EDGUARD enrollment.';
