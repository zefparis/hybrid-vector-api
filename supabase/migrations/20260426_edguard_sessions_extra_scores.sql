-- EdGuard /auth-payment enrichment — additional scores written by
-- POST /edguard/auth-payment-signals after the selfie + voice + reflex flow.

ALTER TABLE edguard_sessions
  ADD COLUMN IF NOT EXISTS vocal_score      float,
  ADD COLUMN IF NOT EXISTS reflex_score     float,
  ADD COLUMN IF NOT EXISTS behavioral_score float,
  ADD COLUMN IF NOT EXISTS reaction_ms      int;
