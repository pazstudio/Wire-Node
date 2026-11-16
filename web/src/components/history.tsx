import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type ChangeEntry } from '../api';

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
};

const ICONS: Record<ChangeEntry['action'], string> = {
  create: '+',
  edit: '✎',
  delete: '🗑',
  lock: '🔒',
  unlock: '🔓',
  place: '+',
  remove: '−',
};

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
        {e.summary.length > COLLAPSED_LINES && (
          <button className="btn-link small" onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Show less' : `Show all ${e.summary.length} changes`}
          </button>
        )}
      </div>
    </li>
  );
}
