'use client'

import { useEffect, useState } from 'react'
import { getWorkers, unenrollWorker } from '@/lib/api'

export default function WorkersPage() {
  const [workers,  setWorkers]  = useState<any[]>([])
  const [siteId,   setSiteId]   = useState('')
  const [loading,  setLoading]  = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error,    setError]    = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await getWorkers(siteId || undefined)
      setWorkers(data.workers)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleUnenroll = async (faceId: string, name: string) => {
    if (!confirm(`Unenroll ${name}? This removes them from the authorized collection.`)) return
    setRemoving(faceId)
    try {
      await unenrollWorker(faceId)
      setWorkers(w => w.filter(x => x.face_id !== faceId))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="container">
      <h1 className="page-title">Worker Registry</h1>
      <p className="page-subtitle">Enrolled workers authorized to enter sites</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'flex-end' }}>
        <div style={{ flex: 1, maxWidth: 280 }}>
          <label>Filter by Site ID</label>
          <input value={siteId} onChange={e => setSiteId(e.target.value)} placeholder="All sites" />
        </div>
        <button onClick={load} className="secondary" style={{ height: 44 }}>Refresh</button>
      </div>

      {error && <p style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 24, color: 'var(--text-dim)' }}>Loading…</p>
        ) : workers.length === 0 ? (
          <p style={{ padding: 24, color: 'var(--text-dim)' }}>No enrolled workers found.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Worker ID</th>
                <th>Role</th>
                <th>Site</th>
                <th>Certifications</th>
                <th>Enrolled At</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workers.map(w => (
                <tr key={w.face_id}>
                  <td style={{ fontWeight: 600 }}>{w.name}</td>
                  <td style={{ color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 12 }}>{w.external_id}</td>
                  <td>{w.role || '—'}</td>
                  <td>{w.site_id || '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {Array.isArray(w.certifications) && w.certifications.length > 0
                      ? w.certifications.join(', ')
                      : '—'}
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                    {new Date(w.enrolled_at).toLocaleDateString()}
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        className="danger"
                        disabled={removing === w.face_id}
                        onClick={() => handleUnenroll(w.face_id, w.name)}
                      >
                        {removing === w.face_id ? '…' : 'Unenroll'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
