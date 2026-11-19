import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { useMe } from '../auth';
import { ErrorText, Modal } from './ui';

/**
 * Every change to a connection or component needs a reason, which is kept in its history.
 * `useAskReason()` asks for one in a dialog; `useEditSession()` opens an editing session in which
 * all autosaves are recorded as one change with that reason.
 *
 * Users allowed to skip reasons (Me.skipReason) are not asked: the change goes ahead with an empty
 * reason. Dangerous or `confirm` requests still show the dialog, with the reason optional.
 */

export interface ReasonRequest {
  title: string;
  /** What is about to happen; shown above the reason field. */
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /**
   * Show the dialog even to users who skip reasons (AuthUser.skipReason), as a confirmation. Dangerous
   * requests always show it.
   */
  confirm?: boolean;
  placeholder?: string;
  initial?: string;
  /**
   * Runs the change with the reason. Errors are shown in the dialog, so the user can fix the reason
   * or cancel. The dialog closes when it succeeds.
   */
  action?: (reason: string) => Promise<unknown>;
}

type Ask = (req: ReasonRequest) => Promise<string | null>;

const AskContext = createContext<Ask | null>(null);

type Shown = ReasonRequest & { optional: boolean; error?: string };

export function ReasonProvider({ children }: { children: ReactNode }) {
  const skip = useMe().skipReason;
  const [req, setReq] = useState<Shown | null>(null);
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback<Ask>(
    async (r) => {
      let error: string | undefined;
      // Users who skip reasons go straight ahead; the dialog only comes up if the change fails.
      if (skip && !r.danger && !r.confirm) {
        try {
          await r.action?.('');
          return '';
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
      resolver.current?.(null);
      setReq({ ...r, optional: skip, error });
      return new Promise<string | null>((resolve) => {
        resolver.current = resolve;
      });
    },
    [skip],
  );

  const finish = (v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setReq(null);
  };

  return (
    <AskContext.Provider value={ask}>
      {children}
      {req && <ReasonDialog key={req.title} req={req} onDone={finish} />}
    </AskContext.Provider>
  );
}

/** Asks for the reason of a change; resolves to null when cancelled. */
export function useAskReason(): Ask {
  const ask = useContext(AskContext);
  if (!ask) throw new Error('useAskReason outside ReasonProvider');
  return ask;
}

function ReasonDialog({ req, onDone }: { req: Shown; onDone: (v: string | null) => void }) {
  const [reason, setReason] = useState(req.initial ?? '');
  const [error, setError] = useState<string | null>(req.error ?? null);
  const [busy, setBusy] = useState(false);
  const ok = req.optional || reason.trim().length >= 3;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    if (!req.action) return onDone(reason.trim());
    setBusy(true);
    setError(null);
    try {
      await req.action(reason.trim());
      onDone(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={req.title} onClose={() => onDone(null)}>
      <form className="form" onSubmit={submit}>
        {req.message && <div className="reason-message">{req.message}</div>}
        <label>
          Reason for this change{req.optional ? ' (optional)' : ''}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={req.optional ? 2 : 3}
            autoFocus
            maxLength={1000}
            placeholder={req.placeholder ?? 'e.g. Fan moved to the 24 V rail after the PSU upgrade'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }}
          />
          <span className="hint">Kept in the history together with your name, so others know why it changed.</span>
        </label>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!ok || busy}>
            {busy ? 'Working…' : (req.confirmLabel ?? 'Continue')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * An editing session for a connection or component. `start()` asks for the reason and opens the
 * session; pass `changeId` with every save (api.put(url, body, { changeId })).
 */
export function useEditSession(entityType: 'connection' | 'component', entityId: string, entityName: string) {
  const ask = useAskReason();
  const [session, setSession] = useState<{ id: string; reason: string } | null>(null);

  const skip = useMe().skipReason;
  const start = useCallback(async () => {
    let last = '';
    if (!skip) try {
      const r = await api.get<{ reason: string; at: string | null }>(
        `/api/changes/last-reason?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`,
      );
      // Offer the last reason only when it was given recently (e.g. the editor was reloaded).
      if (r.at && Date.now() - new Date(r.at).getTime() < 2 * 3600_000) last = r.reason;
    } catch {
      /* no suggestion */
    }
    let opened: { id: string; reason: string } | null = null;
    const reason = await ask({
      title: `Edit "${entityName}"`,
      message: <p className="small muted">What are you changing, and why? Everything you change until you leave the editor is saved as one change in the history.</p>,
      confirmLabel: 'Start editing',
      initial: last,
      action: async (why) => {
        opened = await api.post<{ id: string; reason: string }>('/api/changes/start', { entityType, entityId, reason: why });
      },
    });
    if (reason === null || !opened) return null;
    setSession(opened);
    return opened as { id: string; reason: string };
  }, [ask, skip, entityType, entityId, entityName]);

  return { changeId: session?.id ?? null, reason: session?.reason ?? null, start };
}
