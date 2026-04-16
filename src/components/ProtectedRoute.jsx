import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { user, persona, loading } = useAuth()
  const location = useLocation()

  if (loading) return null
  if (!user) return <Navigate to="/login" replace />

  // Redirect to claim screen if persona not yet chosen
  // (skip if already on /claim to avoid redirect loop)
  if (!persona && location.pathname !== '/claim') {
    return <Navigate to="/claim" replace />
  }

  return children
}
