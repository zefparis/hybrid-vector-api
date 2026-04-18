import crypto from 'crypto';
import { supabase } from '../../services/supabaseService';
import { AppError } from '../../types';
import { ThreatSubmit, ThreatFeedItem } from '../ctn.types';

const TTL_HOURS = 72;

async function resolveActiveNode(
  apiKey: string,
): Promise<{ id: string }> {
  const client = supabase;
  if (!client) {
    throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
  }

  const { data, error } = await client
    .from('ctn_nodes')
    .select('id, status')
    .eq('api_key', apiKey)
    .maybeSingle();

  if (error) {
    throw new AppError(500, 'DB_QUERY_FAILED', error.message);
  }
  if (!data) {
    throw new AppError(401, 'INVALID_API_KEY', 'Invalid or unrecognised API key');
  }
  if (data.status !== 'active') {
    throw new AppError(403, 'NODE_NOT_ACTIVE', 'Your node is not yet active in the CTN');
  }

  return { id: data.id };
}

export class ThreatPoolService {
  async submitThreat(api_key: string, data: ThreatSubmit): Promise<void> {
    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    const node = await resolveActiveNode(api_key);

    const pattern_hash = crypto
      .createHash('sha256')
      .update(data.pattern)
      .digest('hex');

    const now = new Date();
    const expires_at = new Date(now.getTime() + TTL_HOURS * 60 * 60 * 1000).toISOString();

    // Idempotency: skip if same pattern_hash already exists and has not expired
    const { data: existing, error: checkError } = await client
      .from('ctn_threats')
      .select('id')
      .eq('pattern_hash', pattern_hash)
      .gt('expires_at', now.toISOString())
      .maybeSingle();

    if (checkError) {
      throw new AppError(500, 'DB_QUERY_FAILED', checkError.message);
    }
    if (existing) {
      return; // already present and not expired — idempotent, no error
    }

    const { error: insertError } = await client.from('ctn_threats').insert({
      pattern_hash,
      vector_type: data.vector_type,
      severity: data.severity,
      source_node_id: node.id,
      expires_at,
    });

    if (insertError) {
      throw new AppError(500, 'DB_INSERT_FAILED', insertError.message);
    }
  }

  async getFeed(api_key: string): Promise<ThreatFeedItem[]> {
    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    const node = await resolveActiveNode(api_key);

    const now = new Date().toISOString();

    const { data, error } = await client
      .from('ctn_threats')
      .select('id, pattern_hash, vector_type, severity, detected_at, expires_at, source_node_id')
      .gt('expires_at', now)
      .neq('source_node_id', node.id)
      .order('detected_at', { ascending: false })
      .limit(100);

    if (error) {
      throw new AppError(500, 'DB_QUERY_FAILED', error.message);
    }

    return (data ?? []).map((t) => ({
      id: t.id,
      pattern_hash: t.pattern_hash,
      vector_type: t.vector_type,
      severity: t.severity,
      detected_at: t.detected_at,
      expires_at: t.expires_at,
    }));
  }
}
