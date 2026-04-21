// Reusable editorial masthead — the navy-gradient hero strip with a gold
// grid background + up to three big stats. Same visual language as the
// Dashboard / Portfolio heroes, portable to any page.
//
// Usage:
//   <EditorialMasthead
//     stats={[
//       { kicker: 'Total', value: '30', sub: 'members' },
//       { kicker: 'Executives', value: '5', sub: 'Presidents + CIO' },
//       { kicker: 'Analysts', value: '12', sub: 'Senior + Junior' },
//     ]}
//   />

export default function EditorialMasthead({ stats = [] }) {
  if (!stats.length) return null;
  const cols = stats.length === 1 ? 'md:grid-cols-1' : stats.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3';
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy-700 to-navy-800 text-white shadow-xl">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #C9A84C 1px, transparent 1px), linear-gradient(to bottom, #C9A84C 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className={`relative grid gap-6 p-6 ${cols} md:gap-10 md:p-8`}>
        {stats.map((s, i) => (
          <div key={i}>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
              <span className="h-px w-5 bg-gold" />
              {s.kicker}
            </div>
            <div className={`mt-3 font-serif font-semibold leading-none tabular-nums ${
              s.big === false
                ? 'text-2xl md:text-3xl'
                : 'text-5xl md:text-6xl'
            }`}>
              {s.value}
            </div>
            {s.sub && (
              <div className="mt-3 text-xs text-navy-100">{s.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
