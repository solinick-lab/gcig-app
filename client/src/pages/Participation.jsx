import { useEffect, useState } from 'react';
import { Trophy, Users, Info } from 'lucide-react';
import api from '../api/client.js';
import Card from '../components/Card.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

function Bar({ value, max, tone = 'navy' }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const colors = {
    navy: 'bg-navy',
    gold: 'bg-gold',
    emerald: 'bg-emerald-500',
  };
  return (
    <div className="h-1.5 w-full rounded-full bg-navy-50 overflow-hidden">
      <div
        className={`h-full ${colors[tone] || 'bg-navy'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function Participation({ embedded = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/users/participation')
      .then(({ data }) => setData(data))
      .catch((err) =>
        setError(err.response?.data?.error || 'Failed to load participation')
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-navy-400">Loading participation…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!data?.rows?.length) {
    return <div className="text-sm text-navy-400">No members to rank yet.</div>;
  }

  const { rows, weights } = data;
  const maxScore = rows[0]?.score || 100;

  return (
    <div className={embedded ? '' : 'mt-4'}>
      <Card>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-navy">
              <Trophy className="h-4 w-4 text-gold" />
              Participation Ranking
            </div>
            <div className="mt-1 text-[11px] text-navy-400">
              President-only. Score = {weights.attendance}% attendance +{' '}
              {weights.pitches}% pitches (capped at {weights.pitchCap}) +{' '}
              {weights.role}% role rank.
            </div>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-navy-400">
            <Users className="h-3 w-3" />
            {rows.length} ranked
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-100 text-left text-[10px] uppercase tracking-wider text-navy-400">
                <th className="py-2 pr-3 w-8">#</th>
                <th className="py-2 pr-3">Member</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3 w-40">Score</th>
                <th className="py-2 pr-3 text-right tabular-nums">Attend.</th>
                <th className="py-2 pr-3 text-right tabular-nums">Pitches</th>
                <th className="py-2 text-right tabular-nums">Role pts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-50">
              {rows.map((r, i) => {
                const medal =
                  i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
                return (
                  <tr key={r.id}>
                    <td className="py-2.5 pr-3 text-navy-400 tabular-nums">
                      {medal || i + 1}
                    </td>
                    <td className="py-2.5 pr-3 font-semibold text-navy">
                      {r.name}
                      <div className="text-[10px] font-normal text-navy-400">
                        {r.email}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <RoleBadge role={r.role} />
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="w-24">
                          <Bar value={r.score} max={maxScore} />
                        </div>
                        <span className="tabular-nums font-semibold text-navy">
                          {r.score.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-navy">
                      {r.attendance.ratePct}%
                      <div className="text-[10px] text-navy-400">
                        {r.attendance.present}/
                        {r.attendance.present + r.attendance.absent}
                        {r.attendance.excused > 0 && (
                          <> · {r.attendance.excused} excused</>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-navy">
                      {r.pitches}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-navy-400">
                      {r.components.role.toFixed(0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-navy-50 px-3 py-2 text-[11px] text-navy-400">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          <div>
            Rate = Present / (Present + Absent). Excused absences are
            neutral — they don't help or hurt. Pitches come from the
            presenter table (assignments), capped at {weights.pitchCap}{' '}
            for score purposes. Advisory, Faculty, and Chief of
            Communication roles are excluded from the ranking.
          </div>
        </div>
      </Card>
    </div>
  );
}
