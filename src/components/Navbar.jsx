import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export default function Navbar() {
  const { user, profile, signOut } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [notifications, setNotifications] = useState([])
  const [showNotifs, setShowNotifs] = useState(false)
  const notifRef = useRef(null)

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    { to: '/add-bet', label: '+ Add Bet' },
    { to: '/teams', label: 'Teams' },
    { to: '/weekly-multi', label: 'Weekly Multi' },
    { to: '/leaderboard', label: 'Leaderboard' },
    { to: '/insights', label: 'Insights' },
  ]

  const isActive = (path) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  // Fetch notifications whenever location changes
  useEffect(() => {
    if (!user) return
    fetchNotifications()
  }, [user, location.pathname])

  async function fetchNotifications() {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10)
    setNotifications(data || [])
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setShowNotifs(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function markRead(notif) {
    if (!notif.read) {
      await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notif.id)
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, read: true } : n))
      )
    }
    setShowNotifs(false)
    if (notif.link) navigate(notif.link)
  }

  async function markAllRead() {
    const unread = notifications.filter((n) => !n.read)
    if (unread.length === 0) return
    await supabase
      .from('notifications')
      .update({ read: true })
      .in(
        'id',
        unread.map((n) => n.id)
      )
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }

  const unreadCount = notifications.filter((n) => !n.read).length

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
          {/* Notification bell */}
          {user && (
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifs((v) => !v)}
                className="relative p-1.5 text-slate-400 hover:text-white transition-colors rounded-md hover:bg-slate-800"
                aria-label="Notifications"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                  />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full text-white text-[10px] flex items-center justify-center font-bold">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {showNotifs && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-slate-800 border border-slate-700 rounded-xl shadow-xl overflow-hidden z-50">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                    <span className="text-sm font-semibold text-white">Notifications</span>
                    {unreadCount > 0 && (
                      <button
                        onClick={markAllRead}
                        className="text-xs text-slate-400 hover:text-white transition-colors"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <div className="px-4 py-6 text-center text-slate-500 text-sm">
                      No notifications
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-700/50 max-h-80 overflow-y-auto">
                      {notifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => markRead(n)}
                          className={`w-full text-left px-4 py-3 hover:bg-slate-700/50 transition-colors ${
                            !n.read ? 'bg-slate-700/20' : ''
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {!n.read && (
                              <span className="mt-1.5 w-2 h-2 rounded-full bg-green-500 shrink-0" />
                            )}
                            <div className={!n.read ? '' : 'pl-4'}>
                              <p className="text-sm text-white font-medium leading-snug">
                                {n.title}
                              </p>
                              {n.body && (
                                <p className="text-xs text-slate-400 mt-0.5">{n.body}</p>
                              )}
                              <p className="text-xs text-slate-600 mt-1">
                                {new Date(n.created_at).toLocaleDateString('en-AU', {
                                  day: 'numeric',
                                  month: 'short',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}
                              </p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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

      {/* Mobile bottom nav — horizontally scrollable */}
      <div className="sm:hidden flex overflow-x-auto border-t border-slate-800 scrollbar-hide">
        {navLinks.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className={`whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors shrink-0 ${
              isActive(to) ? 'text-green-400' : 'text-slate-400'
            }`}
          >
            {label}
          </Link>
        ))}
        {profile && (
          <Link
            to={`/profile/${profile.id}`}
            className={`whitespace-nowrap px-3 py-2 text-xs font-medium transition-colors shrink-0 ${
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
