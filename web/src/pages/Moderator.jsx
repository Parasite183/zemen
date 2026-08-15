import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle, RefreshCw, Network, Fingerprint, Zap, FileText, GitBranch } from 'lucide-react';
import { api, useUploadUrl } from '../api.js';
import { useAuth } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Card, Spinner, Empty, StatusChip, Button, VerifiedBadge } from '../components/ui.jsx';
import { money, timeAgo, maskPhone } from '../lib.js';

// Short human signal for each flag code, so review is fast and explainable.
const FLAG_SIGNAL = {
  one_sided_concentration: 'concentration',
  frequent_disputes: 'disputes',
  closed_loop_clique: 'clique',
  hub_spoke_pattern: 'hub-spoke',
  broad_shallow_network: 'shallow network',
  velocity_suspicious: 'velocity',
  device_cluster: 'device cluster',
  ip_cluster: 'IP cluster',
};

const DOC_TYPE = {
  national_id: 'National ID',
  business_license: 'Business license',
};

// Uploads are access-gated (owner/staff only) — a raw <img src> can't
// send the auth header and 401s. Fetch the file with the token and show
// it as a blob URL instead. Files the browser can't preview inline
// (PDF, HEIC/HEIF iPhone photos) get an expandable open-link; images
// get a thumbnail. PDFs preview inline in the card (same tab).
function DocThumb({ path, name }) {
  const url = useUploadUrl(path);
  const [open, setOpen] = useState(false);
  if (!path) return null;
  const isPdf = /pdf$/i.test(path);
  const isHeic = /heic|heif$/i.test(path);
  if (!url) return <div className="mt-2 h-24 w-32 animate-pulse rounded-lg bg-paper" />;
  if (isPdf || isHeic) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-soft/40"
        >
          <FileText size={13} /> {isPdf ? (open ? 'Hide PDF' : 'Open PDF') : 'Open image'}
        </button>
        {open && (
          isPdf ? (
            <iframe src={url} title={`${name} document`} className="mt-2 h-96 w-full rounded-lg border border-line bg-paper" />
          ) : (
            <a href={url} target="_blank" rel="noreferrer" className="mt-2 block">
              <img src={url} alt={`${name} document`} className="max-h-36 rounded-lg border border-line bg-paper object-contain" />
            </a>
          )
        )}
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mt-2 block">
      <img src={url} alt={`${name} document`} className="max-h-36 rounded-lg border border-line bg-paper object-contain" />
    </a>
  );
}

// Clickable chips for the accounts that make up a cluster.
function MemberChips({ members }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {members.map((m) => (
        <Link key={m.id} to={`/u/${m.id}`} className="rounded-full bg-warn/10 px-2.5 py-1 text-[11px] font-semibold text-warn hover:bg-warn/20">
          {m.name}
        </Link>
      ))}
    </div>
  );
}

