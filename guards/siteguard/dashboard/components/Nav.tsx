'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Nav() {
  const pathname = usePathname()
  const isActive = (path: string) => pathname === path

  return (
    <nav className="nav">
      <div className="logo">🏗️ SiteGuard</div>
      <div className="links">
        <Link href="/"          className={isActive('/')          ? 'active' : ''}>Home</Link>
        <Link href="/scan"      className={isActive('/scan')      ? 'active' : ''}>Scan</Link>
        <Link href="/workers"   className={isActive('/workers')   ? 'active' : ''}>Workers</Link>
        <Link href="/enroll"    className={isActive('/enroll')    ? 'active' : ''}>Enroll</Link>
        <Link href="/blacklist" className={isActive('/blacklist') ? 'active' : ''}>Blacklist</Link>
        <Link href="/events"    className={isActive('/events')    ? 'active' : ''}>Events</Link>
      </div>
    </nav>
  )
}
