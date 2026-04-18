import crypto from 'crypto';
import { supabase } from '../../services/supabaseService';
import { AppError } from '../../types';
import { JoinRequest, JoinResponse } from '../ctn.types';

const CTN_CNAME_TARGET = 'ctn.hmh-platform.com';

export class NetworkService {
  async joinNetwork(data: JoinRequest): Promise<JoinResponse> {
    const client = supabase;
    if (!client) {
      throw new AppError(500, 'SUPABASE_NOT_CONFIGURED', 'Supabase is not configured');
    }

    const uuid = crypto.randomUUID();
    const timestamp = Date.now().toString();
    const api_key = `ctn_${crypto
      .createHash('sha256')
      .update(`${uuid}:${timestamp}`)
      .digest('hex')
      .slice(0, 48)}`;

    const { data: node, error } = await client
      .from('ctn_nodes')
      .insert({
        institution_name: data.institution_name,
        cname_domain: data.cname_domain,
        tier: data.tier,
        api_key,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'DOMAIN_ALREADY_EXISTS', 'This cname_domain is already registered in the CTN');
      }
      throw new AppError(500, 'DB_INSERT_FAILED', error.message);
    }

    const dns_instructions = [
      'Add the following DNS CNAME record to your domain registrar:',
      '',
      `  Name (Host):  ${data.cname_domain}`,
      `  Type:         CNAME`,
      `  Value:        ${CTN_CNAME_TARGET}`,
      `  TTL:          3600`,
      '',
      'Once DNS has propagated your node will be activated automatically (up to 24 h).',
      `Your API key is shown once — store it securely.`,
    ].join('\n');

    return {
      node_id: node.id,
      api_key,
      cname_target: CTN_CNAME_TARGET,
      dns_instructions,
    };
  }
}
