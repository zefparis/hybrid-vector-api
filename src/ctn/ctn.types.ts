export type NodeTier = 'shadow' | 'standard' | 'enterprise';
export type NodeStatusValue = 'pending' | 'active' | 'suspended';

export interface JoinRequest {
  institution_name: string;
  cname_domain: string;
  tier: NodeTier;
}

export interface JoinResponse {
  node_id: string;
  api_key: string;
  cname_target: string;
  dns_instructions: string;
}

export interface NodeStatus {
  node_id: string;
  institution_name: string;
  tier: string;
  status: string;
  last_seen: string | null;
}

export type VectorType = 'bot' | 'spoofing' | 'replay' | 'cognitive_attack';

export interface ThreatSubmit {
  pattern: string;
  vector_type: VectorType;
  severity: 1 | 2 | 3 | 4 | 5;
}

export interface ThreatFeedItem {
  id: string;
  pattern_hash: string;
  vector_type: string;
  severity: number;
  detected_at: string;
  expires_at: string;
}

export interface CTSResult {
  user_hash: string;
  score: number;
  confidence: number;
  contributing_nodes: number;
  updated_at: string;
}
