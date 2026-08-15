import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Paperclip, Send, Scale, UserCheck } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, Button, StatusChip, Spinner, Empty, ErrorBox, Avatar, Chip } from '../components/ui.jsx';
import { money, shortDate, cx } from '../lib.js';

export default function DisputeDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const { user } = useAuth();
  const [dispute, setDispute] = useState(null);
  const [body, setBody] = useState('');
  const [verdict, setVerdict] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [staffReason, setStaffReason] = useState('');

  const load = useCallback(() => {
    api(`/api/disputes/${id}`).then(({ dispute }) => setDispute(dispute)).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const submitStatement = async () => {
    setBusy('statement');
    setError('');
    try {
      const { dispute } = await api(`/api/disputes/${id}/statements`, { method: 'POST', body: { body } });
      setDispute(dispute);
      setBody('');
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const uploadEvidence = async (file) => {
    setBusy('evidence');
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/disputes/${id}/evidence`, { method: 'POST', headers: { authorization: `Bearer ${localStorage.getItem('zemen.token')}` }, body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      setDispute(json.dispute);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const submitVote = async () => {
    setBusy('vote');
    setError('');
    try {
      const { dispute } = await api(`/api/disputes/${id}/vote`, { method: 'POST', body: { verdict, note } });
      setDispute(dispute);
      setVerdict('');
      setNote('');
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  // Staff override is a two-person flow: propose (verdict + required
  // reason) stores it without resolving; a second staff account must
  // confirm the same verdict for it to take effect. Confirming the
  // other side sends the case back to the moderator panel.
  const staffOverride = async (action, v) => {
    setBusy('staff');
    setError('');
    try {
      const { dispute } = await api(`/api/disputes/${id}/resolve`, { method: 'POST', body: { action, verdict: v, reason: staffReason } });
      setDispute(dispute);
      setStaffReason('');
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  if (error && !dispute) return <Empty text={error} />;
  if (!dispute) return <Spinner />;

  const tx = dispute.transaction;
  const isMod = !!user.is_moderator;
  const isParty = tx && (tx.party_a_id === user.id || tx.party_b_id === user.id);
  const open = dispute.status === 'open';
  const resolution = dispute.resolution;
  const staffOverrides = dispute.staff_overrides || [];
  const pendingOverride = staffOverrides.find((o) => o.status === 'pending');
  const staffActed = !!pendingOverride && staffOverrides.some((o) => o.staff_id === user.id);
  const pendingSignoffs = staffOverrides.filter((o) => o.status === 'pending').length;
  const partyNames = {
    party_a: tx?.party_a?.name || 'Party A',
    party_b: tx?.party_b?.name || 'Party B',
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold">{t('dispute.title')} · {tx?.ref}</h1>
        <Chip className={open ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}>
          {open ? t('dispute.open') : t('dispute.resolved')}
        </Chip>
      </div>

      <ErrorBox error={error} />

      {!open && (
        <Card className="border-ok/40 bg-ok-soft/40">
          <div className="flex items-center gap-2 text-sm font-bold text-ok"><UserCheck size={16} /> {t('dispute.resolved')}</div>
          <p className="mt-1 text-sm">{t(`dispute.resolution.${resolution || 'confirmed'}`)}</p>
          <p className="mt-1 text-xs text-ink-soft">{t('dispute.verdict')}: {partyNames[dispute.verdict]} · {shortDate(dispute.resolved_at)}</p>
        </Card>
      )}

      <Card>
        <div className="text-sm font-bold">{tx?.description}</div>
        <div className="mt-0.5 text-xs text-ink-soft">
          {money(tx?.amount, tx?.currency)} · {t('dispute.byParty')} {tx?.party_a_id === dispute.raised_by ? 'Party A' : 'Party B'}
        </div>
        <div className="mt-2 text-sm">
          <span className="text-ink-soft">{t('dispute.reason')}: </span>“{dispute.reason || '—'}”
        </div>
      </Card>

      {/* statements */}
      <Card>
        <div className="mb-3 text-sm font-bold">{t('dispute.statements')}</div>
        <div className="space-y-2">
          {dispute.statements.length === 0 && <p className="text-sm text-ink-soft">—</p>}
          {dispute.statements.map((s) => (
            <div key={s.id} className="rounded-xl bg-paper px-4 py-3">
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                <span className="font-bold text-ink">{s.user_id === user.id ? t('deal.you') : (s.user_id === tx?.party_a_id ? 'Party A' : 'Party B')}</span>
                · {shortDate(s.created_at)}
              </div>
              <p className="mt-1 text-sm">{s.body}</p>
            </div>
          ))}
        </div>
        {isParty && open && (
          <div className="mt-3 flex gap-2">
            <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('dispute.statementPh')} />
            <Button size="sm" onClick={submitStatement} disabled={busy === 'statement' || !body.trim()}>
              <Send size={14} /> {t('dispute.submit')}
            </Button>
          </div>
        )}
      </Card>

      {/* evidence */}
      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Paperclip size={15} /> {t('dispute.evidence')}</div>
        <div className="space-y-2">
          {dispute.evidence.length === 0 && <p className="text-sm text-ink-soft">—</p>}
          {dispute.evidence.map((e) => (
            <a key={e.id} href={`/${e.file_path.replaceAll('\\', '/')}`} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-xl bg-paper px-4 py-2.5 text-sm hover:bg-brand-soft/40">
              <span className="truncate font-medium">{e.file_name}</span>
              <span className="ml-3 shrink-0 text-xs text-ink-soft">{shortDate(e.created_at)}</span>
            </a>
          ))}
        </div>
        {isParty && open && (
          <label className={cx('mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line px-4 py-3 text-sm font-semibold text-ink-soft transition-colors hover:border-brand hover:text-brand', busy === 'evidence' && 'opacity-50')}>
            <Paperclip size={15} /> {busy === 'evidence' ? t('common.loading') : t('dispute.upload')}
            <input type="file" className="hidden" accept="image/*,.pdf,.heic" onChange={(e) => e.target.files[0] && uploadEvidence(e.target.files[0])} />
          </label>
        )}
      </Card>

      {/* moderator panel */}
      {isMod && open && (
        <Card className="border-brand/30">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-brand"><Scale size={16} /> {t('dispute.vote')}</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setVerdict('party_a')} className={cx('rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors', verdict === 'party_a' ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-brand/50')}>
              {t('dispute.voteA')}
            </button>
            <button onClick={() => setVerdict('party_b')} className={cx('rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors', verdict === 'party_b' ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-brand/50')}>
              {t('dispute.voteB')}
            </button>
          </div>
          <input className="input mt-3" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('dispute.voteNote')} />
          <div className="mt-3 flex gap-2">
            <Button block onClick={submitVote} disabled={busy === 'vote' || !verdict}>{t('dispute.voteBtn')}</Button>
          </div>
          {user.is_staff && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-soft">{t('mod.staffResolve')}</div>
              {pendingOverride ? (
                staffActed ? (
                  <p className="text-xs text-ink-soft">You have already acted on this override — {pendingSignoffs}/{pendingOverride.required_signoffs} sign-offs collected.</p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-ink-soft">
                      {pendingOverride.staff_name} proposed <span className="font-semibold">{partyNames[pendingOverride.verdict]}</span> — {pendingSignoffs}/{pendingOverride.required_signoffs} sign-offs. Confirm the same side to apply it; the other side sends the case back to the moderator panel.
                    </p>
                    <input className="input mb-2" value={staffReason} onChange={(e) => setStaffReason(e.target.value)} placeholder="Required justification (goes on the audit record)" />
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => staffOverride('confirm', 'party_a')} disabled={busy === 'staff' || !staffReason.trim()}>Confirm Party A wins</Button>
                      <Button variant="secondary" size="sm" onClick={() => staffOverride('confirm', 'party_b')} disabled={busy === 'staff' || !staffReason.trim()}>Confirm Party B wins</Button>
                    </div>
                  </>
                )
              ) : staffOverrides.length > 0 ? (
                <p className="text-xs text-ink-soft">
                  Staff override {staffOverrides[0].status === 'applied' ? 'applied.' : 'ended in disagreement — the case is back with the moderator panel.'}
                </p>
              ) : (
                <>
                  <input className="input mb-2" value={staffReason} onChange={(e) => setStaffReason(e.target.value)} placeholder="Required justification (goes on the audit record)" />
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => staffOverride('propose', 'party_a')} disabled={busy === 'staff' || !staffReason.trim()}>Propose: Party A wins</Button>
                    <Button variant="secondary" size="sm" onClick={() => staffOverride('propose', 'party_b')} disabled={busy === 'staff' || !staffReason.trim()}>Propose: Party B wins</Button>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {/* votes cast */}
      {dispute.votes.length > 0 && (
        <Card>
          <div className="mb-2 text-sm font-bold">{t('dispute.verdict')}</div>
          {dispute.votes.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-lg bg-paper px-3 py-2 text-sm">
              <div>
                <span className="font-semibold">{v.moderator_name}</span>
                <span className="ml-2 text-xs text-ink-soft">{partyNames[v.verdict]}</span>
              </div>
              {v.note && <span className="ml-3 truncate text-xs text-ink-soft">{v.note}</span>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
