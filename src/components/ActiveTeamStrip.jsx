// Top-of-dashboard strip showing the team that's punting this active week.
// Matches the Leaderboard "This Weekend" card style — tight pill chips per
// member, with a small "+$50" hint on anyone who has unused Go-Again credits.
// A second row lists punters from the OTHER team who still have outstanding
// (unused) Go-Again credits — they can't punt this week but the credits roll
// over until consumed.

export default function ActiveTeamStrip({ team, weekNum, members, outstandingOthers = [] }) {
  if (!team) return null

  return (
    <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
      <p className="text-green-400 text-xs uppercase tracking-wide font-semibold mb-1">
        🏉 Team betting this week — Week {weekNum}
      </p>
      <p className="text-white font-bold text-lg">
        {team.name}
        <span className="text-slate-400 text-sm font-normal ml-2">($50 each)</span>
      </p>
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {members.map(({ persona, unusedCredits }) => (
            <span
              key={persona.id}
              className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            >
              <span>{persona.emoji} {persona.nickname}</span>
              {unusedCredits > 0 && (
                <span
                  title={`Go-Again — extra $50 stake${unusedCredits > 1 ? ` × ${unusedCredits}` : ''}`}
                  className="text-[10px] font-semibold bg-amber-500/30 text-amber-200 px-1 py-px rounded-full"
                >
                  {unusedCredits > 1 ? `+$${unusedCredits * 50}` : '+$50'}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {outstandingOthers.length > 0 && (
        <div className="mt-2">
          <p className="text-amber-400/80 text-[10px] uppercase tracking-wide font-semibold mb-1">
            Outstanding allocations · off-team
          </p>
          <div className="flex flex-wrap gap-1.5">
            {outstandingOthers.map(({ persona, remaining }) => (
              <span
                key={persona.id}
                className="text-xs bg-amber-500/10 text-amber-300/90 px-2 py-0.5 rounded-full inline-flex items-center gap-1 border border-amber-500/20"
              >
                <span>{persona.emoji} {persona.nickname}</span>
                <span
                  title="Outstanding allocation (unused base + Go-Again, rolls over)"
                  className="text-[10px] font-semibold bg-amber-500/30 text-amber-200 px-1 py-px rounded-full"
                >
                  ${remaining}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
