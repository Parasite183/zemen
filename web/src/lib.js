export const cx = (...parts) => parts.filter(Boolean).join(' ');

export function money(amount, currency = 'ETB') {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'ETB' ? 0 : 2,
    }).format(amount || 0);
  } catch {
    return `${amount || 0} ${currency}`;
  }
}

export function pct(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round((rate || 0) * 100)}%`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Visual metadata for every deal status. */
export const STATUS = {
  pending:      { label: 'deal.status.pending',      chip: 'bg-slate2-soft text-slate2', dot: 'bg-slate2' },
  agreed:       { label: 'deal.status.agreed',       chip: 'bg-info-soft text-info', dot: 'bg-info' },
  in_progress:  { label: 'deal.status.in_progress',  chip: 'bg-warn-soft text-warn', dot: 'bg-warn' },
  delivered:    { label: 'deal.status.delivered',    chip: 'bg-brand-soft text-brand', dot: 'bg-brand' },
  confirmed:    { label: 'deal.status.confirmed',    chip: 'bg-ok-soft text-ok', dot: 'bg-ok' },
  disputed:     { label: 'deal.status.disputed',     chip: 'bg-bad-soft text-bad', dot: 'bg-bad' },
  failed:       { label: 'deal.status.failed',       chip: 'bg-bad-soft text-bad', dot: 'bg-bad' },
  declined:     { label: 'deal.status.declined',     chip: 'bg-slate2-soft text-slate2', dot: 'bg-slate2' },
  cancelled:    { label: 'deal.status.cancelled',    chip: 'bg-slate2-soft text-slate2', dot: 'bg-slate2' },
};

export const ESCROW = {
  none:     'deal.escrowState.none',
  funded:   'deal.escrowState.funded',
  released: 'deal.escrowState.released',
  refunded: 'deal.escrowState.refunded',
};

export const roleOf = (deal, meId) => (deal.party_a_id === meId ? 'party_a' : 'party_b');
export const otherParty = (deal, meId) => (deal.party_a_id === meId ? deal.party_b : deal.party_a);

/** Which actions are available to the current user on this deal. */
export function dealActions(deal, meId) {
  const me = roleOf(deal, meId);
  const acts = { respond: false, deposit: false, start: false, deliver: false, confirm: false, dispute: false, cancel: false };
  if (!deal) return acts;
  const isPartyB = me === 'party_b';
  if (deal.status === 'pending' && isPartyB) acts.respond = true;
  if (deal.status === 'pending' && !isPartyB) acts.cancel = true;
  if (deal.status === 'agreed') {
    acts.start = true;
    if (deal.escrow_enabled && deal.escrow_state !== 'funded' && me === 'party_a') acts.deposit = true;
    acts.dispute = true;
    acts.cancel = me === 'party_a';
  }
  if (deal.status === 'in_progress') {
    acts.deliver = true;
    acts.dispute = true;
  }
  if (deal.status === 'delivered') {
    if (deal.delivered_by !== meId) acts.confirm = true;
    acts.dispute = true;
  }
  return acts;
}

export function maskPhone(phone) {
  const s = String(phone || '');
  return s.length > 7 ? `${s.slice(0, 5)} ••• ••• ${s.slice(-3)}` : s;
}
