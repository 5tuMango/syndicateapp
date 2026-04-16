import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

export default function ClaimPersona() {
  const { user, persona, setPersona } = useAuth()
  const navigate = useNavigate()
  const [personas, setPersonas] = useState([])
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(null)
  const [error, setError] = useState(null)

  // Already claimed — go home
  useEffect(() => {
    if (persona) navigate('/', { replace: true })
  }, [persona])

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const { data } = await supabase
      .from('personas')
      .select('*')
      .order('created_at')
    setPersonas(data || [])
    setLoading(false)
  }

  async function claim(p) {
    if (p.claimed_by) return
    setClaiming(p.id)
    setError(null)
    const { data, error } = await supabase
      .from('personas')
      .update({ claimed_by: user.id })
      .eq('id', p.id)
      .select()
      .single()

    if (error) {
      setError('This persona was just claimed by someone else. Please pick another.')
      setClaiming(null)
      load()
      return
    }

    setPersona(data)
    navigate('/', { replace: true })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-white tracking-tight">The Syndicate</h1>
          <p className="text-slate-400">Choose your persona</p>
          <p className="text-slate-500 text-sm">You'll keep this one for the season. Choose wisely.</p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm text-center">
            {error}
          </div>
        )}

        {/* Persona grid */}
        <div className="grid grid-cols-2 gap-3">
          {personas.map((p) => {
            const taken = !!p.claimed_by
            const isLoading = claiming === p.id

            return (
              <button
                key={p.id}
                onClick={() => claim(p)}
                disabled={taken || !!claiming}
                className={`relative flex flex-col items-center gap-3 rounded-2xl border p-5 transition-all ${
                  taken
                    ? 'border-slate-800 bg-slate-900/30 opacity-40 cursor-not-allowed'
                    : 'border-slate-700 bg-slate-800 hover:border-purple-500 hover:bg-slate-700 active:scale-95 cursor-pointer'
                }`}
              >
                {taken && (
                  <span className="absolute top-2 right-2 text-[10px] text-slate-500 font-medium uppercase tracking-wide">
                    Taken
                  </span>
                )}
                <span className="text-5xl">{p.emoji}</span>
                <span className={`font-semibold text-sm ${taken ? 'text-slate-500' : 'text-white'}`}>
                  {p.nickname}
                </span>
                {isLoading && (
                  <span className="text-xs text-purple-400">Claiming…</span>
                )}
              </button>
            )
          })}
        </div>

        <p className="text-center text-xs text-slate-600">
          Can't see yours? Ask the admin to reset it.
        </p>
      </div>
    </div>
  )
}
