'use strict'

require('dotenv').config()

const Fastify  = require('fastify')
const multipart = require('@fastify/multipart')
const fs       = require('node:fs')
const path     = require('node:path')
const crypto   = require('node:crypto')

const {
  RekognitionClient,
  DetectFacesCommand,
  SearchFacesByImageCommand,
  IndexFacesCommand,
  DeleteFacesCommand,
  CreateCollectionCommand,
  ListFacesCommand,
} = require('@aws-sdk/client-rekognition')

// ── Config ─────────────────────────────────────────────────────────────────────

const SG_API_KEY              = process.env.SG_API_KEY              || 'change-me'
const COLLECTION_AUTHORIZED   = process.env.SG_COLLECTION_AUTHORIZED || 'hv-siteguard-authorized'
const COLLECTION_BLACKLISTED  = process.env.SG_COLLECTION_BLACKLISTED|| 'hv-siteguard-blacklisted'
const AUTHORIZED_THRESHOLD    = parseFloat(process.env.SG_AUTHORIZED_THRESHOLD || '85')
const BLACKLIST_THRESHOLD     = parseFloat(process.env.SG_BLACKLIST_THRESHOLD  || '90')
const AWS_REGION              = process.env.AWS_REGION              || 'af-south-1'
const PORT                    = parseInt(process.env.PORT            || '3008', 10)
const QUEUE_PATH              = process.env.SG_QUEUE_PATH           || path.join(process.cwd(), 'siteguard-queue.json')

// ── AWS client ─────────────────────────────────────────────────────────────────

const rekognition = new RekognitionClient({ region: AWS_REGION })

// ── Supabase (optional — COLLECT mode if unreachable) ─────────────────────────

let supabase = null
let supabaseAvailable = false

async function initSupabase () {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.warn('[SUPABASE] No credentials — COLLECT mode active')
    return
  }
  try {
    const { createClient } = require('@supabase/supabase-js')
    supabase = createClient(url, key)
    const { error } = await supabase.from('siteguard_events').select('count').limit(1)
    if (error) throw new Error(error.message)
    supabaseAvailable = true
    console.log('[SUPABASE] Connected ✓')
  } catch (e) {
    supabaseAvailable = false
    console.warn('[SUPABASE] Unreachable — COLLECT mode active:', e.message)
  }
}

// ── Offline queue ──────────────────────────────────────────────────────────────

function loadQueue () {
  try {
    if (fs.existsSync(QUEUE_PATH)) return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'))
  } catch {}
  return []
}

function saveQueue (q) {
  try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2), 'utf8') } catch {}
}

function enqueue (item) {
  const q = loadQueue()
  q.push(item)
  saveQueue(q)
}

// ── Rekognition helpers ────────────────────────────────────────────────────────

async function ensureCollection (collectionId) {
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: collectionId }))
    console.log(`[REKOGNITION] Collection created: ${collectionId}`)
  } catch (e) {
    if (e.name === 'ResourceAlreadyExistsException') {
      console.log(`[REKOGNITION] Collection ready: ${collectionId}`)
    } else {
      throw e
    }
  }
}

function cleanBase64 (b64) {
  return b64.replace(/^data:image\/[a-z]+;base64,/, '')
}

async function detectFaces (imageBytes) {
  const res = await rekognition.send(new DetectFacesCommand({
    Image: { Bytes: imageBytes },
    Attributes: ['DEFAULT'],
  }))
  return res.FaceDetails ?? []
}

async function searchFace (collectionId, imageBytes, threshold) {
  try {
    const res = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId:       collectionId,
      Image:              { Bytes: imageBytes },
      MaxFaces:           1,
      FaceMatchThreshold: threshold,
    }))
    const match = (res.FaceMatches ?? [])[0]
    if (match) {
      return {
        detected:    true,
        similarity:  match.Similarity,
        faceId:      match.Face?.FaceId,
        externalId:  match.Face?.ExternalImageId,
      }
    }
    return { detected: false }
  } catch (e) {
    if (e.name === 'InvalidParameterException') return { detected: false }
    throw e
  }
}

