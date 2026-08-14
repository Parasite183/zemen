import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, StatusChip, Spinner, Empty } from '../components/ui.jsx';
import { money, timeAgo, cx } from '../lib.js';

const FILTERS = ['all', 'pending', 'agreed', 'in_progress', 'delivered', 'confirmed', 'disputed', 'failed'];

export default function Deals() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [deals, setDeals] = useState(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/deals').then(({ deals }) => setDeals(deals)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Empty text={error} />;
  if (!deals) return <Spinner />;

  const shown = filter === 'all' ? deals : deals.filter((d) => d.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">{t('nav.deals')}</h1>
        <button onClick={() => navigate('/deals/new')} className="btn btn-primary btn-sm">
          <Plus size={15} /> {t('deal.new')}
        </button>
      </div>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cx(
              'shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors',
              filter === f ? 'bg-ink text-white' : 'bg-card text-ink-soft border border-line hover:border-brand'
            )}
          >
            {f === 'all' ? t('common.all') : t(`deal.status.${f}`)}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card><Empty text={t('deal.noDeals')} /></Card>
      ) : (
        <div className="space-y-2">
          {shown.map((d) => {
            const other = d.party_a_id === user.id ? d.party_b_name : d.party_a_name;
            const role = d.party_a_id === user.id ? 'a' : 'b';
            return (
              <Link key={d.id} to={`/deals/${d.id}`} className="card flex items-center justify-between gap-3 px-4 py-3 transition-all hover:border-brand">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{d.description}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {t('deal.with')} {other} · {t(`deal.role.${role}`)} · {timeAgo(d.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-sm font-bold">{money(d.amount, d.currency)}</span>
                  <StatusChip statusKey={d.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