export default function Moderator() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [queue, setQueue] = useState(null);
  const [review, setReview] = useState(null);
  const [roles, setRoles] = useState({ roles: [], audit: [] });
  const [roleSearch, setRoleSearch] = useState('');
  const [roleResults, setRoleResults] = useState([]);
  const [roleReason, setRoleReason] = useState('');
  const [roleBusy, setRoleBusy] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    return Promise.all([
      api('/api/disputes/modqueue').then(({ disputes }) => setQueue(disputes)),
      api('/api/mod/review').then(setReview),
    ]).catch((e) => setError(e.message));
  };

  // Role overview is staff-only (owners can additionally edit staff).
  const loadRoles = () => {
    if (!user?.is_staff) return;
    api('/api/mod/roles').then(setRoles).catch(() => {});
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { loadRoles(); }, [user?.is_staff]);

  // Role change: grant/revoke moderator (any staff) or staff (owner only).
  const changeRole = async (target, role, grant) => {
    const reason = roleReason.trim();
    if (!reason) {
      setError(t('mod.rolesReasonPh'));
      return;
    }
    setRoleBusy(`${target.id}:${role}:${grant}`);
    setError('');
    try {
      const res = await api('/api/mod/manage', { method: 'POST', body: { userId: target.id, role, grant, reason } });
      setRoles(res);
      setRoleReason('');
      setRoleResults([]);
      setRoleSearch('');
    } catch (e) {
      setError(e.message);
    } finally {
      setRoleBusy('');
    }
  };

  const searchUsers = async (e) => {
    e.preventDefault();
    const q = roleSearch.trim();
    if (!q) return;
    try {
      const res = await api(`/api/mod/search?q=${encodeURIComponent(q)}`);
      setRoleResults(res.users || []);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  const refreshFraud = async () => {
    setError('');
    try {
      await api('/api/mod/fraud/refresh', { method: 'POST' });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  // Staff decision on an identity document (approve → verified, reject → rejected).
  const decide = async (userId, status) => {
    setBusy(`${userId}:${status}`);
    setError('');
    try {
      await api('/api/me/verification', { method: 'POST', body: { userId, status } });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  if (error) return <Empty text={error} />;
  if (!queue || !review) return <Spinner />;

  const { documents, clusters, flaggedAccounts } = review;
  const clusterCount = clusters.cliques.length + clusters.hubSpokes.length + clusters.device.length + clusters.ip.length + clusters.velocity.length;
  const canDecide = !!user?.is_staff;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold tracking-tight">{t('mod.title')}</h1>

      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('dispute.queueTitle')} · {queue.length}</h2>
        {queue.length === 0 ? (
          <Card><Empty text={t('dispute.queueEmpty')} /></Card>
        ) : (
          <div className="space-y-2">
            {queue.map((d) => (
              <Link key={d.id} to={`/disputes/${d.id}`} className="card flex items-center justify-between gap-3 px-4 py-3 transition-all hover:border-brand">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{d.deal_description}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {d.party_a_name} ↔ {d.party_b_name} · {money(d.amount, d.currency)} · {timeAgo(d.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip statusKey="disputed" />
                  <ShieldCheck size={16} className="text-brand" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* identity document review queue */}
      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('mod.idReviews')} · {documents.length}</h2>
        {documents.length === 0 ? (
          <Card><Empty text={t('mod.idEmpty')} /></Card>
        ) : (
          <div className="space-y-2">
            {documents.map((d) => (
              <Card key={d.user_id} className="border-warn/40">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span className="flex items-center gap-1.5"><FileText size={14} className="text-warn" /> {d.name}</span>
                  <span className="text-xs font-medium text-ink-soft">{d.phone}</span>
                  <VerifiedBadge status={d.id_verification_status} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                  <span className="rounded bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink">{DOC_TYPE[d.doc_type] || d.doc_type}</span>
                  <span className="text-[11px] font-semibold text-warn">{d.doc_status === 'rejected' ? t('mod.docFlagged') : t('mod.docPending')}</span>
                  {d.doc_created_at && <span>· {timeAgo(d.doc_created_at)}</span>}
                </div>
                {d.doc_path ? (
                  <DocThumb path={d.doc_path} name={d.name} />
                ) : (
                  <p className="mt-2 rounded-lg bg-paper px-3 py-2 text-[11px] text-ink-soft">{t('mod.noImage')}</p>
                )}
                {(d.id_flag_reason || d.doc_reason) && (
                  <p className="mt-2 rounded-lg bg-bad-soft px-3 py-1.5 text-xs font-medium text-bad">
                    {d.id_flag_reason || d.doc_reason}
                  </p>
                )}
                {canDecide && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => decide(d.user_id, 'verified')} disabled={busy === `${d.user_id}:verified`}>
                      {busy === `${d.user_id}:verified` ? t('common.loading') : t('mod.approve')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => decide(d.user_id, 'rejected')} disabled={busy === `${d.user_id}:rejected`}>
                      {busy === `${d.user_id}:rejected` ? t('common.loading') : t('mod.reject')}
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* moderator & staff role management (staff can see, owner edits staff) */}
      {canDecide && (
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('mod.rolesTitle')} · {roles.roles.length}</h2>
          <Card>
            {/* find someone to promote */}
            <form onSubmit={searchUsers} className="flex gap-2">
              <input
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
                placeholder={t('mod.rolesSearchPh')}
                className="flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <Button type="submit" size="sm" variant="secondary">{t('mod.rolesSearch')}</Button>
            </form>
            <input
              value={roleReason}
              onChange={(e) => setRoleReason(e.target.value)}
              placeholder={t('mod.rolesReasonPh')}
              className="mt-2 w-full rounded-lg border border-line bg-paper px-3 py-2 text-xs outline-none focus:border-brand"
            />

            {roleResults.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {roleResults.map((u) => (
                  <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{u.name || '—'}</div>
                      <div className="text-xs text-ink-soft">{maskPhone(u.phone)} · {u.is_owner ? t('mod.roleOwner') : u.is_staff ? t('mod.roleStaff') : u.is_moderator ? t('mod.roleModerator') : ''}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" onClick={() => changeRole(u, 'moderator', true)} disabled={!!u.is_moderator || roleBusy === `${u.id}:moderator:true`}>
                        {t('mod.rolesPromote')}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => changeRole(u, 'moderator', false)} disabled={!u.is_moderator || roleBusy === `${u.id}:moderator:false`}>
                        {t('mod.rolesDemote')}
                      </Button>
                      {user?.is_owner && (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => changeRole(u, 'staff', true)} disabled={!!u.is_staff || roleBusy === `${u.id}:staff:true`}>
                            {t('mod.rolesMakeStaff')}
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => changeRole(u, 'staff', false)} disabled={!u.is_staff || roleBusy === `${u.id}:staff:false`}>
                            {t('mod.rolesRemoveStaff')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {roleSearch && roleResults.length === 0 && <p className="mt-3 text-xs text-ink-soft">{t('mod.rolesNone')}</p>}

            {/* current role holders */}
            <div className="mt-4 space-y-1.5">
              {roles.roles.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {u.name || '—'}
                      {u.id === user?.id && <span className="ml-1.5 text-xs font-medium text-brand">(you)</span>}
                    </div>
                    <div className="text-xs text-ink-soft">
                      {maskPhone(u.phone)} · {[u.is_owner && t('mod.roleOwner'), u.is_staff && t('mod.roleStaff'), u.is_moderator && t('mod.roleModerator')].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => changeRole(u, 'moderator', !u.is_moderator)} disabled={u.id === user?.id || u.is_owner || roleBusy === `${u.id}:moderator:${!u.is_moderator}`}>
                      {u.is_moderator ? t('mod.rolesDemote') : t('mod.rolesPromote')}
                    </Button>
                    {user?.is_owner && (
                      <Button size="sm" variant={u.is_staff ? 'danger' : 'secondary'} onClick={() => changeRole(u, 'staff', !u.is_staff)} disabled={u.id === user?.id || u.is_owner || roleBusy === `${u.id}:staff:${!u.is_staff}`}>
                        {u.is_staff ? t('mod.rolesRemoveStaff') : t('mod.rolesMakeStaff')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {roles.roles.length === 0 && <p className="text-xs text-ink-soft">{t('mod.rolesNone')}</p>}
            </div>

            {/* audit trail — every change is recorded */}
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-soft">{t('mod.rolesRecent')}</div>
              {roles.audit.length === 0 ? (
                <p className="text-xs text-ink-soft">{t('mod.rolesNoChanges')}</p>
              ) : (
                <ul className="space-y-1">
                  {roles.audit.slice(0, 10).map((a) => (
                    <li key={a.id} className="text-xs text-ink-soft">
                      {t(a.action.startsWith('grant') ? 'mod.roleGranted' : 'mod.roleRevoked', {
                        actor: a.actor_name,
                        target: a.target_name,
                        role: a.action.replace(/grant_|revoke_/, ''),
                      })}
                      {a.reason && <span className="text-ink-soft"> — “{a.reason}”</span>}
                      <span className="ml-1 text-[10px]">· {timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* fraud clusters */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-soft">{t('mod.clusters')} · {clusterCount}</h2>
          <Button size="sm" variant="secondary" onClick={refreshFraud}>
            <RefreshCw size={13} /> {t('mod.refresh')}
          </Button>
        </div>
        {clusterCount === 0 ? (
          <Card><Empty text={t('mod.noFlags')} /></Card>
        ) : (
          <div className="space-y-2">
            {clusters.cliques.map((g, i) => (
              <Card key={`clique-${i}`} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Network size={15} />
                  {t('mod.clique', { n: g.members.length, pct: Math.round(g.density * 100) })}
                </div>
                <MemberChips members={g.members} />
              </Card>
            ))}
            {clusters.hubSpokes.map((g, i) => (
              <Card key={`hub-${i}`} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <GitBranch size={15} />
                  {t('mod.hubSpoke', { hub: g.hub.name, n: g.members.length, pct: Math.round(g.hubShare * 100) })}
                </div>
                <MemberChips members={g.members} />
              </Card>
            ))}
            {clusters.device.map((c, i) => (
              <Card key={`dev-${i}`} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Fingerprint size={15} />
                  {t('mod.deviceCluster', { n: c.users.length })}
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-ink-soft">{c.key}</p>
                <MemberChips members={c.users} />
              </Card>
            ))}
            {clusters.ip.map((c, i) => (
              <Card key={`ip-${i}`} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Fingerprint size={15} />
                  {t('mod.ipCluster', { n: c.users.length })}
                </div>
                <p className="mt-1 font-mono text-[10px] text-ink-soft">{c.key}</p>
                <MemberChips members={c.users} />
              </Card>
            ))}
            {clusters.velocity.map((v, i) => (
              <Card key={`vel-${i}`} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Zap size={15} /> {v.user.name}
                </div>
                <p className="mt-1 text-xs text-ink-soft">{v.label}</p>
                <Link to={`/u/${v.user.id}`} className="mt-1 inline-block text-xs font-semibold text-brand hover:underline">{t('common.view')}</Link>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* remaining per-account flags (concentration, disputes, …) */}
      <div>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-soft">{t('mod.flagTitle')} · {flaggedAccounts.length}</h2>
        {flaggedAccounts.length === 0 ? (
          <Card><Empty text={t('mod.noFlags')} /></Card>
        ) : (
          <div className="space-y-2">
            {flaggedAccounts.map(({ user: u, flags }, i) => (
              <Card key={i} className="border-warn/40">
                <div className="flex items-center gap-2 text-sm font-bold text-warn">
                  <AlertTriangle size={15} /> {u.name} <span className="text-xs font-medium text-ink-soft">· {u.category}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {flags.map((f) => (
                    <div key={f.code} className="rounded-lg bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn">
                      <span className="mr-2 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                        {FLAG_SIGNAL[f.code] || f.code}
                      </span>
                      {f.label}
                    </div>
                  ))}
                </div>
                <Link to={`/u/${u.id}`} className="mt-2 inline-block text-xs font-semibold text-brand hover:underline">{t('common.view')}</Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
