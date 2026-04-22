'use client'

import { useEffect, useState } from 'react'
import { getEvents } from '@/lib/api'

const VERDICTS = ['', 'AUTHORIZED', 'UNAUTHORIZED', 'BLACKLISTED']

export default function EventsPage() {
  const [events,   setEvents]   = useState<any[]>([])
  const [verdict,  setVerdict]  = useState('')
  const [siteId,   setSiteId]   = useState('')
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await getEvents(verdict || undefined, siteId || undefined, 100)
      setEvents(data.events)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const verdictClass = (v: string) =>
    v === 'AUTHORIZED' ? 'authorized' : v === 'BLACKLISTED' ? 'blacklisted' : 'unauthorized'

  return (
    <div className="container">
      <h1 className="page-title">Event Log</h1>
      <p className="page-subtitle">Scan history with verdict and site filters</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 180 }}>
          <label>Verdict</label>
          <select value={verdict} onChange={e => setVerdict(e.target.value)}>
            {VERDICTS.map(v => <option key={v} value={v}>{v || 'All verdicts'}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 180 }}>
          <label>Site ID</label>
          <input value={siteId} onChange={e => setSiteId(e.target.value)} placeholder="All sites" />
        </div>
        <button onClick={load} className="secondary" style={{ height: 44 }}>Apply</button>
      </div>

      {error && <p style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: 24, color: 'var(--text-dim)' }}>Loading…</p>
        ) : events.length === 0 ? (
          <p style={{ padding: 24, color: 'var(--text-dim)' }}>No events found.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>Worker ID</th>
                  <th>Site</th>
                  <th>Auth Sim</th>
                  <th>Blacklist Sim</th>
                  <th>Confidence</th>
                  <th>Scanned At</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.id ?? i}>
                    <td><span className={`badge ${verdictClass(e.verdict)}`}>{e.verdict}</span></td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.worker_id || '—'}</td>
                    <td>{e.site_id || '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.authorized_sim != null ? `${e.authorized_sim.toFixed(1)}%` : '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.blacklist_sim  != null ? `${e.blacklist_sim.toFixed(1)}%`  : '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.face_confidence != null ? `${e.face_confidence.toFixed(1)}%` : '—'}</td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {new Date(e.scanned_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
