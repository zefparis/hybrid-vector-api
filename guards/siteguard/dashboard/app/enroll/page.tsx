'use client'

import { useRef, useState } from 'react'
import { enrollWorker } from '@/lib/api'

export default function EnrollPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview,  setPreview]  = useState<string>('')
  const [form,     setForm]     = useState({ externalId: '', name: '', role: '', siteId: '', certifications: '' })
  const [loading,  setLoading]  = useState(false)
  const [success,  setSuccess]  = useState<any>(null)
  const [error,    setError]    = useState('')

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
    setSuccess(null)
    setError('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!preview) { setError('Please select a photo'); return }
    if (!form.externalId || !form.name) { setError('Worker ID and Name are required'); return }

    const certs = form.certifications.split(',').map(s => s.trim()).filter(Boolean)

    setLoading(true)
    setError('')
    setSuccess(null)
    try {
      const data = await enrollWorker(preview, form.externalId, form.name, form.role, form.siteId, certs)
      setSuccess(data)
      setPreview('')
      setForm({ externalId: '', name: '', role: '', siteId: '', certifications: '' })
      if (fileRef.current) fileRef.current.value = ''
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container">
      <h1 className="page-title">Enroll Worker</h1>
      <p className="page-subtitle">Register a new worker into the authorized collection</p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24, alignItems: 'start' }}>
        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 16 }}>Photo</h2>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ marginBottom: 12 }} />
          {preview && (
            <img src={preview} alt="preview" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />
          )}
        </div>

        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="form-row" style={{ marginBottom: 16 }}>
              <div className="form-group">
                <label>Worker ID *</label>
                <input value={form.externalId} onChange={e => setForm(f => ({ ...f, externalId: e.target.value }))} placeholder="EMP-001" required />
              </div>
              <div className="form-group">
                <label>Full Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="John Smith" required />
              </div>
            </div>
            <div className="form-row" style={{ marginBottom: 16 }}>
              <div className="form-group">
                <label>Role</label>
                <input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="Blasting Technician" />
              </div>
              <div className="form-group">
                <label>Site ID</label>
                <input value={form.siteId} onChange={e => setForm(f => ({ ...f, siteId: e.target.value }))} placeholder="SITE-A" />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 24 }}>
              <label>Certifications (comma-separated)</label>
              <input value={form.certifications} onChange={e => setForm(f => ({ ...f, certifications: e.target.value }))} placeholder="First Aid, Blasting, Safety Officer" />
            </div>

            {error   && <p style={{ color: 'var(--danger)',  marginBottom: 16 }}>{error}</p>}
            {success && (
              <div className="card" style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.25)', marginBottom: 16 }}>
                <p style={{ color: 'var(--success)', fontWeight: 600 }}>✅ Worker enrolled</p>
                <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>Face ID: {success.faceId}</p>
                <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>Enrolled: {new Date(success.enrolledAt).toLocaleString()}</p>
              </div>
            )}

            <button type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Enrolling…' : 'Enroll Worker'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
