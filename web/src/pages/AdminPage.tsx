import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Permission } from '../api';
import { can, useMe } from '../auth';
import { ErrorText, Loading, Modal } from '../components/ui';
import { HistoryList } from '../components/history';
import { NotifySettingsPanel } from '../components/notifySettings';
import { BackupPanels } from './BackupPage';

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  groupId: string;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Overrides the group's "no reason" setting; null = as the group. */
  skipReason: boolean | null;
  group: { id: string; name: string; isAdmin: boolean; permissions: Permission[] };
}

/** Not a power, so the admin group does not have it automatically (see SKIP_REASON on the server). */
const SKIP_REASON: Permission = 'changes.skipReason';

interface Group {
  id: string;
  name: string;
  description: string;
  isAdmin: boolean;
  permissions: Permission[];
  _count: { users: number };
}

type PermissionLabels = Record<Permission, string>;

const useUsers = () => useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<AdminUser[]>('/api/admin/users') });
const useGroups = () => useQuery({ queryKey: ['admin', 'groups'], queryFn: () => api.get<Group[]>('/api/admin/groups') });
const usePermissionLabels = () =>
  useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api.get<PermissionLabels>('/api/admin/permissions'), staleTime: Infinity });

/** A random temporary password (the user changes it at the first sign-in). */
function temporaryPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => chars[x % chars.length]).join('');
}

export default function AdminPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(can(me, 'users.manage')
      ? [
          { key: 'users', label: 'Users' },
          { key: 'groups', label: 'Groups & permissions' },
          { key: 'activity', label: 'Activity' },
          { key: 'notify', label: 'Notifications' },
        ]
      : []),
    ...(can(me, 'backups.manage') ? [{ key: 'backups', label: 'Backups' }] : []),
  ];
  if (!tabs.length) return <Navigate to="/" replace />;
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0].key;

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/">Projects</Link> / <span>Admin</span>
      </div>
      <div className="page-head">
        <h1>Admin panel</h1>
      </div>
      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setParams({ tab: t.key }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'users' && <UsersTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'activity' && (
        <div className="panel">
          <h3>All changes</h3>
          <HistoryList filter={{}} showEntity />
        </div>
      )}
      {tab === 'notify' && <NotifySettingsPanel />}
      {tab === 'backups' && (
        <div className="admin-narrow">
          <BackupPanels />
        </div>
      )}
    </div>
  );
}

// ---------- Users ----------

