import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="container">
      <h1 className="page-title">SiteGuard Dashboard</h1>
      <p className="page-subtitle">Biometric access control for mines, construction and industrial sites</p>

      <div className="status-bar">
        <div className="status-item">
          <span className="label">Status</span>
          <span className="value success">Ready</span>
        </div>
        <div className="status-item">
          <span className="label">Authorized Collection</span>
          <span className="value">hv-siteguard-authorized</span>
        </div>
        <div className="status-item">
          <span className="label">Blacklist Collection</span>
          <span className="value">hv-siteguard-blacklisted</span>
        </div>
        <div className="status-item">
          <span className="label">Region</span>
          <span className="value">af-south-1</span>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 24 }}>
        <Link href="/scan" className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Live Scan</h2>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Capture a worker image and get instant access verdict — AUTHORIZED / UNAUTHORIZED / BLACKLISTED.
          </p>
          <button style={{ marginTop: 20, width: 'auto' }}>Start Scan</button>
        </Link>

        <Link href="/workers" className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Worker Registry</h2>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            View enrolled workers with their ID, role, site assignment and certifications.
          </p>
          <button style={{ marginTop: 20, width: 'auto' }}>View Registry</button>
        </Link>

        <Link href="/enroll" className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Enroll Worker</h2>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Register a new worker with face biometrics, worker ID, role and certifications.
          </p>
          <button style={{ marginTop: 20, width: 'auto' }}>Enroll</button>
        </Link>

        <Link href="/blacklist" className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Blacklist</h2>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Manage blacklisted individuals — add or remove with reason and operator.
          </p>
          <button style={{ marginTop: 20, width: 'auto' }}>View Blacklist</button>
        </Link>

        <Link href="/events" className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <h2 style={{ fontSize: 18, marginBottom: 6 }}>Event Log</h2>
          <p style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Browse scan history filtered by verdict and site. Export for compliance.
          </p>
          <button style={{ marginTop: 20, width: 'auto' }}>View Events</button>
        </Link>
      </div>
    </div>
  )
}
