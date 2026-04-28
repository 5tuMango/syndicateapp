// Top-of-dashboard strip showing the team that's punting this active week.
// Matches the Leaderboard "This Weekend" card style — tight pill chips per
// member, with a small "+$50" hint on anyone who has unused Go-Again credits.

export default function ActiveTeamStrip({ team, weekNum, members }) {
  if (!team) return null

  return (
    <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
      <p className="text-green-400 text-xs uppercase tracking-wide font-semibold mb-1">
        🏉 Team betting this week — Week {weekNum}
      </p>
      <p className="text-white font-bold text-lg">{team.name}</p>
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
    </div>
  )
}