function UsersTab() {
  const me = useMe();
  const users = useUsers();
  const groups = useGroups();
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);

  if (!users.data || !groups.data) return <Loading error={users.error || groups.error} />;
  return (
    <>
      <div className="panel-head admin-head">
        <p className="muted small">
          There is no sign-up: accounts are made here. A new account signs in with the temporary password you give it, then
          chooses its own.
        </p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New user
        </button>
      </div>
      <div className="table-wrap">
        <table className="table clickable">
          <thead>
            <tr>
              <th>User</th>
              <th>Group</th>
              <th>Status</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} onClick={() => setEditing(u)}>
                <td>
                  <strong>{u.displayName || u.username}</strong>
                  {u.id === me.id && <span className="badge">you</span>}
                  <div className="small muted">{u.username}</div>
                </td>
                <td>{u.group.name}</td>
                <td>
                  {u.disabled ? (
                    <span className="badge badge-locked">Disabled</span>
                  ) : u.mustChangePassword ? (
                    <span className="badge" title="Has to choose a new password at the next sign-in">
                      New password pending
                    </span>
                  ) : (
                    <span className="small">Active</span>
                  )}
                </td>
                <td className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === 'new' ? undefined : editing} groups={groups.data} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserForm({ user, groups, onClose }: { user?: AdminUser; groups: Group[]; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [groupId, setGroupId] = useState(user?.groupId ?? groups.find((g) => !g.isAdmin && g.name === 'Member')?.id ?? groups[0]?.id ?? '');
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [skipReason, setSkipReason] = useState<boolean | null>(user?.skipReason ?? null);
  const groupSkips = !!groups.find((g) => g.id === groupId)?.permissions.includes(SKIP_REASON);
  const [password, setPassword] = useState(user ? '' : temporaryPassword());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const self = user?.id === me.id;

  const done = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['me'] });
    onClose();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api.patch(`/api/admin/users/${user.id}`, {
          displayName,
          groupId,
          disabled,
          skipReason,
          ...(password ? { password } : {}),
        });
      } else {
        await api.post('/api/admin/users', { username, displayName, groupId, skipReason, password });
      }
      done();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!user || !confirm(`Delete the account "${user.username}"? Their changes stay in the history under their name.`)) return;
    try {
      await api.del(`/api/admin/users/${user.id}`);
      done();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal title={user ? `Edit ${user.username}` : 'New user'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={!!user}
            required
            autoFocus={!user}
            placeholder="e.g. jnovak"
            autoComplete="off"
          />
          {!user && <span className="hint">Used to sign in. Letters, digits, dot, dash and underscore.</span>}
        </label>
        <label>
          Name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Jan Novák" autoFocus={!!user} />
          <span className="hint">Shown in the history.</span>
        </label>
        <label>
          Group
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason for changes
          <select
            value={skipReason === null ? 'group' : skipReason ? 'skip' : 'ask'}
            onChange={(e) => setSkipReason(e.target.value === 'group' ? null : e.target.value === 'skip')}
          >
            <option value="group">As the group ({groupSkips ? 'not asked' : 'asked'})</option>
            <option value="ask">Always asked</option>
            <option value="skip">Never asked</option>
          </select>
          <span className="hint">
            When not asked, edits are saved straight away and recorded in the history without a reason. Deleting and
            locking are still confirmed, with the reason optional.
          </span>
        </label>
        <label>
          {user ? 'New temporary password (optional)' : 'Temporary password'}
          <span className="input-with-btn">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!user}
              minLength={8}
              autoComplete="new-password"
              placeholder={user ? 'Leave empty to keep the password' : ''}
            />
            <button type="button" className="btn btn-sm" onClick={() => setPassword(temporaryPassword())}>
              Generate
            </button>
          </span>
          <span className="hint">
            Give it to the user. They have to choose their own password at the next sign-in
            {user ? ', and are signed out everywhere now' : ''}.
          </span>
        </label>
        {user && !self && (
          <label className="check">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            Disabled (cannot sign in)
          </label>
        )}
        <ErrorText error={error} />
        <div className="form-actions">
          {user && !self && (
            <button type="button" className="btn btn-danger form-actions-left" onClick={remove}>
              Delete account
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : user ? 'Save' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Groups ----------

function GroupsTab() {
  const qc = useQueryClient();
  const groups = useGroups();
  const labels = usePermissionLabels();
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!groups.data || !labels.data) return <Loading error={groups.error || labels.error} />;
  const perms = Object.keys(labels.data) as Permission[];

  async function toggle(g: Group, p: Permission, on: boolean) {
    setError(null);
    const permissions = on ? [...g.permissions, p] : g.permissions.filter((x) => x !== p);
    qc.setQueryData<Group[]>(['admin', 'groups'], (list) => list?.map((x) => (x.id === g.id ? { ...x, permissions } : x)));
    try {
      await api.put(`/api/admin/groups/${g.id}`, { name: g.name, description: g.description, permissions });
    } catch (e) {
      setError(errorMessage(e));
    }
    qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <>
      <div className="panel-head admin-head">
        <p className="muted small">
          Every user is in one group; the group decides what they may do. Everyone signed in can view projects and their
          history. Changes take effect immediately. "Without a reason" can also be set per user (Users tab).
        </p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New group
        </button>
      </div>
      <ErrorText error={error} />
      <div className="table-wrap">
        <table className="table perm-matrix">
          <thead>
            <tr>
              <th>Permission</th>
              {groups.data.map((g) => (
                <th key={g.id} className="perm-col">
                  <button className="btn-link" onClick={() => setEditing(g)} title={g.description || 'Edit group'}>
                    {g.name}
                  </button>
                  <div className="small muted">{g._count.users} user(s)</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p}>
                <td>{labels.data[p]}</td>
                {groups.data.map((g) => {
                  const fixed = g.isAdmin && p !== SKIP_REASON;
                  return (
                    <td key={g.id} className="perm-col">
                      <input
                        type="checkbox"
                        aria-label={`${g.name}: ${labels.data[p]}`}
                        checked={fixed || g.permissions.includes(p)}
                        disabled={fixed}
                        title={fixed ? 'The admin group can always do everything' : undefined}
                        onChange={(e) => toggle(g, p, e.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <GroupForm group={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function GroupForm({ group, onClose }: { group?: Group; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    onClose();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (group) await api.put(`/api/admin/groups/${group.id}`, { name, description, permissions: group.permissions });
      else await api.post('/api/admin/groups', { name, description, permissions: [] });
      done();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!group || !confirm(`Delete the group "${group.name}"?`)) return;
    try {
      await api.del(`/api/admin/groups/${group.id}`);
      done();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal title={group ? `Edit group "${group.name}"` : 'New group'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. Viewer" />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who is in this group" />
        </label>
        {!group && <p className="hint">A new group can only view. Tick its permissions in the table afterwards.</p>}
        {group?.isAdmin && <p className="hint">The admin group always has every permission and cannot be deleted.</p>}
        <ErrorText error={error} />
        <div className="form-actions">
          {group && !group.isAdmin && (
            <button type="button" className="btn btn-danger form-actions-left" onClick={remove}>
              Delete group
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : group ? 'Save' : 'Create group'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
