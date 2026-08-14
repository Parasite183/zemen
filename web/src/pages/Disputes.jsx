import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Card, Spinner, Empty, Chip } from '../components/ui.jsx';
import { money, shortDate, cx } from '../lib.js';

export default function Disputes() {
  const { t } = useI18n();
  const [disputes, setDisputes] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/disputes').then(({ disputes }) => setDisputes(disputes)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Empty text={error} />;
  if (!disputes) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t('dispute.title')}</h1>
      {disputes.length === 0 ? (
        <Card><Empty text={t('dispute.noDisputes')} /></Card>
      ) : (
        <div className="space-y-2">
          {disputes.map((d) => (
            <Link key={d.id} to={`/disputes/${d.id}`} className="card flex items-center justify-between gap-3 px-4 py-3 transition-all hover:border-brand">
              <div className="flex min-w-0 items-center gap-3">
                <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', d.status === 'open' ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok')}>
                  <Scale size={16} />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{d.deal_description}</div>
                  <div className="text-xs text-ink-soft">Ref {d.deal_ref} · {shortDate(d.created_at)}</div>
                </div>
              </div>
              <Chip className={d.status === 'open' ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}>
                {d.status === 'open' ? t('dispute.open') : t('dispute.resolved')}
              </Chip>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
