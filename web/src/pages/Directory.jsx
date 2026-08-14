import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Handshake } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Card, Spinner, Empty, Avatar, VerifiedBadge } from '../components/ui.jsx';
import { money, pct, cx } from '../lib.js';

export default function Directory() {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/directory').then((d) => setData(d)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Empty text={error} />;
  if (!data) return <Spinner />;

  const ql = q.trim().toLowerCase();
  const results = data.results.filter((r) => {
    const matchesQ = !ql || (r.name || '').toLowerCase().includes(ql) || (r.category || '').toLowerCase().includes(ql);
    const matchesCat = !category || r.category === category;
    return matchesQ && matchesCat;
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t('dir.title')}</h1>

      <div className="relative">
        <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-soft" />
        <input className="input pl-10" placeholder={t('dir.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <button
          onClick={() => setCategory('')}
          className={cx('shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors', !category ? 'bg-ink text-white' : 'bg-card border border-line text-ink-soft')}
        >
          {t('common.all')}
        </button>
        {data.categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c === category ? '' : c)}
            className={cx('shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors', category === c ? 'bg-ink text-white' : 'bg-card border border-line text-ink-soft')}
          >
            {t(`onb.categories.${c}`) || c}
          </button>
        ))}
      </div>

      {results.length === 0 ? (
        <Card><Empty text={t('dir.empty')} /></Card>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {results.map((r) => (
            <Link key={r.id} to={`/u/${r.id}`} className="card p-4 transition-all hover:border-brand">
              <div className="flex items-start gap-3">
                <Avatar name={r.name} size={42} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold">{r.name}</span>
                    {r.id_verification_status === 'verified' && <VerifiedBadge status="verified" small />}
                  </div>
                  <div className="text-xs capitalize text-ink-soft">{t(`onb.categories.${r.category}`) || r.category}</div>
                  {r.bio && <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{r.bio}</p>}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs">
                <div className="flex gap-4">
                  <span><b className="text-ink">{pct(r.completion_rate)}</b> <span className="text-ink-soft">{t('dash.stats.completion')}</span></span>
                  <span><b className="text-ink">{r.total_completed || 0}</b> <span className="text-ink-soft">{t('dir.completed', { n: '' }).trim()}</span></span>
                  <span><b className="text-ink">{money(r.total_volume)}</b></span>
                </div>
                <Handshake size={15} className="text-brand" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
