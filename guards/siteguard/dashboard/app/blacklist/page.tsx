'use client'

import { useRef, useEffect, useState } from 'react'
import { getBlacklist, addBlacklist, removeBlacklist } from '@/lib/api'

export default function BlacklistPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [entries,  setEntries]  = useState<any[]>([])
  const [preview,  setPreview]  = useState('')
  const [form,     setForm]     = useState({ externalId: '', reason: '', operator: '' })
  const [loading,  setLoading]  = useState(true)
  const [adding,   setAdding]   = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const data = await getBlacklist()
      setEntries(data.blacklist)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target?.result as string)
    reader.readAsDataURL(file)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!preview) { setError('Please select a photo'); return }
    if (!form.externalId || !form.reason || !form.operator) { setError('All fields are required'); return }
    setAdding(true)
    setError('')
    setSuccess('')
    try {
      await addBlacklist(preview, form.externalId, form.reason, form.operator)
      setSuccess('Person added to blacklist')
      setPreview('')
      setForm({ externalId: '', reason: '', operator: '' })
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (faceId: string) => {
    if (!confirm('Remove this person from the blacklist?')) return
    setRemoving(faceId)
    try {
      await removeBlacklist(faceId)
      setEntries(e => e.filter(x => x.face_id !== faceId))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="container">
      <h1 className="page-title">Blacklist</h1>
      <p className="page-subtitle">Individuals banned from all sites</p>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24, alignItems: 'start' }}>
        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 16 }}>Add to Blacklist</h2>
          <form onSubmit={handleAdd}>
            <div className="form-group">
              <label>Photo</label>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} />
            </div>
            {preview && <img src={preview} alt="preview" style={{ width: '100%', borderRadius: 8, marginBottom: 12, border: '1px solid var(--border)' }} />}
            <div className="form-group">
              <label>Worker / Person ID *</label>
              <input value={form.externalId} onChange={e => setForm(f => ({ ...f, externalId: e.target.value }))} placeholder="EMP-001" />
            </div>
            <div className="form-group">
              <label>Reason *</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Safety violation" />
            </div>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>Operator *</label>
              <input value={form.operator} onChange={e => setForm(f => ({ ...f, operator: e.target.value }))} placeholder="security@mine.co.za" />
            </div>
            {error   && <p style={{ color: 'var(--danger)',  marginBottom: 12, fontSize: 14 }}>{error}</p>}
            {success && <p style={{ color: 'var(--success)', marginBottom: 12, fontSize: 14 }}>{success}</p>}
            <button type="submit" disabled={adding} className="danger" style={{ width: '100%' }}>
              {adding ? 'Adding…' : 'Add to Blacklist'}
            </button>
          </form>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <p style={{ padding: 24, color: 'var(--text-dim)' }}>Loading…</p>
          ) : entries.length === 0 ? (
            <p style={{ padding: 24, color: 'var(--text-dim)' }}>Blacklist is empty.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Person ID</th>
                  <th>Reason</th>
                  <th>Operator</th>
                  <th>Banned At</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.face_id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.external_id}</td>
                    <td>{e.reason}</td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{e.operator}</td>
                    <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{new Date(e.banned_at).toLocaleDateString()}</td>
                    <td>
                      <button className="danger" disabled={removing === e.face_id} onClick={() => handleRemove(e.face_id)}>
                        {removing === e.face_id ? '…' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
