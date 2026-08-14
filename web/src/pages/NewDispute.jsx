import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Card, Button, Field, ErrorBox, Spinner, Empty } from '../components/ui.jsx';
import { money } from '../lib.js';

export default function NewDispute() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const txId = Number(params.get('tx'));
  const [deal, setDeal] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!txId) { setError(t('err.deal_not_found')); return; }
    api(`/api/deals/${txId}`).then(({ deal }) => {
      if (!deal) setError(t('err.deal_not_found'));
      else setDeal(deal);
    }).catch((e) => setError(e.message));
  }, [txId, t]);

  const raise = async () => {
    setBusy(true);
    setError('');
    try {
      const { dispute } = await api('/api/disputes', { method: 'POST', body: { transaction_id: txId, reason } });
      navigate(`/disputes/${dispute.id}`, { replace: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (!deal) return error ? <Empty text={error} /> : <Spinner />;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t('dispute.newTitle')}</h1>
      <Card className="space-y-4 p-5">
        <div className="rounded-xl bg-paper px-4 py-3 text-sm">
          <div className="font-semibold">{deal.description}</div>
          <div className="text-xs text-ink-soft">{money(deal.amount, deal.currency)} · Ref {deal.ref}</div>
        </div>
        <Field label={t('dispute.reason')}>
          <textarea className="input min-h-24 resize-none" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('dispute.reasonPh')} />
        </Field>
        <ErrorBox error={error} />
        <Button block variant="danger" onClick={raise} disabled={busy || !reason.trim()}>
          <Scale size={15} /> {busy ? t('common.loading') : t('dispute.raiseBtn')}
        </Button>
      </Card>
    </div>
  );
}
