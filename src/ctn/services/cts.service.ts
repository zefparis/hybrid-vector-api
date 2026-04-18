import crypto from 'crypto';
import { supabase } from '../../services/supabaseService';
import { AppError } from '../../types';
import { CTSResult } from '../ctn.types';

const SEVERITY_PENALTY: Record<number, number> = {
  5: 15,
  4: 10,
  3: 5,
  2: 2,
  1: 2,
};
const NETWORK_CONFIDENCE_BONUS = 5;
const NETWORK_CONFIDENCE_THRESHOLD = 3;

async function resolveActiveNode(apiKey: string): Promise<{ id: string }> {
  const client = supabase;
  if (!client) {
    throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
  }

  const { data, error } = await client
    .from('ctn_nodes')
    .select('id, status')
    .eq('api_key', apiKey)
    .maybeSingle();

  if (error) throw new AppError(500, 'DB_QUERY_FAILED', error.message);
  if (!data) throw new AppError(401, 'INVALID_API_KEY', 'Invalid or unrecognised API key');
  if (data.status !== 'active') throw new AppError(403, 'NODE_NOT_ACTIVE', 'Your node is not yet active in the CTN');

  return { id: data.id };
}

export class CTSService {
  async computeScore(api_key: string, user_identifier: string): Promise<CTSResult> {
    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    await resolveActiveNode(api_key);

    const user_hash = crypto.createHash('sha256').update(user_identifier).digest('hex');
    const now = new Date().toISOString();

    // Fetch all non-expired threats from the entire network
    const { data: threats, error: threatError } = await client
      .from('ctn_threats')
      .select('severity, source_node_id')
      .gt('expires_at', now);

    if (threatError) throw new AppError(500, 'DB_QUERY_FAILED', threatError.message);

    // v1 score: start at 100, deduct per severity
    let raw = 100;
    const activeThreats = threats ?? [];

    for (const t of activeThreats) {
      raw -= SEVERITY_PENALTY[t.severity] ?? 2;
    }

    // Count distinct contributing nodes
    const nodeSet = new Set(activeThreats.map((t) => t.source_node_id).filter(Boolean));
    const contributing_nodes = nodeSet.size || 1;

    if (contributing_nodes > NETWORK_CONFIDENCE_THRESHOLD) {
      raw += NETWORK_CONFIDENCE_BONUS;
    }

    const score = Math.min(100, Math.max(0, raw));

    // confidence: ratio of contributing nodes (capped at 1.0), minimum 0.1
    const confidence = Math.min(1, Math.max(0.1, contributing_nodes / 10));

    const updated_at = new Date().toISOString();

    // Upsert into ctn_scores (user_hash is unique)
    const { error: upsertError } = await client.from('ctn_scores').upsert(
      {
        user_hash,
        score,
        confidence,
        contributing_nodes,
        updated_at,
      },
      { onConflict: 'user_hash' },
    );

    if (upsertError) throw new AppError(500, 'DB_UPSERT_FAILED', upsertError.message);

    return { user_hash, score, confidence, contributing_nodes, updated_at };
  }

  async getScore(api_key: string, user_hash: string): Promise<CTSResult | null> {
    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    await resolveActiveNode(api_key);

    const { data, error } = await client
      .from('ctn_scores')
      .select('user_hash, score, confidence, contributing_nodes, updated_at')
      .eq('user_hash', user_hash)
      .maybeSingle();

    if (error) throw new AppError(500, 'DB_QUERY_FAILED', error.message);
    if (!data) return null;

    return {
      user_hash: data.user_hash,
      score: Number(data.score),
      confidence: Number(data.confidence),
      contributing_nodes: data.contributing_nodes,
      updated_at: data.updated_at,
    };
  }
}
