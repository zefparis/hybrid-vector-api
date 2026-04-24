/**
 * WorkGuard — ID verification via Self SDK (NFC passport / national ID proof).
 *
 * POST /workguard/verify-id
 *   Auth:    X-Admin-Key  (same X-Admin-Key convention as /admin/*)
 *   Body:    { proof, publicSignals, userId?, tenant_id? }
 *   Returns: { success, name?, nationality?, dateOfBirth?, isAdult?, documentValid?, error? }
 *
 * The X-Admin-Key check mirrors the one in routes/admin.ts. It is inlined here
 * to avoid mutating admin.ts (per scope constraints). Any change to the auth
 * rule must be kept in sync across both files.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { SelfBackendVerifier, AllIds, DefaultConfigStore } from '@selfxyz/core';
import { AppError } from '../types';

const router = Router();

// ─── Auth ────────────────────────────────────────────────────────────────────

function extractAdminKey(req: Request): string | undefined {
  const raw = req.headers['x-admin-key'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function adminAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') return next();

  const expected = process.env.HV_ADMIN_KEY;
  const provided = extractAdminKey(req);

  if (!expected) {
    next(new AppError(500, 'HV_ADMIN_KEY_NOT_CONFIGURED', 'HV_ADMIN_KEY is not configured'));
    return;
  }
  if (!provided) {
    next(new AppError(403, 'MISSING_ADMIN_KEY', 'X-Admin-Key header is required'));
    return;
  }
  if (provided !== expected) {
    next(new AppError(403, 'INVALID_ADMIN_KEY', 'Invalid admin key'));
    return;
  }
  next();
}

router.use(adminAuth);

// ─── Self verifier (lazy singleton) ──────────────────────────────────────────
//
// The @selfxyz/core SelfBackendVerifier constructor signature (v1.x):
//   new SelfBackendVerifier(
//     scope, endpoint, mockPassport, allowedIds, configStorage, userIdentifierType,
//   )
//
// Config is sourced from env:
//   SELF_SCOPE           (defaults to 'workguard-enrollment')
//   SELF_ENDPOINT        (public URL of this /workguard/verify-id, required)
//   SELF_MOCK_PASSPORT   ('true' on staging/dev; default false)
//   SELF_MINIMUM_AGE     (integer; default 18 — enforced by verifier config)
//   SELF_USER_ID_TYPE    ('uuid' | 'hex'; default 'uuid')
//
// SELF_SCOPE_SECRET is accepted for forward-compat / documentation but is not
// a constructor argument in the current SDK — keeping the env makes deploys
// forgiving if a later SDK bump re-introduces it.

const DEFAULT_SCOPE = 'workguard-enrollment';

let _verifier: SelfBackendVerifier | null = null;
function getVerifier(): SelfBackendVerifier {
  if (_verifier) return _verifier;

  const scope = process.env.SELF_SCOPE || DEFAULT_SCOPE;
  const endpoint = process.env.SELF_ENDPOINT;
  if (!endpoint) {
    throw new AppError(
      500,
      'SELF_ENDPOINT_NOT_CONFIGURED',
      'SELF_ENDPOINT is not configured (public URL of /workguard/verify-id)',
    );
  }

  const mockPassport = process.env.SELF_MOCK_PASSPORT === 'true';
  const minimumAge = Number(process.env.SELF_MINIMUM_AGE || 18);
  const userIdentifierType = (process.env.SELF_USER_ID_TYPE === 'hex' ? 'hex' : 'uuid') as 'hex' | 'uuid';

  const configStore = new DefaultConfigStore({
    minimumAge: Number.isFinite(minimumAge) ? minimumAge : 18,
    ofac: false,
  });

  _verifier = new SelfBackendVerifier(
    scope,
    endpoint,
    mockPassport,
    AllIds,
    configStore,
    // The SDK's UserIdType lives in @selfxyz/common; cast defensively.
    userIdentifierType as unknown as ConstructorParameters<typeof SelfBackendVerifier>[5],
  );
  return _verifier;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickString(src: unknown, keys: string[]): string | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const obj = src as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickBool(src: unknown, keys: string[]): boolean | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const obj = src as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.post('/verify-id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Real SDK verify(attestationId, proof, pubSignals, userContextData)
    // - attestationId: 1 = biometric passport, 2 = national ID
    // - userContextData: opaque string the client embeds (typically = userId)
    const {
      proof,
      publicSignals,
      attestationId,
      userContextData,
      userId,
    } = (req.body ?? {}) as {
      proof?: unknown;
      publicSignals?: unknown;
      attestationId?: unknown;
      userContextData?: unknown;
      userId?: unknown;
      tenant_id?: unknown;
    };

    if (!proof || !publicSignals) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'Body must include { proof, publicSignals }',
      });
    }

    // Default to national ID (2) when absent — most likely use-case for WorkGuard (ZA ID).
    // Client should send attestationId explicitly when scanning a biometric passport (1).
    const attId =
      attestationId === 1 || attestationId === 2
        ? (attestationId as 1 | 2)
        : (2 as 1 | 2);

    const ctx =
      typeof userContextData === 'string'
        ? userContextData
        : typeof userId === 'string'
          ? userId
          : '';

    const verifier = getVerifier();

    // Signal shape accepted by SDK is BigNumberish[]; client sends a JSON array
    // of decimal strings or numbers. Cast defensively.
    const result = await verifier.verify(
      attId,
      proof as Parameters<typeof verifier.verify>[1],
      publicSignals as Parameters<typeof verifier.verify>[2],
      ctx,
    );

    const valid = result.isValidDetails?.isValid === true;
    const disclose = result.discloseOutput ?? ({} as Record<string, unknown>);

    const name = pickString(disclose, ['name']);
    const nationality = pickString(disclose, ['nationality', 'issuingState']);
    const dateOfBirth = pickString(disclose, ['dateOfBirth']);
    // SDK sets isMinimumAgeValid based on configStore.minimumAge (18 by default).
    const isAdult = pickBool(result.isValidDetails, ['isMinimumAgeValid']);

    if (!valid) {
      return res.status(200).json({
        success: false,
        documentValid: false,
        error: 'PROOF_INVALID',
      });
    }

    return res.status(200).json({
      success: true,
      name,
      nationality,
      dateOfBirth,
      isAdult,
      documentValid: true,
    });
  } catch (e) {
    // Surface SDK validation errors as 400 success:false rather than 500.
    if (e instanceof AppError) return next(e);
    const message = e instanceof Error ? e.message : 'Verification failed';
    return res.status(200).json({
      success: false,
      documentValid: false,
      error: message,
    });
  }
});

export default router;
