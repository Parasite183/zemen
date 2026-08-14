import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Printer, ShieldCheck, FileText, Hash } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { Spinner, Empty, VerifiedBadge, Chip } from '../components/ui.jsx';
import { money, pct, shortDate } from '../lib.js';

export default function Report() {
  const { token } = useParams();
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/api/public/report/${token}`).then(setData).catch((e) => setError(e.message));
  }, [token]);

  if (error) return <Empty text={error} />;
  if (!data) return <Spinner />;

  const { report, seal } = data;
  const r = report.reputation;

  return (
    <div className="min-h-screen bg-paper px-4 py-8">
      <div className="mx-auto max-w-2xl">
        {/* toolbar */}
        <div className="no-print mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-sm font-black text-white">ዘ</div>
            ዘመን Zemen · {t('rep.title')}
          </div>
          <button onClick={() => window.print()} className="btn btn-primary btn-sm">
            <Printer size={14} /> {t('rep.print')}
          </button>
        </div>

        <div className="print-area space-y-4">
          {/* header */}
          <div className="card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold">{report.subject.name}</h1>
                  <VerifiedBadge status={report.subject.verification} />
                </div>
                <p className="mt-1 text-sm capitalize text-ink-soft">
                  {report.subject.category || '—'} · {t('profile.join', { date: report.subject.joined })}
                </p>
              </div>
              <div className="text-right text-xs text-ink-soft">
                <div className="font-semibold text-ink">{t('rep.generated', { date: new Date(report.generatedAt).toLocaleString() })}</div>
                <div className="mt-0.5">Zemen · zemen.local</div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-5 sm:grid-cols-4">
              <div><div className="text-2xl font-black tracking-tight">{pct(r.completionRate)}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('dash.stats.completion')}</div></div>
              <div><div className="text-2xl font-black tracking-tight">{pct(r.onTimeRate)}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('dash.stats.ontime')}</div></div>
              <div><div className="text-2xl font-black tracking-tight">{pct(r.disputeRate)}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('dash.stats.dispute')}</div></div>
              <div><div className="text-2xl font-black tracking-tight">{money(r.totalVolume)}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('dash.stats.volume')}</div></div>
            </div>
            <p className="mt-3 text-[11px] text-ink-soft">✓ {r.completed} completed · ✕ {r.failed} failed · ⚖ {r.disputed} disputed</p>
          </div>

          {/* note */}
          <div className="rounded-xl bg-brand-soft/60 px-4 py-3 text-xs text-brand">
            <ShieldCheck size={13} className="mr-1 inline" /> {t('rep.note')}
          </div>

          {/* history */}
          <div className="card p-6">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-soft">
              <FileText size={15} /> {t('rep.history')}
            </h2>
            {report.history.length === 0 ? (
              <p className="text-sm text-ink-soft">{t('rep.none')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-soft">
                      <th className="pb-2 pr-3 font-semibold">{t('deal.description')}</th>
                      <th className="pb-2 pr-3 font-semibold">{t('deal.amount')}</th>
                      <th className="pb-2 pr-3 font-semibold">{t('deal.counterparty')}</th>
                      <th className="pb-2 pr-3 font-semibold">{t('deal.deadlineLabel')}</th>
                      <th className="pb-2 font-semibold">{t('deal.status.confirmed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.history.map((h, i) => {
                      const meSide = h.party_a_name === report.subject.name ? 'a' : 'b';
                      const onTime = h.deadline && h.delivered_at && Date.parse(h.delivered_at) <= Date.parse(`${h.deadline}T23:59:59`);
                      return (
                        <tr key={i} className="border-b border-line/60 last:border-0">
                          <td className="max-w-52 truncate py-2.5 pr-3 font-medium">{h.description}</td>
                          <td className="py-2.5 pr-3 font-semibold">{money(h.amount, h.currency)}</td>
                          <td className="py-2.5 pr-3">{meSide === 'a' ? h.party_b_name : h.party_a_name}</td>
                          <td className="py-2.5 pr-3 text-xs text-ink-soft">
                            {h.deadline ? shortDate(h.deadline) : '—'}
                            {h.deadline && h.delivered_at && (
                              <Chip className={onTime ? 'ml-1 bg-ok-soft text-ok' : 'ml-1 bg-warn-soft text-warn'}>
                                {onTime ? t('rep.onTime') : t('rep.late')}
                              </Chip>
                            )}
                          </td>
                          <td className="py-2.5">
                            {h.status === 'confirmed'
                              ? <Chip className="bg-ok-soft text-ok">{t('deal.status.confirmed')}</Chip>
                              : <Chip className="bg-bad-soft text-bad">{t('deal.status.failed')}</Chip>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* disputes */}
          {report.disputes.length > 0 && (
            <div className="card p-6">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('rep.disputes')}</h2>
              {report.disputes.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-xl bg-paper px-4 py-3 text-sm">
                  <span>Dispute #{d.id} · {shortDate(d.created_at)}</span>
                  <Chip className={d.resolution === 'confirmed' ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}>
                    {d.resolution === 'confirmed' ? t('dispute.resolution.confirmed') : t('dispute.resolution.failed')}
                  </Chip>
                </div>
              ))}
            </div>
          )}

          {/* seal */}
          <div className="card p-6">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-soft">
              <Hash size={15} /> {t('rep.seal')}
            </h2>
            <p className="mb-2 text-[11px] text-ink-soft">{t('rep.sealHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded-lg bg-paper px-3 py-2 font-mono text-[11px] text-brand">{seal}</code>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">SHA-256</span>
            </div>
          </div>
        </div>

        <p className="no-print mt-6 text-center text-[11px] text-ink-soft">
          Zemen (ዘመን) — a private trust layer, not a legal registry.
        </p>
      </div>
    </div>
  );
}
