import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

console.log('[SUPABASE] URL:', config.SUPABASE_URL?.slice(0, 30) ?? '(not set)');

export const supabase =
  config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY
    ? createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    : null;
