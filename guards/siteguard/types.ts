export type SiteGuardVerdict = 'AUTHORIZED' | 'UNAUTHORIZED' | 'BLACKLISTED';

export interface SiteScanResult {
  scanId: string;
  workerId: string;
  siteId: string;
  verdict: SiteGuardVerdict;
  access: boolean;
  worker?: { name: string; role: string; certifications: string[] };
  blacklist?: { detected: boolean; similarity?: number; reason?: string };
  authorized?: { detected: boolean; similarity?: number; faceId?: string };
  faceConfidence: number;
  timestamp: string;
}

export interface WorkerRecord {
  faceId: string;
  externalId: string;
  name: string;
  role: string;
  siteId: string;
  certifications: string[];
  enrolledAt: string;
}
