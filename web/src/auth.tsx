import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, errorMessage, SIGNED_OUT_EVENT, type Me, type Permission } from './api';
import { ErrorText, Modal } from './components/ui';

/**
 * Accounts. Every page needs a signed-in user; there is no registration (accounts are made by an
 * admin). The server enforces every permission; the hooks here only hide what a user cannot do.
 */

const MeContext = createContext<Me | null>(null);

/** /api/auth/me without the global "signed out" handling (it is how that state is found out). */
async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return ((await res.json()) as { user: Me }).user;
}

/**
 * After signing in or out: drops everything cached for the previous account and shows the new one.
 * The "me" query itself must stay in the cache (qc.clear() would detach AuthGate from it, and the
 * page would keep showing the sign-in form until reloaded), so only its data is replaced.
 */
function switchAccount(qc: QueryClient, user: Me | null) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  qc.setQueryData(['me'], user);
}

export function useMeQuery() {
  return useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000, retry: 1 });
}

/** The signed-in user (always set inside AuthGate). */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside AuthGate');
  return me;
}

export function can(me: Me, permission: Permission) {
  return me.isAdmin || me.permissions.includes(permission);
}

export function useCan(permission: Permission) {
  return can(useMe(), permission);
}

/** Shows the sign-in page (or the forced password change) until there is a usable account. */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useMeQuery();

  useEffect(() => {
    const onSignedOut = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [qc]);

  if (q.isPending) return <p className="page muted">Loading…</p>;
  if (q.error) return <p className="page error">Cannot reach the server: {errorMessage(q.error)}</p>;
  const me = q.data;
  if (!me) return <SignInPage />;
  if (me.mustChangePassword) return <ForcedPasswordChange me={me} />;
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" /> Wire-Node
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function SignInPage() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: Me }>('/api/auth/login', { username, password });
      switchAccount(qc, user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in">
      <form className="form" onSubmit={submit}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <ErrorText error={error} />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="small muted">No account? Ask your Wire-Node admin to create one.</p>
      </form>
    </AuthCard>
  );
}

function ForcedPasswordChange({ me }: { me: Me }) {
  const qc = useQueryClient();
  return (
    <AuthCard title="Choose a new password">
      <p className="small muted">
        {me.username === 'admin'
          ? 'This is the first sign-in with the default admin account. Choose a safe password before continuing; your projects are not affected.'
          : 'Your password was set by an admin. Choose your own password before continuing.'}
      </p>
      <PasswordForm
        onDone={() => qc.invalidateQueries({ queryKey: ['me'] })}
        submitLabel="Save and continue"
        footer={<SignOutButton className="btn" />}
      />
    </AuthCard>
  );
}

function PasswordForm({ onDone, submitLabel, footer }: { onDone: () => void; submitLabel: string; footer?: ReactNode }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) {
      setError('The new passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>
        Current password
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
      </label>
      <label>
        New password
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        <span className="hint">At least 8 characters.</span>
      </label>
      <label>
        Repeat new password
        <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
      </label>
      <ErrorText error={error} />
      <div className="form-actions">
        {footer}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function SignOutButton({ className }: { className: string }) {
  const qc = useQueryClient();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await api.post('/api/auth/logout', {});
        } finally {
          switchAccount(qc, null);
        }
      }}
    >
      Sign out
    </button>
  );
}

/** Name of the signed-in user in the top bar, with password change, admin panel and sign-out. */
export function UserMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const admin = can(me, 'users.manage') || can(me, 'backups.manage');

  useEffect(() => setOpen(false), [location.key]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button className="project-menu-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="user-avatar" aria-hidden>
          {me.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="project-menu-name user-menu-name">{me.name}</span>
        <span aria-hidden className="project-menu-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="project-menu-pop user-menu-pop" role="menu">
          <div className="user-menu-head">
            <strong>{me.name}</strong>
            <span className="small muted">
              {me.username} · {me.groupName}
            </span>
          </div>
          {admin && (
            <Link to="/admin" className="menu-item" role="menuitem">
              <span className="qs-icon" aria-hidden>
                ⚙
              </span>
              Admin panel
            </Link>
          )}
          <button className="menu-item menu-item-btn" role="menuitem" onClick={() => (setOpen(false), setChanging(true))}>
            <span className="qs-icon" aria-hidden>
              🔑
            </span>
            Change password
          </button>
          <SignOutButton className="menu-item menu-item-btn" />
        </div>
      )}
      {changing && (
        <Modal title="Change password" onClose={() => setChanging(false)}>
          <p className="small muted">Your other browsers and devices are signed out.</p>
          <PasswordForm onDone={() => setChanging(false)} submitLabel="Change password" />
        </Modal>
      )}
    </div>
  );
}
