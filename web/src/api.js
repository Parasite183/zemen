import { useEffect, useState } from 'react';

const TOKEN_KEY = 'zemen.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, token = getToken() } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?', 'network');
  }

  // Silent refresh: a near-expiry token comes back with a fresh one in
  // a response header; swap it in without forcing a re-login.
  const refreshed = res.headers.get('x-zemen-refresh');
  if (refreshed) setToken(refreshed);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) {
      clearToken();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    throw new ApiError(res.status, data.error || 'Request failed', data.code);
  }
  return data;
}

/**
 * Fetch an access-gated /uploads/... file with the auth token and
 * expose it as a blob URL the browser can render directly. Plain
 * <img src>/<a href> can't send the Authorization header, so raw
 * /uploads paths always 401 — this is how documents/evidence are
 * actually displayed. Returns '' while loading or on failure; the
 * object URL is revoked when the path changes or the component unmounts.
 */
export function useUploadUrl(path) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!path) {
      setUrl('');
      return undefined;
    }
    let objectUrl = '';
    let cancelled = false;
    const token = getToken();
    fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) throw new Error(`upload ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl('');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}
