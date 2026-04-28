// Top-of-dashboard strip showing the team that's punting this active week.
// Lists the 4 members across the row, with a "Go-Again $50" pill on any
// member who has earned (and not yet spent) bonus stake credits.

export default function ActiveTeamStrip({ team, weekNum, members }) {
  if (!team) return null

  return (
    <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-green-400 text-sm">🏉</span>
        <span className="text-slate-400 text-xs uppercase tracking-wide">Team betting this week</span>
        <span className="text-green-400 font-semibold text-sm">{team.name}</span>
        <span className="text-slate-600 text-xs ml-auto">Week {weekNum}</span>
      </div>

      {members.length === 0 ? (
        <p className="text-slate-500 text-xs italic">No members assigned to this team.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {members.map((m) => (
            <div
              key={m.persona.id}
              className="flex flex-col items-center text-center bg-slate-800/60 rounded-lg px-2 py-2 border border-slate-700/50"
            >
              <span className="text-2xl leading-none">{m.persona.emoji}</span>
              <span className="text-xs text-slate-200 mt-1 truncate max-w-full">
                {m.persona.nickname}
              </span>
              {m.unusedCredits > 0 && (
                <span
                  title={`Earned a Go-Again ($50 extra stake)${m.unusedCredits > 1 ? ` × ${m.unusedCredits}` : ''}`}
                  className="mt-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300"
                >
                  Go-Again {m.unusedCredits > 1 ? `×${m.unusedCredits}` : ''} +$50
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
