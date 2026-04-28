import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Returns { byUserId, byPersonaId, list }
// Personas are augmented with team_id from profiles as a fallback for legacy
// claimed personas where the team_id was set on profiles but not yet copied
// down to personas.team_id. Without this fallback, downstream features that
// rely on persona.team_id (Dashboard active-team strip, Go-Again credits) miss.
export function usePersonas() {
  const [maps, setMaps] = useState({ byUserId: {}, byPersonaId: {}, list: [] })

  useEffect(() => {
    Promise.all([
      supabase.from('personas').select('*'),
      supabase.from('profiles').select('id, team_id'),
    ]).then(([personasRes, profilesRes]) => {
      const profileTeamMap = {}
      for (const p of (profilesRes.data || [])) {
        if (p.team_id) profileTeamMap[p.id] = p.team_id
      }
      const augmented = (personasRes.data || []).map((p) => ({
        ...p,
        team_id: p.team_id || (p.claimed_by ? (profileTeamMap[p.claimed_by] ?? null) : null),
      }))
      const byUserId = {}
      const byPersonaId = {}
      for (const p of augmented) {
        if (p.claimed_by) byUserId[p.claimed_by] = p
        byPersonaId[p.id] = p
      }
      setMaps({ byUserId, byPersonaId, list: augmented })
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
