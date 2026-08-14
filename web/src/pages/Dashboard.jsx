import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ArrowRight, Inbox } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, Stat, StatusChip, Spinner, Empty } from '../components/ui.jsx';
import { money, pct, timeAgo, dealActions } from '../lib.js';

export default function Dashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/auth/me').then(({ user, reputation }) => {
      api('/api/deals').then(({ deals }) => setData({ user, reputation, deals }));
    }).catch((e) => setError(e.message));
  }, []);

  if (error) return <Empty text={error} />;
  if (!data) return <Spinner />;

  const { reputation: rep, deals } = data;
  const attention = deals.filter((d) => {
    const a = dealActions(d, user.id);
    return a.respond || a.deposit || a.confirm;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{t('dash.greeting', { name: (user.name || '').split(' ')[0] })}</h1>
          <p className="text-sm text-ink-soft">{t('dash.title')} · {user.phone}</p>
        </div>
        <button onClick={() => navigate('/deals/new')} className="btn btn-primary btn-sm">
          <Plus size={15} /> {t('dash.newDeal')}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat value={pct(rep?.completion_rate)} label={t('dash.stats.completion')} sub={`${rep?.total_completed ?? 0} ${t('dir.completed', { n: '' }).trim()}`} />
        <Stat value={pct(rep?.on_time_rate)} label={t('dash.stats.ontime')} />
        <Stat value={pct(rep?.dispute_rate)} label={t('dash.stats.dispute')} sub={`${rep?.total_disputed ?? 0} disputes`} />
        <Stat value={money(rep?.total_volume)} label={t('dash.stats.volume')} />
      </div>

      {attention.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2 text-sm font-bold">
            <Inbox size={16} className="text-brand" /> {t('dash.attention')}
          </div>
          <div className="space-y-2">
            {attention.map((d) => {
              const other = d.party_a_id === user.id ? d.party_b_name : d.party_a_name;
              return (
                <Link key={d.id} to={`/deals/${d.id}`} className="flex items-center justify-between rounded-xl border border-line px-4 py-3 transition-colors hover:border-brand">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{d.description}</div>
                    <div className="text-xs text-ink-soft">{other} · {money(d.amount, d.currency)}</div>
                  </div>
                  <ArrowRight size={16} className="shrink-0 text-ink-soft" />
                </Link>
              );
            })}
          </div>
        </Card>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-soft">{t('dash.recent')}</h2>
          <Link to="/deals" className="text-xs font-semibold text-brand hover:underline">{t('dash.allDeals')}</Link>
        </div>
        {deals.length === 0 ? (
          <Card><Empty text={t('deal.noDeals')} /></Card>
        ) : (
          <div className="space-y-2">
            {deals.slice(0, 5).map((d) => {
              const other = d.party_a_id === user.id ? d.party_b_name : d.party_a_name;
              return (
                <Link key={d.id} to={`/deals/${d.id}`} className="card flex items-center justify-between px-4 py-3 transition-all hover:border-brand">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{d.description}</div>
                    <div className="text-xs text-ink-soft">{other} · {timeAgo(d.created_at)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-bold">{money(d.amount, d.currency)}</span>
                    <StatusChip statusKey={d.status} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
