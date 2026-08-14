import { createContext, useContext, useState, useCallback } from 'react';
import en from './en.js';
import am from './am.js';

const DICTS = { en, am };
const LOCALE_KEY = 'zemen.locale';

const I18nContext = createContext({ locale: 'en', t: (k) => k, setLocale: () => {} });

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(() => localStorage.getItem(LOCALE_KEY) || 'en');

  const setLocale = useCallback((l) => {
    localStorage.setItem(LOCALE_KEY, l);
    setLocaleState(l);
    document.documentElement.lang = l === 'am' ? 'am' : 'en';
  }, []);

  const t = useCallback(
    (key, params) => {
      let s = DICTS[locale][key] ?? en[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.replaceAll(`{${k}}`, String(v));
        }
      }
      return s;
    },
    [locale]
  );

  return <I18nContext.Provider value={{ locale, t, setLocale }}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
