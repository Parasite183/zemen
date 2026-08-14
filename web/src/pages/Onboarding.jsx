import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Button, Field, ErrorBox } from '../components/ui.jsx';

const CATEGORIES = ['freelance', 'trade', 'agriculture', 'transport', 'construction', 'services', 'other'];

export default function Onboarding() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/me', { method: 'PATCH', body: { name, category, bio } });
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-black text-white">ዘ</div>
        <h1 className="text-xl font-bold">{t('onb.welcome')}</h1>
        <p className="mt-1 text-sm text-ink-soft">{t('onb.subtitle')}</p>
      </div>

      <div className="card space-y-5 p-6">
        <Field label={t('onb.name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Abebe Kebede" />
        </Field>

        <div>
          <label className="field-label">{t('onb.category')}</label>
          <div className="grid grid-cols-2 gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  category === c ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-card text-ink hover:border-brand/50'
                }`}
              >
                {t(`onb.categories.${c}`)}
              </button>
            ))}
          </div>
        </div>

        <Field label={`${t('onb.bio')} · ${t('common.optional')}`}>
          <textarea className="input min-h-20 resize-none" value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>

        <ErrorBox error={error} />
        <Button block onClick={save} disabled={busy || !name.trim()}>
          {busy ? t('common.loading') : t('onb.cta')}
        </Button>
      </div>
    </div>
  );
}
