const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3008'
const API_KEY = process.env.NEXT_PUBLIC_SG_API_KEY || ''

const headers = () => ({
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
})

export async function scanWorker(selfie_b64: string, worker_id?: string, site_id?: string) {
  const res = await fetch(`${API_URL}/siteguard/scan`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ selfie_b64, worker_id, site_id }),
  })
  if (!res.ok) throw new Error(`Scan failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; result: any }>
}

export async function enrollWorker(
  selfie_b64: string,
  external_id: string,
  name: string,
  role: string,
  site_id: string,
  certifications: string[]
) {
  const res = await fetch(`${API_URL}/siteguard/enroll`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ selfie_b64, external_id, name, role, site_id, certifications }),
  })
  if (!res.ok) throw new Error(`Enroll failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; faceId: string; name: string; enrolledAt: string }>
}

export async function addBlacklist(selfie_b64: string, external_id: string, reason: string, operator: string) {
  const res = await fetch(`${API_URL}/siteguard/blacklist`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ selfie_b64, external_id, reason, operator }),
  })
  if (!res.ok) throw new Error(`Blacklist failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; faceId: string; bannedAt: string }>
}

export async function unenrollWorker(faceId: string) {
  const res = await fetch(`${API_URL}/siteguard/enroll/${faceId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) throw new Error(`Unenroll failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; faceId: string }>
}

export async function removeBlacklist(faceId: string) {
  const res = await fetch(`${API_URL}/siteguard/blacklist/${faceId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) throw new Error(`Remove failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; faceId: string }>
}

export async function getStatus() {
  const res = await fetch(`${API_URL}/siteguard/status`, { headers: headers() })
  if (!res.ok) throw new Error(`Status failed: ${res.status}`)
  return res.json() as Promise<{
    success: boolean
    collectionAuthorized: string
    collectionBlacklisted: string
    authorizedCount: number
    blacklistedCount: number
    queueSize?: number
    awsRegion: string
    mode?: 'UPLOAD' | 'COLLECT'
    authorizedThreshold: number
    blacklistThreshold: number
  }>
}

export async function getEvents(verdict?: string, site_id?: string, limit = 50) {
  const url = new URL(`${API_URL}/siteguard/events`)
  if (verdict) url.searchParams.set('verdict', verdict)
  if (site_id) url.searchParams.set('site_id', site_id)
  url.searchParams.set('limit', limit.toString())
  const res = await fetch(url.toString(), { headers: headers() })
  if (!res.ok) throw new Error(`Events failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; events: any[]; source: string }>
}

export async function getWorkers(site_id?: string, limit = 100) {
  const url = new URL(`${API_URL}/siteguard/workers`)
  if (site_id) url.searchParams.set('site_id', site_id)
  url.searchParams.set('limit', limit.toString())
  const res = await fetch(url.toString(), { headers: headers() })
  if (!res.ok) throw new Error(`Workers failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; workers: any[] }>
}

export async function getBlacklist(limit = 100) {
  const url = new URL(`${API_URL}/siteguard/blacklist`)
  url.searchParams.set('limit', limit.toString())
  const res = await fetch(url.toString(), { headers: headers() })
  if (!res.ok) throw new Error(`Blacklist failed: ${res.status}`)
  return res.json() as Promise<{ success: boolean; blacklist: any[] }>
}
