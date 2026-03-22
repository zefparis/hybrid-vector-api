-- EDGUARD Rekognition migration: embedding is no longer required.
-- The new enrollment flow does not generate DeepFace embeddings, so the
-- edguard_enrollments.embedding column must allow NULL to avoid insert failures.
ALTER TABLE public.edguard_enrollments
ALTER COLUMN embedding DROP NOT NULL;

COMMENT ON COLUMN public.edguard_enrollments.embedding IS
  'Legacy DeepFace embedding column kept nullable for Rekognition-native enrollments.';
