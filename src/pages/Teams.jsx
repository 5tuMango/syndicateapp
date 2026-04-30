import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { calcProfitLoss, calcWinnings, formatCurrency, profitLossColor } from '../lib/utils'

const TEAM_COLORS = {
  blue: {
    border: 'border-blue-500/30',
    text: 'text-blue-400',
    bg: 'bg-blue-500/10',
    avatar: 'bg-blue-500/20',
  },
  purple: {
    border: 'border-purple-500/30',
    text: 'text-purple-400',
    bg: 'bg-purple-500/10',
    avatar: 'bg-purple-500/20',
  },
  green: {
    border: 'border-green-500/30',
    text: 'text-green-400',
    bg: 'bg-green-500/10',
    avatar: 'bg-green-500/20',
  },
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(' ')
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

export default function Teams() {
  const { profile } = useAuth()
  const isAdmin = profile?.is_admin

  const [teams, setTeams] = useState([])
  const [profiles, setProfiles] = useState([])
  const [personas, setPersonas] = useState([])
  const [bets, setBets] = useState([])
  const [loading, setLoading] = useState(true)

  // Team name editing
  const [editingTeamId, setEditingTeamId] = useState(null)
  const [editingTeamName, setEditingTeamName] = useState('')
  const [savingTeamName, setSavingTeamName] = useState(false)

  // Modal state
  const [movingMember, setMovingMember] = useState(null) // profile object
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: teamsData }, { data: profilesData }, { data: personasData }, { data: betsData }] = await Promise.all([
      supabase.from('teams').select('*').order('created_at'),
      supabase.from('profiles').select('id, full_name, username, team_id, is_admin'),
      // select('*') so we get team_id if the column exists, without error if not
      supabase.from('personas').select('*').order('nickname'),
      supabase
        .from('bets')
        .select('id, user_id, persona_id, stake, odds, outcome, is_bonus_bet, is_rollover, intend_to_rollover, cashed_out, cash_out_value')
        .neq('outcome', 'pending'),
    ])

    // Build profile→team fallback for claimed personas pre-migration
    const profileTeamMap = {}
    for (const p of (profilesData || [])) {
      if (p.team_id) profileTeamMap[p.id] = p.team_id
    }

    // Augment personas with team_id from profile if not yet on persona row
    const augmentedPersonas = (personasData || []).map((p) => ({
      ...p,
      team_id: p.team_id || (p.claimed_by ? (profileTeamMap[p.claimed_by] ?? null) : null),
    }))

    setTeams(teamsData || [])
    setProfiles(profilesData || [])
    setPersonas(augmentedPersonas)
    setBets(betsData || [])
    setLoading(false)
  }

  // A bet belongs to a persona if persona_id matches, or user_id matches claimed_by
  function betBelongsToPersona(bet, personaId) {
    if (bet.persona_id) return bet.persona_id === personaId
    const p = personas.find((p) => p.id === personaId)
    return !!(p?.claimed_by && bet.user_id === p.claimed_by)
  }

  // Per-persona winnings — used to order members within a team card.
  function personaWinnings(personaId) {
    return bets
      .filter((b) => betBelongsToPersona(b, personaId) && b.outcome === 'won')
      .reduce((sum, b) => sum + calcWinnings(b), 0)
  }

  // Build stats per team using persona-based membership
  function teamStats(teamId) {
    const teamPersonas = personas
      .filter((p) => p.team_id === teamId)
      .map((p) => ({ ...p, winnings: personaWinnings(p.id) }))
      .sort((a, b) => b.winnings - a.winnings)
    const teamBets = bets.filter((b) => teamPersonas.some((p) => betBelongsToPersona(b, p.id)))
    // Exclude rollover bets from win/loss counts (same logic as Leaderboard)
    const countable = teamBets.filter((b) => !b.intend_to_rollover && !b.is_rollover)
    const resulted = countable.filter((b) => b.outcome === 'won' || b.outcome === 'lost')
    const won = resulted.filter((b) => b.outcome === 'won').length
    const totalPL = teamBets.reduce((sum, b) => sum + calcProfitLoss(b), 0)
    const winnings = teamBets
      .filter((b) => b.outcome === 'won')
      .reduce((sum, b) => sum + calcWinnings(b), 0)
    return { members: teamPersonas, betCount: countable.length, won, totalPL, winnings }
  }

  const teamsWithStats = teams.map((t) => ({ ...t, stats: teamStats(t.id) }))
  const leadingTeam =
    teamsWithStats.length > 1
      ? teamsWithStats.reduce((a, b) => (a.stats.winnings >= b.stats.winnings ? a : b))
      : null

  const unassigned = personas.filter((p) => !p.team_id)

  async function saveTeamName(teamId) {
    if (!editingTeamName.trim()) return
    setSavingTeamName(true)
    await supabase.from('teams').update({ name: editingTeamName.trim() }).eq('id', teamId)
    setSavingTeamName(false)
    setEditingTeamId(null)
    load()
  }

  async function assignPersonaToTeam(personaId, teamId) {
    setSaving(true)
    // Write to personas.team_id (requires DB migration to have run)
    const { error } = await supabase.from('personas').update({ team_id: teamId }).eq('id', personaId)
    if (error) {
      alert('Could not save team: ' + error.message + '\n\nRun the SQL migration in Supabase Studio first:\nALTER TABLE personas ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);')
      setSaving(false)
      return
    }
    // Also sync to profiles.team_id for claimed personas (backward compat)
    const persona = personas.find((p) => p.id === personaId)
    if (persona?.claimed_by) {
      await supabase.from('profiles').update({ team_id: teamId }).eq('id', persona.claimed_by)
    }
    setSaving(false)
    setMovingMember(null)
    load()
  }

  // Bar chart max value (driven by winnings — the primary team measure)
  const maxWinnings = Math.max(
    1,
    ...teamsWithStats.map((t) => t.stats.winnings)
  )

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center text-slate-400 text-sm">
        Loading teams...
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Teams</h1>
        <p className="text-slate-400 text-sm mt-1">Team standings and members</p>
      </div>

      {/* Bar chart comparison */}
      {teamsWithStats.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-5">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-4">
            Winnings Comparison
          </h2>
          <div className="space-y-3">
            {teamsWithStats.map((team) => {
              const colors = TEAM_COLORS[team.color] || TEAM_COLORS.blue
              const winnings = team.stats.winnings
              const barPct = maxWinnings > 0 ? (winnings / maxWinnings) * 100 : 0
              return (
                <div key={team.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-sm font-medium ${colors.text}`}>{team.name}</span>
                    <span className="text-sm font-semibold text-green-400">
                      ${winnings.toFixed(2)}
                    </span>
                  </div>
                  <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all bg-green-500"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Team cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {teamsWithStats.map((team) => {
          const colors = TEAM_COLORS[team.color] || TEAM_COLORS.blue
          const isLeading = leadingTeam?.id === team.id && teamsWithStats.length > 1
          const { members, betCount, totalPL, winnings } = team.stats

          const canEditName = isAdmin || profile?.team_id === team.id
          const isEditingThis = editingTeamId === team.id

          return (
            <div
              key={team.id}
              className={`bg-slate-800 rounded-xl border p-5 space-y-4 ${colors.border}`}
            >
              {/* Team header */}
              <div className="flex items-center justify-between gap-2">
                {isEditingThis ? (
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      autoFocus
                      value={editingTeamName}
                      onChange={(e) => setEditingTeamName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveTeamName(team.id)
                        if (e.key === 'Escape') setEditingTeamId(null)
                      }}
                      className="flex-1 bg-slate-700 border border-slate-500 rounded-lg px-2 py-1 text-white text-sm font-bold focus:outline-none focus:border-green-500"
                    />
                    <button
                      onClick={() => saveTeamName(team.id)}
                      disabled={savingTeamName}
                      className="text-xs text-green-400 hover:text-green-300 disabled:opacity-50"
                    >
                      {savingTeamName ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingTeamId(null)}
                      className="text-xs text-slate-500 hover:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className={`text-lg font-bold ${colors.text}`}>{team.name}</h2>
                    {isLeading && <span className="text-lg">🏆</span>}
                    {canEditName && (
                      <button
                        onClick={() => { setEditingTeamId(team.id); setEditingTeamName(team.name) }}
                        className="text-slate-600 hover:text-slate-400 transition-colors"
                        title="Rename team"
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )}
                {!isEditingThis && (
                  <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${colors.border} ${colors.text} ${colors.bg}`}>
                    {members.length} members
                  </span>
                )}
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-base font-bold text-green-400">
                    ${winnings.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">Winnings</div>
                </div>
                <div>
                  <div className={`text-base font-bold ${profitLossColor(totalPL)}`}>
                    {formatCurrency(totalPL)}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">P&amp;L</div>
                </div>
                <div>
                  <div className="text-base font-bold text-white">{betCount}</div>
                  <div className="text-xs text-slate-500 mt-0.5">Bets</div>
                </div>
              </div>

              {/* Members */}
              <div className="space-y-2">
                {members.length === 0 ? (
                  <p className="text-slate-500 text-sm italic">No members yet</p>
                ) : (
                  members.map((persona) => {
                    const otherTeam = teams.find((t) => t.id !== team.id)
                    return (
                      <div
                        key={persona.id}
                        className="flex items-center justify-between gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{persona.emoji}</span>
                          <span className="text-sm text-slate-200">{persona.nickname}</span>
                          {persona.winnings > 0 && (
                            <span className="text-xs text-green-400 font-medium">
                              ${persona.winnings.toFixed(0)}
                            </span>
                          )}
                          {!persona.claimed_by && (
                            <span className="text-xs text-slate-500">(unclaimed)</span>
                          )}
                        </div>
                        {isAdmin && otherTeam && (
                          <button
                            onClick={() => setMovingMember({ ...persona, currentTeamId: team.id })}
                            className="text-xs text-slate-500 hover:text-white transition-colors"
                          >
                            Move
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Unassigned members (admin only) */}
      {isAdmin && unassigned.length > 0 && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
            Unassigned Personas
          </h2>
          <div className="space-y-2">
            {unassigned.map((persona) => (
              <div key={persona.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{persona.emoji}</span>
                  <span className="text-sm text-slate-200">{persona.nickname}</span>
                  {!persona.claimed_by && (
                    <span className="text-xs text-slate-500">(unclaimed)</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {teams.map((t) => {
                    const tc = TEAM_COLORS[t.color] || TEAM_COLORS.blue
                    return (
                      <button
                        key={t.id}
                        onClick={() => assignPersonaToTeam(persona.id, t.id)}
                        disabled={saving}
                        className={`text-xs px-2 py-1 rounded border ${tc.border} ${tc.text} ${tc.bg} hover:opacity-80 transition-opacity disabled:opacity-50`}
                      >
                        {t.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Move member modal */}
      {movingMember && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-6 w-full max-w-sm space-y-4">
            <h3 className="text-white font-semibold">Move Member</h3>
            <p className="text-slate-400 text-sm">
              Move{' '}
              <span className="text-white font-medium">
                {movingMember.emoji} {movingMember.nickname}
              </span>{' '}
              to:
            </p>
            <div className="space-y-2">
              {teams
                .filter((t) => t.id !== movingMember.currentTeamId)
                .map((t) => {
                  const tc = TEAM_COLORS[t.color] || TEAM_COLORS.blue
                  return (
                    <button
                      key={t.id}
                      onClick={() => assignPersonaToTeam(movingMember.id, t.id)}
                      disabled={saving}
                      className={`w-full py-2.5 rounded-lg border ${tc.border} ${tc.text} ${tc.bg} hover:opacity-80 transition-opacity disabled:opacity-50 font-medium`}
                    >
                      {saving ? 'Moving...' : t.name}
                    </button>
                  )
                })}
            </div>
            <button
              onClick={() => setMovingMember(null)}
              disabled={saving}
              className="w-full py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
