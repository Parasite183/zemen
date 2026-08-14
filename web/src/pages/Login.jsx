import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Smartphone, ShieldCheck } from 'lucide-react';
import { api, setToken } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Button, Field, ErrorBox } from '../components/ui.jsx';
import { deviceFingerprint } from '../fingerprint.js';

const DEMOS = [
  { name: 'Abebe Kebede', phone: '+251911000001' },
  { name: 'Sara Tesfaye', phone: '+251911000002' },
  { name: 'Lidya Hailu (moderator)', phone: '+251911000004' },
];

export default function Login() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const sendCode = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
      setSent(true);
      setCode('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code, device: deviceFingerprint() } });
      setToken(data.token);
      await refresh(); // load the session into App state BEFORE navigating
      navigate(data.isNew ? '/onboarding' : '/', { replace: true });
    } catch (e) {
      setError(e.message || t('otp.wrong'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-brand-deep via-brand to-brand-deep px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-2xl font-black backdrop-blur">ዘ</div>
          <h1 className="text-2xl font-bold tracking-tight">ዘመን Zemen</h1>
          <p className="mt-1 text-sm text-white/80">{t('app.tagline')}</p>
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-white/90">
            <ShieldCheck size={13} /> {t('app.pill')}
          </div>
        </div>

        <div className="card p-6">
          <h2 className="text-lg font-bold">{t('otp.title')}</h2>
          <p className="mb-4 mt-1 text-sm text-ink-soft">{t('otp.subtitle')}</p>

          {!sent ? (
            <div className="space-y-4">
              <Field label={t('common.phone')}>
                <input
                  className="input"
                  inputMode="tel"
                  placeholder="+251 9__ ___ ___"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoFocus
                />
              </Field>
              <ErrorBox error={error} />
              <Button block onClick={sendCode} disabled={busy || !phone.trim()}>
                <Smartphone size={16} /> {busy ? t('common.loading') : t('common.sendCode')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl bg-brand-soft px-4 py-3 text-sm font-medium text-brand">
                {t('otp.codeSent', { phone })}
              </div>
              <Field label={t('otp.code')}>
                <input
                  className="input text-center text-lg font-bold tracking-[0.4em]"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
              </Field>
              <ErrorBox error={error} />
              <Button block onClick={verify} disabled={busy || code.length < 6}>
                {busy ? t('common.loading') : t('common.verify')}
              </Button>
              <div className="flex items-center justify-between text-xs">
                <button className="font-semibold text-brand hover:underline" onClick={() => { setSent(false); setError(''); }}>
                  {t('otp.resend')}
                </button>
                <button
                  className="font-semibold text-ink-soft hover:text-brand"
                  onClick={async () => {
                    try {
                      const { code } = await api(`/api/auth/dev/otp?phone=${encodeURIComponent(phone)}`);
                      if (code) setCode(code);
                    } catch { /* dev endpoint only exists in DEV_MODE */ }
                  }}
                >
                  ⚡ {t('otp.devFill')}
                </button>
              </div>
            </div>
          )}

          <p className="mt-4 rounded-lg bg-paper px-3 py-2 text-[11px] leading-relaxed text-ink-soft">
            {t('otp.devHint')}
          </p>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-widest text-white/70">
            {t('otp.demoAccounts')}
          </p>
          <div className="grid gap-2">
            {DEMOS.map((d) => (
              <button
                key={d.phone}
                onClick={() => { setPhone(d.phone); setSent(false); setError(''); }}
                className="flex items-center justify-between rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-left backdrop-blur transition-colors hover:bg-white/20"
              >
                <div>
                  <div className="text-sm font-semibold text-white">{d.name}</div>
                  <div className="text-[11px] text-white/70">{d.phone}</div>
                </div>
                <span className="rounded-lg bg-white/15 px-2.5 py-1 text-[11px] font-bold text-white">{t('otp.fill')}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
