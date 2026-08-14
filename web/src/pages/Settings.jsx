import { useNavigate } from 'react-router-dom';
import { Languages, LogOut, Info } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../App.jsx';
import { Card, Button } from '../components/ui.jsx';
import { cx } from '../lib.js';

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const { signOut } = useAuth();
  const navigate = useNavigate();

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
        <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Info size={16} className="text-brand" /> {t('settings.dev')}</div>
        <div className="space-y-1 text-xs text-ink-soft">
          <div>API: <code className="rounded bg-paper px-1.5 py-0.5">/api</code></div>
          <div>Storage: SQLite (dev) / PostgreSQL (DATABASE_URL)</div>
          <div>SMS & mobile money: stub providers (see server/src/providers/)</div>
        </div>
      </Card>

      <Button variant="danger" block onClick={() => { signOut(); navigate('/login', { replace: true }); }}>
        <LogOut size={15} /> {t('settings.danger')}
      </Button>
    </div>
  );
}
