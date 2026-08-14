import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Card, Spinner, Empty, StatusChip } from '../components/ui.jsx';
import { money, timeAgo, shortDate } from '../lib.js';

export default function Moderator() {
  const { t } = useI18n();
  const [queue, setQueue] = useState(null);
  const [flags, setFlags] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api('/api/disputes/modqueue').then(({ disputes }) => setQueue(disputes)),
      api('/api/directory').then(async ({ results }) => {
        const flagged = [];
        for (const r of results) {
          const prof = await api(`/api/users/${r.id}`).catch(() => null);
          if (prof?.flags?.length) flagged.push({ user: prof.user, flags: prof.flags });
        }
        setFlags(flagged);
      }),
    ]).catch((e) => setError(e.message));
  }, []);

  if (error) return <Empty text={error} />;
  if (!queue) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold tracking-tight">{t('mod.title')}</h1>

      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('dispute.queueTitle')} · {queue.length}</h2>
        {queue.length === 0 ? (
          <Card><Empty text={t('dispute.queueEmpty')} /></Card>
        ) : (
          <div className="space-y-2">
            {queue.map((d) => (
              <Link key={d.id} to={`/disputes/${d.id}`} className="card flex items-center justify-between gap-3 px-4 py-3 transition-all hover:border-brand">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{d.deal_description}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {d.party_a_name} ↔ {d.party_b_name} · {money(d.amount, d.currency)} · {timeAgo(d.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip statusKey="disputed" />
                  <ShieldCheck size={16} className="text-brand" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('mod.flagTitle')} · {flags.length}</h2>
        {flags.length === 0 ? (
          <Card><Empty text={t('mod.noFlags')} /></Card>
        ) : (
          <div className="space-y-2">
            {flags.map(({ user, flags }, i) => (
              <Card key={i} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <AlertTriangle size={15} /> {user.name} <span className="text-xs font-medium text-ink-soft">· {user.category}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {flags.map((f) => (
                    <div key={f.code} className="rounded-lg bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn">{f.label}</div>
                  ))}
                </div>
                <Link to={`/u/${user.id}`} className="mt-2 inline-block text-xs font-semibold text-brand hover:underline">{t('common.view')}</Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