async function collectionSize (collectionId) {
  let count = 0
  let nextToken
  try {
    do {
      const res = await rekognition.send(new ListFacesCommand({
        CollectionId: collectionId,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))
      count += (res.Faces ?? []).length
      nextToken = res.NextToken
    } while (nextToken)
  } catch (e) {
    console.warn(`[REKOGNITION] ListFaces(${collectionId}) failed:`, e.message)
  }
  return count
}

// ── Auth hook ──────────────────────────────────────────────────────────────────

async function authHook (request, reply) {
  if (request.headers['x-siteguard-key'] !== SG_API_KEY) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
}

// ── Fastify setup ──────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true })

fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

fastify.addHook('onSend', async (_request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*')
  reply.header('Access-Control-Allow-Headers', 'Content-Type, x-siteguard-key')
  reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
})

fastify.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') return reply.code(204).send()
})

// ── POST /siteguard/scan ───────────────────────────────────────────────────────

fastify.post('/siteguard/scan', { preHandler: authHook }, async (request, reply) => {
  const scanId    = crypto.randomUUID()
  const timestamp = new Date().toISOString()
  let imageBytes

  const contentType = request.headers['content-type'] ?? ''

  if (contentType.includes('multipart/form-data')) {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })
    imageBytes = await data.toBuffer()
  } else {
    const body = request.body
    if (!body?.image) return reply.code(400).send({ error: 'Missing image field' })
    imageBytes = Buffer.from(cleanBase64(body.image), 'base64')
  }

  const [faceDetails, blacklistResult, authorizedResult] = await Promise.all([
    detectFaces(imageBytes),
    searchFace(COLLECTION_BLACKLISTED, imageBytes, BLACKLIST_THRESHOLD),
    searchFace(COLLECTION_AUTHORIZED,  imageBytes, AUTHORIZED_THRESHOLD),
  ])

  const face = faceDetails[0]
  if (!face) return reply.code(422).send({ error: 'No face detected in image' })

  const faceConfidence = face.Confidence ?? 0

  // Priority: BLACKLISTED > UNAUTHORIZED > AUTHORIZED
  let verdict = 'UNAUTHORIZED'
  if (blacklistResult.detected)    verdict = 'BLACKLISTED'
  else if (authorizedResult.detected) verdict = 'AUTHORIZED'

  const workerPayload = authorizedResult.detected
    ? {
        name:           request.body?.workerName  ?? authorizedResult.externalId ?? '',
        role:           request.body?.role         ?? '',
        certifications: [],
      }
    : undefined

  const result = {
    scanId,
    workerId:  request.body?.workerId  ?? '',
    siteId:    request.body?.siteId    ?? '',
    verdict,
    access:    verdict === 'AUTHORIZED',
    worker:    workerPayload,
    blacklist: { detected: blacklistResult.detected, similarity: blacklistResult.similarity },
    authorized:{ detected: authorizedResult.detected, similarity: authorizedResult.similarity, faceId: authorizedResult.faceId },
    faceConfidence,
    timestamp,
  }

  const record = { ...result, tenant_id: 'default' }

  if (supabaseAvailable) {
    try {
      await supabase.from('siteguard_events').insert({
        scan_id:          scanId,
        worker_id:        result.workerId,
        site_id:          result.siteId,
        verdict,
        blacklist_sim:    blacklistResult.similarity ?? null,
        authorized_sim:   authorizedResult.similarity ?? null,
        face_confidence:  faceConfidence,
        scanned_at:       timestamp,
        tenant_id:        'default',
      })
    } catch (e) {
      fastify.log.warn('[SUPABASE] Insert failed, queuing:', e.message)
      enqueue(record)
    }
  } else {
    enqueue(record)
  }

  return reply.send({ success: true, result })
})

// ── POST /siteguard/enroll ─────────────────────────────────────────────────────

