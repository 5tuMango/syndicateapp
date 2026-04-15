import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Navbar() {
  const { profile, signOut } = useAuth()
  const location = useLocation()

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    { to: '/add-bet', label: '+ Add Bet' },
    { to: '/leaderboard', label: 'Leaderboard' },
    { to: '/insights', label: 'Insights' },
  ]

  const isActive = (path) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  return (
    <nav className="bg-slate-900 border-b border-slate-800 sticky top-0 z-10">
      <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-green-400 font-bold text-lg tracking-tight shrink-0">
            The Syndicate
          </Link>
          <div className="hidden sm:flex items-center gap-1">
            {navLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  isActive(to)
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {profile && (
            <Link
              to={`/profile/${profile.id}`}
              className="text-sm text-slate-300 hover:text-white transition-colors hidden sm:block"
            >
              {profile.full_name || profile.username}
            </Link>
          )}
          <button
            onClick={signOut}
            className="text-xs text-slate-400 hover:text-white px-2.5 py-1.5 rounded border border-slate-700 hover:border-slate-500 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="sm:hidden flex border-t border-slate-800">
        {navLinks.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className={`flex-1 text-center py-2 text-xs font-medium transition-colors ${
              isActive(to) ? 'text-green-400' : 'text-slate-400'
            }`}
          >
            {label}
          </Link>
        ))}
        {profile && (
          <Link
            to={`/profile/${profile.id}`}
            className={`flex-1 text-center py-2 text-xs font-medium transition-colors ${
              location.pathname.startsWith('/profile') ? 'text-green-400' : 'text-slate-400'
            }`}
          >
            Me
          </Link>
        )}
      </div>
    </nav>
  )
}
