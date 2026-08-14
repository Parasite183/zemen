import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Handshake, ShieldCheck } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Card, Spinner, Empty, Avatar, Stat, Button } from '../components/ui.jsx';
import { money, pct, shortDate } from '../lib.js';

export default function PublicProfile() {
  const { id } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/api/users/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <Empty text={error} />;
  if (!data) return <Spinner />;

  const { user, reputation: rep, flags } = data;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Card className="text-center">
        <div className="flex justify-center"><Avatar name={user.name} size={72} /></div>
        <h1 className="mt-3 text-lg font-bold">{user.name}</h1>
        <div className="mt-1 flex items-center justify-center gap-2 text-xs text-ink-soft">
          <span className="capitalize">{t(`onb.categories.${user.category}`) || user.category || '—'}</span>
          {user.id_verification_status === 'verified' && (
            <span className="inline-flex items-center gap-1 font-semibold text-ok"><ShieldCheck size={13} /> {t('profile.verified')}</span>
          )}
        </div>
        {user.bio && <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">{user.bio}</p>}
        <p className="mt-2 text-xs text-ink-soft">{t('profile.join', { date: shortDate(user.created_at) })}</p>
        {user.phone && <p className="mt-1 text-xs text-ink-soft">{user.phone}</p>}

        <Button className="mt-4" block onClick={() => navigate(`/deals/new?userId=${user.id}&name=${encodeURIComponent(user.name)}`)}>
          <Handshake size={16} /> {t('dir.deal')}
        </Button>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Stat value={pct(rep?.completion_rate)} label={t('dash.stats.completion')} />
        <Stat value={pct(rep?.on_time_rate)} label={t('dash.stats.ontime')} />
        <Stat value={pct(rep?.dispute_rate)} label={t('dash.stats.dispute')} />
        <Stat value={money(rep?.total_volume)} label={t('dash.stats.volume')} />
      </div>

      {flags?.length > 0 && (
        <Card className="border-warn/40">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-warn">{t('profile.flags')}</div>
          {flags.map((f) => <div key={f.code} className="rounded-lg bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn">{f.label}</div>)}
        </Card>
      )}
    </div>
  );
}
