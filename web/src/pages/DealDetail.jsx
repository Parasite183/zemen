import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ShieldCheck, Lock, LockOpen, Scale, Hash, CheckCircle2, ChevronDown, ChevronUp, Banknote, KeyRound } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, Button, StatusChip, Spinner, Empty, ErrorBox, Avatar } from '../components/ui.jsx';
import { money, timeAgo, shortDate, dealActions, roleOf, otherParty, cx } from '../lib.js';

const STEPS = ['agreed', 'in_progress', 'delivered', 'confirmed'];

export default function DealDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [deal, setDeal] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showHash, setShowHash] = useState(false);
  // High-stakes actions (fund escrow, confirm large deals) require a
  // fresh one-time code sent to the user's phone. The server answers
  // with code 'otp_required' when one is needed; we prompt inline.
  const [otpFor, setOtpFor] = useState(null);
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);

  const load = useCallback(async () => {
    const { deal } = await api(`/api/deals/${id}`);
    if (!deal) { setError(t('err.deal_not_found')); return; }
    setDeal(deal);
    api(`/api/deals/${id}/ledger`).then(({ entries, chain }) => setLedger({ entries, chain })).catch(() => {});
  }, [id, t]);

  useEffect(() => { load(); }, [load]);

  const act = async (action, otpValue) => {
    setBusy(action);
    setError('');
    try {
      const body = otpValue ? { otp: otpValue } : undefined;
      const { deal } = await api(`/api/deals/${id}/${action}`, { method: 'POST', body });
      setDeal(deal);
      if (action === 'respond') await api(`/api/deals/${id}/ledger`).then(({ entries, chain }) => setLedger({ entries, chain })).catch(() => {});
      if (action === 'confirm') load();
      setOtpFor(null);
    } catch (e) {
      if (e.code === 'otp_required') {
        // Re-auth required: surface the inline code prompt, then retry.
        setOtpFor(action);
        setOtp('');
        setOtpSent(false);
        return;
      }
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const sendActionOtp = async () => {
    setOtpBusy(true);
    setError('');
    try {
      await api('/api/auth/action-otp', { method: 'POST' });
      setOtpSent(true);
      setOtp('');
    } catch (e) {
      setError(e.message);
    } finally {
      setOtpBusy(false);
    }
  };

  const respond = async (accept) => {
    setBusy('respond');
    setError('');
    try {
      const { deal } = await api(`/api/deals/${id}/respond`, { method: 'POST', body: { accept } });
      setDeal(deal);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  if (error && !deal) return <Empty text={error} />;
  if (!deal) return <Spinner />;

  const me = roleOf(deal, user.id);
  const other = otherParty(deal, user.id);
  const acts = dealActions(deal, user.id);
  const stepIdx = STEPS.indexOf(deal.status);
  const pastDeadline = deal.deadline && new Date(deal.deadline + 'T23:59:59') < new Date();

  const escrowMeta = {
    none: { label: t('deal.escrowState.none'), color: 'text-ink-soft', icon: null },
    funded: { label: t('deal.escrowState.funded'), color: 'text-warn', icon: <Lock size={15} /> },
    released: { label: t('deal.escrowState.released'), color: 'text-ok', icon: <LockOpen size={15} /> },
    refunded: { label: t('deal.escrowState.refunded'), color: 'text-ink-soft', icon: <LockOpen size={15} /> },
  }[deal.escrow_state] || {};

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight">{deal.description}</h1>
            <StatusChip statusKey={deal.status} />
          </div>
          <p className="mt-0.5 text-xs text-ink-soft">Ref {deal.ref} · {t(me === 'party_a' ? 'deal.yourRole.a' : 'deal.yourRole.b')}</p>
        </div>
      </div>

      <ErrorBox error={error} />

      <Card>
        <div className="mb-3 flex items-center gap-3">
          <Avatar name={other.name} size={40} />
          <div className="min-w-0">
            <div className="text-sm font-bold">{other.name}</div>
            <div className="text-xs text-ink-soft">
              {t('deal.counterparty')} · {other.category || '—'} · {other.phone}
              {other.id_verification_status === 'verified' && <span className="ml-1 text-ok font-semibold">✓ {t('profile.verified')}</span>}
            </div>
          </div>
          <Link to={`/u/${other.id}`} className="ml-auto shrink-0 text-xs font-semibold text-brand hover:underline">{t('common.view')}</Link>
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('deal.amount')}</div>
            <div className="font-bold">{money(deal.amount, deal.currency)}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('deal.deadlineLabel')}</div>
            <div className={cx('font-medium', pastDeadline && deal.status !== 'confirmed' && 'text-bad')}>
              {deal.deadline ? shortDate(deal.deadline) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('deal.deliverable')}</div>
            <div className="font-medium">{deal.deliverable || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Escrow</div>
            <div className={cx('flex items-center gap-1.5 font-medium', escrowMeta.color)}>{escrowMeta.icon} {escrowMeta.label}</div>
          </div>
        </div>
      </Card>

      {/* timeline stepper */}
      {['agreed', 'in_progress', 'delivered', 'confirmed', 'disputed', 'failed'].includes(deal.status) && (
        <Card>
          <div className="mb-3 text-sm font-bold">{t('deal.timeline')}</div>
          {deal.status === 'disputed' ? (
            <div className="rounded-xl bg-bad-soft px-4 py-3 text-sm font-medium text-bad">
              ⚖️ {t('deal.status.disputed')} — {deal.dispute_id ? <Link to={`/disputes/${deal.dispute_id}`} className="underline">{t('dispute.title')}</Link> : t('dispute.open')}
            </div>
          ) : deal.status === 'failed' ? (
            <div className="rounded-xl bg-bad-soft px-4 py-3 text-sm font-medium text-bad">✕ {t('deal.status.failed')}</div>
          ) : (
            <ol className="flex items-center">
              {STEPS.map((s, i) => (
                <li key={s} className={cx('flex items-center', i < STEPS.length - 1 && 'flex-1')}>
                  <div className="flex flex-col items-center">
                    <div className={cx(
                      'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors',
                      stepIdx >= i ? 'bg-brand text-white' : 'bg-paper text-ink-soft border border-line'
                    )}>
                      {stepIdx > i ? <CheckCircle2 size={16} /> : i + 1}
                    </div>
                    <span className={cx('mt-1.5 whitespace-nowrap text-[10px] font-semibold', stepIdx >= i ? 'text-brand' : 'text-ink-soft')}>
                      {t(`deal.status.${s}`)}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={cx('mx-1 mb-5 h-0.5 flex-1 rounded', stepIdx > i ? 'bg-brand' : 'bg-line')} />
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {/* terms */}
      {deal.terms && (
        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">{t('deal.terms')}</div>
            <span className="text-[11px] font-semibold text-ok">✓ {shortDate(deal.agreed_at)}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-paper px-3 py-2"><span className="text-ink-soft">{t('deal.description')}: </span>{deal.terms.description}</div>
            <div className="rounded-lg bg-paper px-3 py-2"><span className="text-ink-soft">{t('deal.deliverable')}: </span>{deal.terms.deliverable || '—'}</div>
            <div className="rounded-lg bg-paper px-3 py-2"><span className="text-ink-soft">{t('deal.amount')}: </span>{money(deal.terms.amount, deal.terms.currency)}</div>
            <div className="rounded-lg bg-paper px-3 py-2"><span className="text-ink-soft">{t('deal.deadlineLabel')}: </span>{deal.terms.deadline || '—'}</div>
          </div>
          <button className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-ink-soft hover:text-brand" onClick={() => setShowHash(!showHash)}>
            <Hash size={13} /> {t('deal.termsHash')}: {showHash ? deal.terms_hash : `${deal.terms_hash.slice(0, 12)}…`}
            {showHash ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </Card>
      )}

      {/* escrow */}
      {deal.escrow_enabled && (
        <Card>
          <div className="flex items-center gap-2 text-sm font-bold">
            <Banknote size={16} className="text-brand" /> Escrow · {escrowMeta.label}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            {t('deal.escrowHint')} {deal.escrow_ref && <span className="mt-2 block">{t('deal.escrowRef')}: <code className="rounded bg-paper px-1.5 py-0.5">{deal.escrow_ref}</code></span>}
          </p>
          {acts.deposit && (
            <Button className="mt-3" block onClick={() => act('escrow/deposit')} disabled={busy === 'escrow/deposit'}>
              <Lock size={15} /> {t('deal.deposit', { amount: money(deal.amount, deal.currency) })}
            </Button>
          )}
        </Card>
      )}

      {/* re-auth prompt for high-stakes actions */}
      {otpFor && (
        <Card className="border-warn/50">
          <div className="flex items-center gap-2 text-sm font-bold text-warn"><KeyRound size={15} /> {t('deal.otpTitle')}</div>
          <p className="mt-1 text-xs text-ink-soft">{t('deal.otpHint')}</p>
          {!otpSent ? (
            <Button size="sm" className="mt-3" variant="secondary" block onClick={sendActionOtp} disabled={otpBusy}>
              {otpBusy ? t('common.loading') : t('deal.otpSend')}
            </Button>
          ) : (
            <div className="mt-3 space-y-2">
              <input className="input text-center text-lg font-bold tracking-[0.4em]" inputMode="numeric" maxLength={6}
                value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoFocus />
              <div className="flex gap-2">
                <Button size="sm" block onClick={() => act(otpFor, otp)} disabled={otp.length < 6}>
                  {t('common.verify')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setOtpFor(null)}>{t('common.cancel')}</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* actions */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {acts.respond && (
          <>
            <Button className="flex-1" onClick={() => respond(true)} disabled={busy === 'respond'}>
              <CheckCircle2 size={16} /> {t('deal.accept')}
            </Button>
            <Button variant="danger" onClick={() => respond(false)} disabled={busy === 'respond'}>{t('deal.decline')}</Button>
          </>
        )}
        {acts.start && <Button block onClick={() => act('start')} disabled={busy === 'start'}>{t('deal.start')}</Button>}
        {acts.deliver && <Button block onClick={() => act('deliver')} disabled={busy === 'deliver'}>{t('deal.deliver')}</Button>}
        {acts.confirm && <Button block onClick={() => act('confirm')} disabled={busy === 'confirm'}>{t('deal.confirm')}</Button>}
        {acts.cancel && <Button variant="secondary" block onClick={() => act('cancel')} disabled={busy === 'cancel'}>{t('deal.cancel')}</Button>}
        {acts.dispute && (
          <Button variant="danger" block onClick={() => navigate(`/disputes/new?tx=${deal.id}`)}>
            <Scale size={15} /> {t('deal.dispute')}
          </Button>
        )}
      </div>

      {/* tamper-evidence */}
      {ledger && (
        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">{t('deal.verify')}</div>
            {ledger.chain.valid ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2.5 py-1 text-[11px] font-bold text-ok">
                <CheckCircle2 size={12} /> {t('deal.verifyOk')}
              </span>
            ) : (
              <span className="rounded-full bg-bad-soft px-2.5 py-1 text-[11px] font-bold text-bad">{t('deal.verifyBad')}</span>
            )}
          </div>
          <div className="mt-3 space-y-1.5">
            {ledger.entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-xs">
                <span className="w-36 shrink-0 font-mono font-semibold text-brand">{e.event}</span>
                <span className="truncate font-mono text-ink-soft">{e.hash.slice(0, 18)}…</span>
                <span className="ml-auto shrink-0 text-ink-soft">{timeAgo(e.created_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
