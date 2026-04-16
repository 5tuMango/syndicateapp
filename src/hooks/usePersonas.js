import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Returns a map of user_id (claimed_by) → persona
// Used across the app to display emoji + nickname instead of profile names
export function usePersonas() {
  const [personaMap, setPersonaMap] = useState({})

  useEffect(() => {
    supabase.from('personas').select('*').then(({ data }) => {
      const map = {}
      for (const p of (data || [])) {
        if (p.claimed_by) map[p.claimed_by] = p
      }
      setPersonaMap(map)
    })
  }, [])

  return personaMap
}

// Helper: get display string for a user id from the persona map
// Falls back to profile name if no persona claimed yet
export function personaDisplay(userId, personaMap, fallback = 'Unknown') {
  const p = personaMap[userId]
  if (p) return `${p.emoji} ${p.nickname}`
  return fallback
}
