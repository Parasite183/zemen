import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Languages, LogOut, Info, MonitorSmartphone, PhoneOff } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../App.jsx';
import { Card, Button, Field, ErrorBox } from '../components/ui.jsx';
import { cx } from '../lib.js';

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);

  const signOutAll = async () => {
    setRevoking(true);
    setError('');
    try {
      await api('/api/auth/sessions/revoke-all', { method: 'POST' });
      signOut();
      navigate('/login', { replace: true });
    } catch (e) {
      setError(e.message);
      setRevoking(false);
    }
  };

  // Two-step phone change: request an action OTP (sent to the CURRENT
  // phone — that is the re-auth), then submit with the new number.
  const sendChangeCode = async () => {
    setPhoneBusy(true);
    setError('');
    try {
      await api('/api/auth/action-otp', { method: 'POST' });
      setCodeSent(true);
      setCode('');
    } catch (e) {
      setError(e.message);
    } finally {
      setPhoneBusy(false);
    }
  };

  const submitPhoneChange = async () => {
    setPhoneBusy(true);
    setError('');
    try {
      await api('/api/me/phone', { method: 'POST', body: { phone: newPhone, otp: code } });
      setNewPhone('');
      setCode('');
      setCodeSent(false);
      setError(t('settings.phoneDone'));
    } catch (e) {
      setError(e.message);
    } finally {
      setPhoneBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t('settings.title')}</h1>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Languages size={16} className="text-brand" /> {t('settings.language')}</div>
        <div className="grid grid-cols-2 gap-2">
          {[
            { code: 'en', label: t('settings.lang.en') },
            { code: 'am', label: t('settings.lang.am') },
          ].map((l) => (
            <button
              key={l.code}
              onClick={() => setLocale(l.code)}
              className={cx(
                'rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors',
                locale === l.code ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-soft hover:border-brand/50'
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><MonitorSmartphone size={16} className="text-brand" /> {t('settings.sessions')}</div>
        <p className="mb-3 text-xs text-ink-soft">{t('settings.sessionsHint')}</p>
        <Button size="sm" variant="secondary" block onClick={signOutAll} disabled={revoking}>
          <MonitorSmartphone size={14} /> {revoking ? t('common.loading') : t('settings.signOutAll')}
        </Button>
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><PhoneOff size={16} className="text-brand" /> {t('settings.phone')}</div>
        {!codeSent ? (
          <div className="space-y-3">
            <Field label={t('common.phone')}>
              <input className="input" inputMode="tel" placeholder="+251 9__ ___ ___" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" block onClick={sendChangeCode} disabled={phoneBusy || !newPhone.trim()}>
              {phoneBusy ? t('common.loading') : t('settings.phoneSendCode')}
            </Button>
            <p className="text-[11px] text-ink-soft">{t('settings.phoneHint')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-ink-soft">{t('settings.phoneCodeSent')}</p>
            <Field label={t('otp.code')}>
              <input className="input text-center text-lg font-bold tracking-[0.4em]" inputMode="numeric" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Button size="sm" block onClick={submitPhoneChange} disabled={phoneBusy || code.length < 6}>
              {phoneBusy ? t('common.loading') : t('settings.phoneConfirm')}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Info size={16} className="text-brand" /> {t('settings.dev')}</div>
        <div className="space-y-1 text-xs text-ink-soft">
          <div>API: <code className="rounded bg-paper px-1.5 py-0.5">/api</code></div>
          <div>Storage: SQLite (dev) / PostgreSQL (DATABASE_URL)</div>
          <div>SMS: {t('settings.providerLine')}</div>
        </div>
      </Card>

      <ErrorBox error={error} />

      <Button variant="danger" block onClick={() => { api('/api/auth/signout', { method: 'POST' }).catch(() => {}); signOut(); navigate('/login', { replace: true }); }}>
        <LogOut size={15} /> {t('settings.danger')}
      </Button>
    </div>
  );
}
