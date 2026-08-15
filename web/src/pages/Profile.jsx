import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, FileUp, FileText, Copy, Check, ShieldAlert, Scale } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, Stat, Avatar, VerifiedBadge, Button, Spinner, ErrorBox, Chip, Field } from '../components/ui.jsx';
import { money, pct, shortDate, cx } from '../lib.js';
import { imagePhash } from '../phash.js';

export default function Profile() {
  const { t } = useI18n();
  const { user, refresh } = useAuth();
  const fileRef = useRef();
  // undefined = not loaded yet; null = loaded but no reputation row yet
  // (fresh accounts). Only the former may show the spinner — otherwise a
  // brand-new user's profile spins forever.
  const [rep, setRep] = useState(undefined);
  const [reportToken, setReportToken] = useState('');
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [flags, setFlags] = useState([]);
  const [docType, setDocType] = useState('national_id');
  const [idNumber, setIdNumber] = useState('');
  const [dupNotice, setDupNotice] = useState('');

  useEffect(() => {
    api('/api/auth/me').then(({ user, reputation }) => setRep(reputation));
    api('/api/me/report-token').then(({ reportToken }) => setReportToken(reportToken));
    if (user.is_moderator) {
      api(`/api/users/${user.id}`).then((d) => setFlags(d.flags || [])).catch(() => {});
    }
  }, [user.id, user.is_moderator]);

  if (rep === undefined) return <Spinner />;

  const reportUrl = `${window.location.origin}/r/${reportToken}`;

  const uploadId = async (file) => {
    setUploading(true);
    setError('');
    setDupNotice('');
    try {
      const fd = new FormData();
      fd.append('document', file);
      fd.append('docType', docType);
      fd.append('idNumber', idNumber.trim());
      // Perceptual hash of the document image, computed in the browser.
      // The server also hashes the exact file bytes; both feed duplicate
      // detection (a re-photographed document is caught by phash, an
      // identical re-upload by the byte hash).
      try {
        fd.append('phash', await imagePhash(file));
      } catch {
        /* non-image documents (PDF) have no pixel hash — byte hash still applies */
      }
      const res = await fetch('/api/me/id-document', {
        method: 'POST',
        headers: { authorization: `Bearer ${localStorage.getItem('zemen.token')}` },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      if (json.duplicate?.code) setDupNotice(json.duplicate.label);
      await refresh();
      const me = await api('/api/auth/me');
      setRep(me.reputation);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Card className="text-center">
        <div className="flex justify-center"><Avatar name={user.name} size={72} /></div>
        <h1 className="mt-3 text-lg font-bold">{user.name}</h1>
        <div className="mt-1 text-xs capitalize text-ink-soft">
          {t(`onb.categories.${user.category}`) || user.category || '—'} · {user.phone}
        </div>
        <div className="mt-2 flex items-center justify-center">
          <VerifiedBadge status={user.id_verification_status} />
        </div>
      </Card>

      {user.id_verification_status !== 'verified' && (
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><ShieldCheck size={18} /></div>
            <div className="flex-1">
              <div className="text-sm font-bold">{t('profile.verifyCta')}</div>
              <div className="mt-1 text-xs text-ink-soft">
                {user.id_verification_status === 'pending' ? t('profile.uploadDone') : ''}
              </div>
              {user.id_verification_status !== 'pending' && (
                <div className="mt-3 space-y-2">
                  <div>
                    <label className="field-label">{t('profile.docType')}</label>
                    <div className="grid grid-cols-2 gap-2">
                      {['national_id', 'business_license'].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDocType(d)}
                          className={cx(
                            'rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                            docType === d ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-soft hover:border-brand/50'
                          )}
                        >
                          {t(`profile.docType.${d}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Field label={t('profile.idNumber')}>
                    <input className="input" value={idNumber} onChange={(e) => setIdNumber(e.target.value)}
                      placeholder="e.g. 1234567890" autoComplete="off" />
                  </Field>
                  <input ref={fileRef} type="file" accept="image/*,.pdf,.heic" className="hidden"
                    onChange={(e) => e.target.files[0] && uploadId(e.target.files[0])} />
                  <Button size="sm" block variant="secondary" onClick={() => fileRef.current?.click()} disabled={uploading}>
                    <FileUp size={14} /> {uploading ? t('common.loading') : t('profile.uploadId')}
                  </Button>
                  {dupNotice && (
                    <div className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn">{dupNotice}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <ErrorBox error={error} />

      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('profile.stats')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Stat value={pct(rep?.completion_rate)} label={t('dash.stats.completion')} sub={`${rep?.total_completed ?? 0} ${t('dir.completed', { n: '' }).trim()}`} />
          <Stat value={pct(rep?.on_time_rate)} label={t('dash.stats.ontime')} />
          <Stat value={pct(rep?.dispute_rate)} label={t('dash.stats.dispute')} sub={`${rep?.total_disputed ?? 0} disputes`} />
          <Stat value={money(rep?.total_volume)} label={t('dash.stats.volume')} />
        </div>
      </div>

      {flags.length > 0 && (
        <Card className="border-warn/40">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-warn">{t('profile.flags')}</div>
          {flags.map((f) => (
            <div key={f.code} className="mb-1 flex items-center gap-1.5 rounded-lg bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn">
              <ShieldAlert size={13} /> {f.label}
            </div>
          ))}
        </Card>
      )}

      <Card className="border-brand/30 bg-brand-soft/40">
        <div className="flex items-center gap-2 text-sm font-bold text-brand"><FileText size={16} /> {t('profile.report')}</div>
        <p className="mt-1 text-xs text-ink-soft">{t('profile.reportHint')}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" block onClick={copyReport}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('common.copied') : t('profile.copyReport')}
          </Button>
          <Link to={`/r/${reportToken}`} target="_blank" className="btn btn-secondary btn-sm">
            {t('common.view')}
          </Link>
        </div>
        <p className="mt-2 truncate text-[10px] text-ink-soft">{reportUrl}</p>
      </Card>

      {(user.is_moderator || user.is_staff || user.is_owner) && (
        <Link to="/moderator" className="card flex items-center gap-3 px-4 py-3 transition-all hover:border-brand">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-brand"><Scale size={16} /></div>
          <div>
            <div className="text-sm font-bold">{t('nav.moderator')}</div>
            <div className="text-xs text-ink-soft">{t('dispute.queueTitle')}</div>
          </div>
          <Chip className="ml-auto bg-brand-soft text-brand">{t('nav.moderator')}</Chip>
        </Link>
      )}
    </div>
  );
}