fastify.post('/siteguard/enroll', { preHandler: authHook }, async (request, reply) => {
  const { image, externalId, name = '', role = '', siteId = '', certifications = [] } = request.body ?? {}
  if (!image || !externalId) return reply.code(400).send({ error: 'Missing image or externalId' })

  const imageBytes = Buffer.from(cleanBase64(image), 'base64')
  const enrolledAt = new Date().toISOString()

  const res = await rekognition.send(new IndexFacesCommand({
    CollectionId:        COLLECTION_AUTHORIZED,
    Image:               { Bytes: imageBytes },
    ExternalImageId:     externalId,
    DetectionAttributes: ['DEFAULT'],
    MaxFaces:            1,
  }))

  const faceRecord = res.FaceRecords?.[0]
  if (!faceRecord) return reply.code(422).send({ error: 'No face detected for indexing' })

  const faceId = faceRecord.Face?.FaceId

  if (supabaseAvailable) {
    try {
      await supabase.from('siteguard_workers').insert({
        face_id:          faceId,
        external_id:      externalId,
        name,
        role,
        site_id:          siteId,
        certifications:   certifications,
        enrolled_at:      enrolledAt,
        tenant_id:        'default',
      })
    } catch (e) {
      fastify.log.warn('[SUPABASE] Worker insert failed:', e.message)
    }
  }

  return reply.send({ success: true, faceId, externalId, name, role, siteId, enrolledAt })
})

// ── POST /siteguard/blacklist ──────────────────────────────────────────────────

fastify.post('/siteguard/blacklist', { preHandler: authHook }, async (request, reply) => {
  const { image, externalId, reason = '', operator = '' } = request.body ?? {}
  if (!image || !externalId) return reply.code(400).send({ error: 'Missing image or externalId' })

  const imageBytes = Buffer.from(cleanBase64(image), 'base64')
  const bannedAt   = new Date().toISOString()

  const res = await rekognition.send(new IndexFacesCommand({
    CollectionId:        COLLECTION_BLACKLISTED,
    Image:               { Bytes: imageBytes },
    ExternalImageId:     externalId,
    DetectionAttributes: ['DEFAULT'],
    MaxFaces:            1,
  }))

  const faceRecord = res.FaceRecords?.[0]
  if (!faceRecord) return reply.code(422).send({ error: 'No face detected for indexing' })

  const faceId = faceRecord.Face?.FaceId

  if (supabaseAvailable) {
    try {
      await supabase.from('siteguard_blacklist').insert({
        face_id:    faceId,
        external_id: externalId,
        reason,
        operator,
        banned_at:  bannedAt,
        tenant_id:  'default',
      })
    } catch (e) {
      fastify.log.warn('[SUPABASE] Blacklist insert failed:', e.message)
    }
  }

  return reply.send({ success: true, faceId, externalId, reason, bannedAt })
})

// ── DELETE /siteguard/enroll/:faceId ──────────────────────────────────────────

fastify.delete('/siteguard/enroll/:faceId', { preHandler: authHook }, async (request, reply) => {
  const { faceId } = request.params

  await rekognition.send(new DeleteFacesCommand({
    CollectionId: COLLECTION_AUTHORIZED,
    FaceIds:      [faceId],
  }))

  if (supabaseAvailable) {
    try {
      await supabase.from('siteguard_workers').delete().eq('face_id', faceId)
    } catch (e) {
      fastify.log.warn('[SUPABASE] Worker delete failed:', e.message)
    }
  }

  return reply.send({ success: true, faceId })
})

// ── DELETE /siteguard/blacklist/:faceId ───────────────────────────────────────

fastify.delete('/siteguard/blacklist/:faceId', { preHandler: authHook }, async (request, reply) => {
  const { faceId } = request.params

  await rekognition.send(new DeleteFacesCommand({
    CollectionId: COLLECTION_BLACKLISTED,
    FaceIds:      [faceId],
  }))

  if (supabaseAvailable) {
    try {
      await supabase.from('siteguard_blacklist').delete().eq('face_id', faceId)
    } catch (e) {
      fastify.log.warn('[SUPABASE] Blacklist delete failed:', e.message)
    }
  }

  return reply.send({ success: true, faceId })
})

// ── GET /siteguard/status ─────────────────────────────────────────────────────

fastify.get('/siteguard/status', { preHandler: authHook }, async (_request, reply) => {
  const queue = loadQueue()

  const [authorizedCount, blacklistedCount] = await Promise.allSettled([
    collectionSize(COLLECTION_AUTHORIZED),
    collectionSize(COLLECTION_BLACKLISTED),
  ]).then(r => r.map(v => v.status === 'fulfilled' ? v.value : 0))

  return reply.send({
    success:          true,
    collectionAuthorized:  COLLECTION_AUTHORIZED,
    collectionBlacklisted: COLLECTION_BLACKLISTED,
    authorizedCount,
    blacklistedCount,
    queueSize:        queue.length,
    awsRegion:        AWS_REGION,
    mode:             supabaseAvailable ? 'UPLOAD' : 'COLLECT',
    authorizedThreshold:  AUTHORIZED_THRESHOLD,
    blacklistThreshold:   BLACKLIST_THRESHOLD,
  })
})

