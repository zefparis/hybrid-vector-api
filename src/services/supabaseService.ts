import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

const serviceKey = config.SUPABASE_SERVICE_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
console.log('[SUPABASE] URL:', config.SUPABASE_URL?.slice(0, 30) ?? '(not set)');
console.log('[SUPABASE] key source:', config.SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY' : config.SUPABASE_SERVICE_ROLE_KEY ? 'SUPABASE_SERVICE_ROLE_KEY' : '(not set)');

export const supabase =
  config.SUPABASE_URL && serviceKey
    ? createClient(config.SUPABASE_URL, serviceKey)
    : null;
