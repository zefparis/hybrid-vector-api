import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

export const supabase =
  config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY
    ? createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    : null;
