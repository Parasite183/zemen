import { cx } from '../lib.js';
import { useI18n } from '../i18n/index.jsx';
import { CheckCircle2, Loader2 } from 'lucide-react';

export function Card({ children, className, ...rest }) {
  return (
    <div className={cx('card p-4 sm:p-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function Button({ variant = 'primary', size, block, className, ...rest }) {
  return (
    <button
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', block && 'btn-block', className)}
      {...rest}
    />
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="field-label">{label}</label>
      {children}
      {hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
    </div>
  );
}

export function Chip({ children, className }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide', className)}>
      {children}
    </span>
  );
}

export function StatusChip({ statusKey, label }) {
  const { t } = useI18n();
  const meta = {
    pending: 'bg-slate2-soft text-slate2',
    agreed: 'bg-info-soft text-info',
    in_progress: 'bg-warn-soft text-warn',
    delivered: 'bg-brand-soft text-brand',
    confirmed: 'bg-ok-soft text-ok',
    disputed: 'bg-bad-soft text-bad',
    failed: 'bg-bad-soft text-bad',
    declined: 'bg-slate2-soft text-slate2',
    cancelled: 'bg-slate2-soft text-slate2',
  };
  const dot = {
    pending: 'bg-slate2', agreed: 'bg-info', in_progress: 'bg-warn', delivered: 'bg-brand',
    confirmed: 'bg-ok', disputed: 'bg-bad', failed: 'bg-bad', declined: 'bg-slate2', cancelled: 'bg-slate2',
  };
  return (
    <Chip className={meta[statusKey] || 'bg-slate2-soft text-slate2'}>
      <span className={cx('h-1.5 w-1.5 rounded-full', dot[statusKey] || 'bg-slate2')} />
      {label || t(`deal.status.${statusKey}`)}
    </Chip>
  );
}

export function VerifiedBadge({ status = 'none', small }) {
  const { t } = useI18n();
  if (status === 'verified') {
    return (
      <span className={cx('inline-flex items-center gap-1 font-semibold text-ok', small ? 'text-[11px]' : 'text-xs')}>
        <CheckCircle2 size={small ? 12 : 14} /> {t('profile.verified')}
      </span>
    );
  }
  if (status === 'pending') {
    return <span className="text-[11px] font-semibold text-warn">{t('profile.pending')}</span>;
  }
  return <span className="text-[11px] font-semibold text-ink-soft">{t('profile.unverified')}</span>;
}

export function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-paper px-3 py-3 border border-line">
      <div className="text-lg font-bold tracking-tight text-ink">{value}</div>
      <div className="text-[11px] font-medium text-ink-soft uppercase tracking-wide mt-0.5">{label}</div>
      {sub ? <div className="text-[10px] text-ink-soft mt-0.5">{sub}</div> : null}
    </div>
  );
}

export function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-ink-soft">
      <Loader2 size={18} className="animate-spin" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}

export function Empty({ text }) {
  return <div className="py-10 text-center text-sm text-ink-soft">{text}</div>;
}

export function Avatar({ name, size = 40 }) {
  const initials = (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-full bg-brand-soft text-brand font-bold"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="rounded-xl bg-bad-soft text-bad text-sm px-4 py-3 font-medium">
      {error}
    </div>
  );
}
