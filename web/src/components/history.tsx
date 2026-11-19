import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type ChangeEntry } from '../api';
import { useCan } from '../auth';
import { useAskReason } from './reason';

/** "Recent changes": who changed what and why, newest first. */

export interface HistoryFilter {
  entityType?: ChangeEntry['entityType'];
  entityId?: string;
  projectId?: string;
}

const VERBS: Record<ChangeEntry['action'], string> = {
  create: 'created',
  edit: 'edited',
  delete: 'deleted',
  lock: 'locked',
  unlock: 'unlocked',
  place: 'placed',
  remove: 'removed',
  revert: 'reverted',
};

const ICONS: Record<ChangeEntry['action'], string> = {
  create: '+',
  edit: '✎',
  delete: '🗑',
  lock: '🔒',
  unlock: '🔓',
  place: '+',
  remove: '−',
  revert: '↶',
};

const REVERTED_EVENT = 'wn:reverted';

/**
 * Counts reverts of an item while its page is open. Pages that copy the item into local state
 * (component editor, wiring diagram) use it in their key, so they start over from the reverted data.
 */
export function useRevertCount(entityId: string) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const on = (ev: Event) => (ev as CustomEvent<string>).detail === entityId && setCount((c) => c + 1);
    window.addEventListener(REVERTED_EVENT, on);
    return () => window.removeEventListener(REVERTED_EVENT, on);
  }, [entityId]);
  return count;
}

export function historyKey(filter: HistoryFilter) {
  return ['history', filter.entityType ?? '', filter.entityId ?? '', filter.projectId ?? ''];
}

function relativeTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function entityLink(e: ChangeEntry, projectId?: string) {
  if (e.action === 'delete') return null;
  const pid = e.projectId ?? projectId;
  if (e.entityType === 'project') return `/projects/${e.entityId}`;
  if (!pid) return null;
  if (e.entityType === 'connection') return `/projects/${pid}/connections/${e.entityId}`;
  return `/projects/${pid}/pcbs/${e.entityId}`;
}

export function HistoryList({
  filter,
  showEntity = false,
  projectId,
  empty = 'No changes recorded yet.',
}: {
  filter: HistoryFilter;
  /** Show which item each entry is about (project and admin lists). */
  showEntity?: boolean;
  /** Project to link components to, when the entry has none (library components). */
  projectId?: string;
  empty?: string;
}) {
  const q = useInfiniteQuery({
    queryKey: historyKey(filter),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
      if (pageParam) params.set('before', pageParam);
      return api.get<{ items: ChangeEntry[]; nextBefore: string | null }>(`/api/changes?${params}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 0,
  });

  if (q.isPending) return <p className="muted small">Loading history…</p>;
  if (q.error) return <p className="error small">Could not load the history: {String(q.error)}</p>;
  const items = q.data.pages.flatMap((p) => p.items);
  if (!items.length) return <p className="muted small">{empty}</p>;

  return (
    <div>
      <ol className="history">
        {items.map((e) => (
          <HistoryItem key={e.id} entry={e} showEntity={showEntity} projectId={projectId} />
        ))}
      </ol>
      {q.hasNextPage && (
        <button className="btn btn-sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Show older changes'}
        </button>
      )}
    </div>
  );
}

const COLLAPSED_LINES = 6;

function HistoryItem({ entry: e, showEntity, projectId }: { entry: ChangeEntry; showEntity: boolean; projectId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const canRevert = useCan('history.revert');
  const link = entityLink(e, projectId);
  const lines = expanded ? e.summary : e.summary.slice(0, COLLAPSED_LINES);
  const name = <strong>{e.entityName}</strong>;
  return (
    <li className={`history-item history-${e.action}`}>
      <span className="history-icon" aria-hidden>
        {ICONS[e.action]}
      </span>
      <div className="history-body">
        <div className="history-head">
          <span>
            <strong>{e.userName}</strong> {VERBS[e.action]}
            {showEntity && (
              <>
                {' '}
                {e.entityType} {link ? <Link to={link}>{name}</Link> : name}
              </>
            )}
          </span>
          <time className="small muted" dateTime={e.updatedAt} title={new Date(e.updatedAt).toLocaleString()}>
            {relativeTime(e.updatedAt)}
          </time>
        </div>
        {e.reason ? <p className="history-reason">“{e.reason}”</p> : null}
        {lines.length > 0 && (
          <ul className="history-summary small">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        <div className="history-actions">
          {e.summary.length > COLLAPSED_LINES && (
            <button className="btn-link small" onClick={() => setExpanded((x) => !x)}>
              {expanded ? 'Show less' : `Show all ${e.summary.length} changes`}
            </button>
          )}
          {e.revertable && canRevert && <RevertButton entry={e} />}
        </div>
      </div>
    </li>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** Puts the item back to how it was before the change (asks for a reason, warns about later changes). */
function RevertButton({ entry: e }: { entry: ChangeEntry }) {
  const qc = useQueryClient();
  const ask = useAskReason();
  const [busy, setBusy] = useState(false);

  async function revert() {
    setBusy(true);
    let preview: { later: { id: string; updatedAt: string; userName: string; action: string; reason: string }[]; notes: string[] };
    try {
      preview = await api.get(`/api/changes/${e.id}/revert`);
    } catch (err) {
      alert(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    await ask({
      title: `Revert ${e.entityType} "${e.entityName}"`,
      message: (
        <>
          <p>
            Puts the {e.entityType} back to how it was before this change by <strong>{e.userName}</strong> ({shortDate(e.createdAt)}
            {e.reason ? `: “${e.reason}”` : ''}). The revert is recorded in the history and can itself be reverted.
          </p>
          {preview.later.length > 0 && (
            <div className="revert-warning">
              <strong>These later changes are undone too:</strong>
              <ul className="small">
                {preview.later.map((l) => (
                  <li key={l.id}>
                    {shortDate(l.updatedAt)} · {l.userName} {VERBS[l.action as ChangeEntry['action']] ?? l.action}
                    {l.reason ? ` – “${l.reason}”` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.notes.length > 0 && (
            <ul className="small error">
              {preview.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      ),
      confirmLabel: 'Revert',
      danger: true,
      placeholder: 'e.g. Wrong pinout, going back to the tested wiring',
      action: async (reason) => {
        await api.post(`/api/changes/${e.id}/revert`, { reason });
        // The item, its diagram and every list showing it changed.
        await qc.invalidateQueries();
        window.dispatchEvent(new CustomEvent(REVERTED_EVENT, { detail: e.entityId }));
      },
    });
  }

  return (
    <button className="btn btn-sm" onClick={revert} disabled={busy} title="Put it back to how it was before this change">
      {busy ? 'Checking…' : '↶ Revert'}
    </button>
  );
}
