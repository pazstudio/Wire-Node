import { useEffect, useSyncExternalStore } from 'react';

/** A component or connection the user opened, remembered per project in this browser. */
export interface RecentEntry {
  kind: 'pcb' | 'connection';
  /** Library component id (pcb) or connection id. */
  id: string;
  name: string;
  at: number;
}

const KEY = 'wn-recents';
const MAX_PER_PROJECT = 12;
const EMPTY: RecentEntry[] = [];

type Store = Record<string, RecentEntry[]>;

let cache: Store | null = null;
const listeners = new Set<() => void>();

function load(): Store {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(next: Store) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: recents last for this tab only */
  }
  listeners.forEach((l) => l());
}

export function recordVisit(projectId: string, entry: Omit<RecentEntry, 'at'>) {
  const store = load();
  const list = (store[projectId] ?? []).filter((e) => !(e.kind === entry.kind && e.id === entry.id));
  save({ ...store, [projectId]: [{ ...entry, at: Date.now() }, ...list].slice(0, MAX_PER_PROJECT) });
}

export function forgetRecents(projectId: string) {
  const { [projectId]: _, ...rest } = load();
  save(rest);
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Keep several open tabs in sync.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** Most recent first. */
export function useRecents(projectId: string | undefined): RecentEntry[] {
  return useSyncExternalStore(subscribe, () => (projectId ? load()[projectId] ?? EMPTY : EMPTY));
}

/** Remembers the page as recently visited once it has loaded (entry not null). */
export function useRecordVisit(projectId: string, entry: Omit<RecentEntry, 'at'> | null) {
  const kind = entry?.kind;
  const id = entry?.id;
  const name = entry?.name;
  useEffect(() => {
    if (kind && id && name !== undefined) recordVisit(projectId, { kind, id, name });
  }, [projectId, kind, id, name]);
}