// ── GET /siteguard/events ─────────────────────────────────────────────────────

fastify.get('/siteguard/events', { preHandler: authHook }, async (request, reply) => {
  const verdict = request.query.verdict
  const siteId  = request.query.siteId
  const limit   = Math.min(parseInt(request.query.limit ?? '50', 10), 200)

  if (!supabaseAvailable) {
    let q = loadQueue()
    if (verdict) q = q.filter(i => i.verdict === verdict)
    if (siteId)  q = q.filter(i => i.siteId  === siteId)
    return reply.send({ success: true, events: q.slice(-limit).reverse(), source: 'queue' })
  }

  let query = supabase
    .from('siteguard_events')
    .select('*')
    .order('scanned_at', { ascending: false })
    .limit(limit)

  if (verdict) query = query.eq('verdict', verdict)
  if (siteId)  query = query.eq('site_id', siteId)

  const { data, error } = await query
  if (error) return reply.code(500).send({ error: error.message })

  return reply.send({ success: true, events: data ?? [], source: 'supabase' })
})

// ── GET /siteguard/workers ────────────────────────────────────────────────────

fastify.get('/siteguard/workers', { preHandler: authHook }, async (request, reply) => {
  const siteId = request.query.siteId
  const limit  = Math.min(parseInt(request.query.limit ?? '100', 10), 500)

  if (!supabaseAvailable) {
    return reply.send({ success: true, workers: [], source: 'queue', note: 'COLLECT mode — workers not persisted locally' })
  }

  let query = supabase
    .from('siteguard_workers')
    .select('*')
    .order('enrolled_at', { ascending: false })
    .limit(limit)

  if (siteId) query = query.eq('site_id', siteId)

  const { data, error } = await query
  if (error) return reply.code(500).send({ error: error.message })

  return reply.send({ success: true, workers: data ?? [], source: 'supabase' })
})

// ── POST /siteguard/sync ──────────────────────────────────────────────────────

fastify.post('/siteguard/sync', { preHandler: authHook }, async (_request, reply) => {
  if (!supabaseAvailable) {
    try {
      await initSupabase()
    } catch (e) {
      return reply.code(503).send({ error: 'Supabase still unreachable', message: e.message })
    }
    if (!supabaseAvailable) {
      return reply.code(503).send({ error: 'Supabase still unreachable' })
    }
  }

  const queue = loadQueue()
  if (!queue.length) return reply.send({ success: true, flushed: 0 })

  let flushed = 0
  const failed = []

  for (const item of queue) {
    try {
      await supabase.from('siteguard_events').insert({
        scan_id:         item.scanId,
        worker_id:       item.workerId,
        site_id:         item.siteId,
        verdict:         item.verdict,
        face_confidence: item.faceConfidence,
        scanned_at:      item.timestamp,
        tenant_id:       item.tenant_id ?? 'default',
      })
      flushed++
    } catch (e) {
      failed.push({ item, error: e.message })
    }
  }

  saveQueue(failed.map(f => f.item))
  return reply.send({ success: true, flushed, failed: failed.length })
})

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function bootstrap () {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  fastify.log.info(`🏗️  SiteGuard backend running on port ${PORT}`)
  fastify.log.info(`   Region: ${AWS_REGION}`)
  fastify.log.info(`   Authorized: ${COLLECTION_AUTHORIZED} (≥${AUTHORIZED_THRESHOLD}%)`)
  fastify.log.info(`   Blacklisted: ${COLLECTION_BLACKLISTED} (≥${BLACKLIST_THRESHOLD}%)`)

  try {
    await Promise.all([
      ensureCollection(COLLECTION_AUTHORIZED),
      ensureCollection(COLLECTION_BLACKLISTED),
    ])
  } catch (e) {
    fastify.log.warn('[REKOGNITION] Collection init failed:', e.message)
  }

  await initSupabase()
}

bootstrap().catch(e => {
  console.error('[BOOTSTRAP] Fatal:', e)
  process.exit(1)
})
