import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Returns { byUserId, byPersonaId }
// byUserId: claimed_by (auth user id) → persona  — for member lists, leaderboard
// byPersonaId: persona.id → persona              — for bets with persona_id set directly
export function usePersonas() {
  const [maps, setMaps] = useState({ byUserId: {}, byPersonaId: {}, list: [] })

  useEffect(() => {
    supabase.from('personas').select('*').then(({ data }) => {
      const byUserId = {}
      const byPersonaId = {}
      for (const p of (data || [])) {
        if (p.claimed_by) byUserId[p.claimed_by] = p
        byPersonaId[p.id] = p
      }
      setMaps({ byUserId, byPersonaId, list: data || [] })
    })
  }, [])

  return maps
}

// Helper: get display string for a user id from the persona map
export function personaDisplay(userId, byUserId, fallback = 'Unknown') {
  const p = byUserId[userId]
  if (p) return `${p.emoji} ${p.nickname}`
  return fallback
}
