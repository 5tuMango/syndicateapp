import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AddBet from './pages/AddBet'
import EditBet from './pages/EditBet'
import Profile from './pages/Profile'
import Leaderboard from './pages/Leaderboard'
import Insights from './pages/Insights'
import Teams from './pages/Teams'
import WeeklyMulti from './pages/WeeklyMulti'
import AdminPersonas from './pages/AdminPersonas'
import ClaimPersona from './pages/ClaimPersona'

export default function App() {
  const { loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-slate-400 text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/add-bet" element={<AddBet />} />
        <Route path="/edit-bet/:id" element={<EditBet />} />
        <Route path="/profile/:id" element={<Profile />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/weekly-multi" element={<WeeklyMulti />} />
        <Route path="/admin/personas" element={<AdminPersonas />} />
      </Route>
      {/* Claim screen: needs auth but not the main Layout */}
      <Route
        path="/claim"
        element={
          <ProtectedRoute>
            <ClaimPersona />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
