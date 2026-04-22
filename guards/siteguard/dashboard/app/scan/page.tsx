'use client'

import { useRef, useState, useCallback } from 'react'
import { scanWorker } from '@/lib/api'

export default function ScanPage() {
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [streaming, setStreaming]   = useState(false)
  const [workerId,  setWorkerId]    = useState('')
  const [siteId,    setSiteId]      = useState('')
  const [loading,   setLoading]     = useState(false)
  const [result,    setResult]      = useState<any>(null)
  const [error,     setError]       = useState('')

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setStreaming(true)
      }
    } catch (e) {
      setError('Camera access denied')
    }
  }, [])

  const capture = useCallback(async () => {
    if (!canvasRef.current || !videoRef.current) return
    const ctx = canvasRef.current.getContext('2d')
    if (!ctx) return
    canvasRef.current.width  = videoRef.current.videoWidth
    canvasRef.current.height = videoRef.current.videoHeight
    ctx.drawImage(videoRef.current, 0, 0)
    const b64 = canvasRef.current.toDataURL('image/jpeg', 0.8)

    setLoading(true)
    setError('')
    setResult(null)
    try {
      const data = await scanWorker(b64, workerId || undefined, siteId || undefined)
      setResult(data.result)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [workerId, siteId])

  const verdictColor = (v: string) =>
    v === 'AUTHORIZED' ? 'var(--success)' : v === 'BLACKLISTED' ? 'var(--danger)' : 'var(--warning)'

  return (
    <div className="container">
      <h1 className="page-title">Live Scan</h1>
      <p className="page-subtitle">Capture worker image → instant access verdict</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 16 }}>Camera</h2>

          <div style={{ marginBottom: 16, display: 'grid', gap: 12 }}>
            <div>
              <label>Worker ID (optional)</label>
              <input value={workerId} onChange={e => setWorkerId(e.target.value)} placeholder="EMP-001" />
            </div>
            <div>
              <label>Site ID (optional)</label>
              <input value={siteId} onChange={e => setSiteId(e.target.value)} placeholder="SITE-A" />
            </div>
          </div>

          {!streaming ? (
            <button onClick={startCamera} style={{ width: '100%' }}>Start Camera</button>
          ) : (
            <>
              <video ref={videoRef} style={{ width: '100%', borderRadius: 8, background: '#000' }} autoPlay muted playsInline />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              <button onClick={capture} disabled={loading} style={{ width: '100%', marginTop: 12 }}>
                {loading ? 'Scanning…' : 'Capture & Scan'}
              </button>
            </>
          )}

          {error && <p style={{ color: 'var(--danger)', marginTop: 12, fontSize: 14 }}>{error}</p>}
        </div>

        <div>
          {result ? (
            <div className="verdict-card" style={{ borderColor: verdictColor(result.verdict) }}>
              <div className="header">
                <span className={`verdict ${result.verdict}`}>{result.verdict}</span>
                <span className="timestamp">{new Date(result.timestamp).toLocaleString()}</span>
              </div>
              <div className="details">
                <div className="detail"><span className="label">Access</span><span className="value">{result.access ? '✅ Granted' : '🚫 Denied'}</span></div>
                <div className="detail"><span className="label">Worker ID</span><span className="value">{result.workerId || '—'}</span></div>
                <div className="detail"><span className="label">Site</span><span className="value">{result.siteId || '—'}</span></div>
                <div className="detail"><span className="label">Face Confidence</span><span className="value">{result.faceConfidence?.toFixed(1)}%</span></div>
                {result.authorized?.detected && (
                  <>
                    <div className="detail"><span className="label">Match Similarity</span><span className="value">{result.authorized.similarity?.toFixed(1)}%</span></div>
                    {result.worker && (
                      <>
                        <div className="detail"><span className="label">Name</span><span className="value">{result.worker.name}</span></div>
                        <div className="detail"><span className="label">Role</span><span className="value">{result.worker.role}</span></div>
                      </>
                    )}
                  </>
                )}
                {result.blacklist?.detected && (
                  <div className="detail"><span className="label">Blacklist Similarity</span><span className="value">{result.blacklist.similarity?.toFixed(1)}%</span></div>
                )}
              </div>
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--text-dim)' }}>
              No scan yet — start the camera and capture a frame.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
