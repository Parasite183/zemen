import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Home, Handshake, Users, UserCircle, Scale, ShieldCheck, Settings, Globe } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';
import { Avatar } from './ui.jsx';
import { cx } from '../lib.js';

const items = (isMod) => [
  { to: '/', key: 'nav.home', icon: Home, end: true },
  { to: '/deals', key: 'nav.deals', icon: Handshake },
  { to: '/directory', key: 'nav.directory', icon: Users },
  { to: '/disputes', key: 'nav.disputes', icon: Scale },
  ...(isMod ? [{ to: '/moderator', key: 'nav.moderator', icon: ShieldCheck }] : []),
  { to: '/profile', key: 'nav.profile', icon: UserCircle },
];

export default function AppLayout({ user }) {
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const isMod = !!user?.is_moderator;

  return (
    <div className="min-h-screen">
      {/* header */}
      <header className="no-print sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-white text-sm font-black">ዘ</div>
            <div className="text-left leading-tight">
              <div className="text-sm font-bold tracking-tight">ዘመን Zemen</div>
              <div className="text-[10px] text-ink-soft">{t('app.tagline')}</div>
            </div>
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocale(locale === 'am' ? 'en' : 'am')}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-semibold text-ink hover:border-brand"
              title={t('settings.language')}
            >
              <Globe size={13} className="text-ink-soft" />
              {locale === 'am' ? 'EN' : 'አማ'}
            </button>
            <button
              aria-label="settings"
              onClick={() => navigate('/settings')}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-ink hover:border-brand"
              title={t('nav.settings')}
            >
              <Settings size={15} />
            </button>
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pl-1 pr-2.5 hover:border-brand transition-colors"
            >
              <Avatar name={user?.name} size={26} />
              <span className="hidden text-xs font-semibold sm:block">{user?.name || '—'}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 pb-24 pt-5 sm:pb-8">
        {/* desktop sidebar */}
        <aside className="no-print hidden w-44 shrink-0 md:block">
          <nav className="sticky top-20 space-y-1">
            {items(isMod).map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive ? 'nav-active' : 'text-ink-soft hover:bg-brand-soft/50 hover:text-brand'
                  )
                }
              >
                <it.icon size={17} /> {t(it.key)}
              </NavLink>
            ))}
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'nav-active' : 'text-ink-soft hover:bg-brand-soft/50 hover:text-brand'
                )
              }
            >
              <Settings size={17} /> {t('nav.settings')}
            </NavLink>
          </nav>
        </aside>

        <main className="fade-in min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {/* mobile bottom nav */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur md:hidden pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-5">
          {items(isMod).slice(0, 5).map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                cx(
                  'flex flex-col items-center gap-1 py-2.5 text-[10px] font-semibold',
                  isActive ? 'text-brand' : 'text-ink-soft'
                )
              }
            >
              <it.icon size={20} />
              {t(it.key)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
