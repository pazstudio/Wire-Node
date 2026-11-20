import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type CheckTick, type ProjectWires } from './api';
import { useMe } from './auth';

/**
 * Build-checklist ticks that also work without a connection: each tick shows at once, and when
 * the server cannot be reached it is kept on this device and sent when the connection is back
 * (with the time it was made).
 */

export type Step = 'crimped' | 'tested';

export interface TickRequest {
  projectId: string;
  unitId: string;
  wireIds: string[];
  step: Step;
  done: boolean;
  ok?: boolean;
  note?: string;
  at: string;
}

const KEY = 'wn:check-queue';
const EVENT = 'wn:check-queue';

function readQueue(): TickRequest[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeQueue(q: TickRequest[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* storage blocked: the tick is only sent if the server answers now */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Worth sending again later: no answer (offline, proxy down), or signed out meanwhile. Other errors
 * are refusals (e.g. the wire was deleted).
 */
const isRetryable = (e: unknown) => !(e instanceof ApiError) || e.status >= 502 || [401, 408, 429].includes(e.status);

const send = (r: TickRequest) =>
  api.put<ProjectWires>(`/api/projects/${r.projectId}/wire-checks`, {
    wireIds: r.wireIds,
    step: r.step,
    done: r.done,
    unitId: r.unitId,
    ok: r.ok ?? true,
    note: r.note ?? '',
    at: r.at,
  });

let flushing: Promise<number> | null = null;
/** Told about every tick the server accepted, with the wires as they are now (to show without a reload). */
const sentListeners = new Set<(r: TickRequest, res: ProjectWires) => void>();

/** Sends queued ticks in order; stops at the first network failure. Resolves to how many are left. */
export function flushQueue(): Promise<number> {
  if (!flushing) {
    flushing = (async () => {
      let q = readQueue();
      while (q.length) {
        try {
          const res = await send(q[0]);
          for (const l of sentListeners) l(q[0], res);
        } catch (e) {
          if (isRetryable(e)) break;
          // Refused by the server (e.g. the wire was deleted): drop it rather than block the rest.
          console.warn('Checklist tick refused', e);
        }
        q = readQueue().slice(1);
        writeQueue(q);
      }
      return q.length;
    })().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

/** Number of ticks waiting on this device to be sent. */
export function usePendingTicks() {
  const [n, setN] = useState(() => readQueue().length);
  useEffect(() => {
    const update = () => setN(readQueue().length);
    const online = () => void flushQueue().then(update);
    window.addEventListener(EVENT, update);
    window.addEventListener('online', online);
    window.addEventListener('storage', update);
    void flushQueue().then(update);
    // Also retry now and then: "online" does not fire when only the server was unreachable.
    const timer = setInterval(() => readQueue().length && void flushQueue().then(update), 30_000);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('online', online);
      window.removeEventListener('storage', update);
      clearInterval(timer);
    };
  }, []);
  return n;
}

export const wiresKey = (projectId: string, unitId: string) => ['project-wires', projectId, unitId];

/** Applies queued ticks over server data, so they show before they are sent. */
function withPending(data: ProjectWires, projectId: string, me: string): ProjectWires {
  const q = readQueue().filter((r) => r.projectId === projectId && r.unitId === data.unitId);
  if (!q.length) return data;
  const wires = data.wires.map((w) => {
    let next = w;
    for (const r of q) {
      if (!r.wireIds.includes(w.id)) continue;
      const tick: CheckTick | null = r.done
        ? { doneAt: r.at, doneBy: me, stale: false, ok: r.step === 'crimped' ? true : (r.ok ?? true), note: r.note ?? '', pending: true }
        : null;
      next = { ...next, [r.step]: tick };
    }
    return next;
  });
  return { ...data, wires };
}

/** The project's wires with the ticks of one unit ("" = the project), and a function to tick them. */
export function useWireChecks(projectId: string, unitId: string) {
  const qc = useQueryClient();
  const me = useMe().name;
  const pending = usePendingTicks();
  const q = useQuery({
    queryKey: wiresKey(projectId, unitId),
    queryFn: () => api.get<ProjectWires>(`/api/projects/${projectId}/wires${unitId ? `?unit=${unitId}` : ''}`),
    refetchOnMount: 'always',
  });
  // Recomputed when the queue changes (`pending`), so queued ticks show until they are sent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => (q.data ? withPending(q.data, projectId, me) : undefined), [q.data, projectId, me, pending]);

  useEffect(() => {
    const l = (r: TickRequest, res: ProjectWires) => {
      if (r.projectId === projectId && r.unitId === unitId) qc.setQueryData(wiresKey(projectId, unitId), res);
    };
    sentListeners.add(l);
    return () => void sentListeners.delete(l);
  }, [projectId, unitId, qc]);

  const tick = useCallback(
    async (wireIds: string[], step: Step, done: boolean, opts: { ok?: boolean; note?: string } = {}) => {
      if (!wireIds.length) return;
      const req: TickRequest = { projectId, unitId, wireIds, step, done, ...opts, at: new Date().toISOString() };
      // Queue first: the tick shows at once, and survives a lost connection or a closed tab.
      writeQueue([...readQueue(), req]);
      const left = await flushQueue();
      if (!left) {
        void qc.invalidateQueries({ queryKey: ['build-status', projectId] });
        void qc.invalidateQueries({ queryKey: ['units', projectId] });
      }
    },
    [projectId, unitId, qc],
  );

  return { data, error: q.error, tick, pending };
}
