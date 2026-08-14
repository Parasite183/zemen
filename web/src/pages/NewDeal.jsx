import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, UserRound, ShieldAlert } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Button, Field, ErrorBox, Card } from '../components/ui.jsx';
import { cx, money } from '../lib.js';

export default function NewDeal() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [userId, setUserId] = useState(params.get('userId') ? Number(params.get('userId')) : 0);
  const [counterpartyName, setCounterpartyName] = useState(params.get('name') || '');
  const [phone, setPhone] = useState(params.get('phone') || '');
  const [description, setDescription] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('ETB');
  const [deadline, setDeadline] = useState('');
  const [escrow, setEscrow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    api('/api/auth/me').then(({ limits }) => setLimits(limits)).catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { deal } = await api('/api/deals', {
        method: 'POST',
        body: {
          userId: userId || undefined,
          phone: userId ? undefined : phone,
          description,
          deliverable,
          amount: Number(amount),
          currency,
          deadline: deadline || undefined,
          escrow,
        },
      });
      setCreated(deal);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="mx-auto max-w-md">
        <Card className="p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ok-soft">
            <ShieldCheck size={26} className="text-ok" />
          </div>
          <h2 className="text-lg font-bold">{t('deal.created')}</h2>
          <p className="mt-2 text-sm text-ink-soft">
            {t('deal.with')} {created.party_b.name} · {money(created.amount, created.currency)}
          </p>
          <div className="mt-6 flex gap-2">
            <Button variant="secondary" block onClick={() => navigate('/deals')}>{t('common.back')}</Button>
            <Button block onClick={() => navigate(`/deals/${created.id}`)}>{t('common.view')}</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t('deal.new')}</h1>

      {user.id_verification_status !== 'verified' && limits && (
        <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-xs text-warn">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            {t('deal.unverifiedHint', {
              free: money(limits.freeDealThresholdEtb, 'ETB'),
              cap: money(limits.unverifiedLifetimeVolumeEtb, 'ETB'),
            })}
          </span>
        </div>
      )}

      {counterpartyName && (
        <div className="flex items-center gap-3 rounded-xl bg-brand-soft px-4 py-3 text-sm font-medium text-brand">
          <UserRound size={18} />
          {t('deal.with')} {counterpartyName}
          <button className="ml-auto text-xs font-semibold underline" onClick={() => { setUserId(0); setCounterpartyName(''); }}>{t('common.cancel')}</button>
        </div>
      )}

      <Card className="space-y-4 p-5">
        {!counterpartyName && (
          <Field label={t('deal.phoneOrUser')}>
            <input className="input" inputMode="tel" placeholder="+251 9__ ___ ___" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        )}

        <Field label={t('deal.description')}>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('deal.descriptionPh')} />
        </Field>

        <Field label={t('deal.deliverable')}>
          <input className="input" value={deliverable} onChange={(e) => setDeliverable(e.target.value)} placeholder={t('deal.deliverablePh')} />
        </Field>

        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={t('deal.amount')}>
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="15000" />
          </Field>
          <Field label={t('deal.currency')}>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>ETB</option>
              <option>USD</option>
              <option>KES</option>
            </select>
          </Field>
        </div>

        <Field label={`${t('deal.deadline')} · ${t('common.optional')}`}>
          <input type="date" className="input" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>

        <button
          onClick={() => setEscrow(!escrow)}
          className={cx(
            'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
            escrow ? 'border-brand bg-brand-soft' : 'border-line bg-card hover:border-brand/50'
          )}
        >
          <div className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors', escrow ? 'border-brand bg-brand' : 'border-line')}>
            {escrow && <ShieldCheck size={13} className="text-white" />}
          </div>
          <div>
            <div className="text-sm font-semibold">{t('deal.escrow')}</div>
            <div className="mt-0.5 text-xs text-ink-soft">{t('deal.escrowHint')}</div>
          </div>
        </button>

        <ErrorBox error={error} />
        <Button block onClick={submit} disabled={busy || !description.trim() || !amount || !(phone.trim() || userId)}>
          {busy ? t('common.loading') : t('deal.create')}
        </Button>
      </Card>
    </div>
  );
}
