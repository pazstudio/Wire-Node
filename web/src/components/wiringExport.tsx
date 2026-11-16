import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api';

interface WiringExportStatus {
  /** Last download of the wiring summary; null if it was never downloaded. */
  last: { exportedAt: string; exportedBy: string | null } | null;
  /** True when the summary would read differently than the last download. */
  changedSinceExport: boolean;
}

const statusKey = (projectId: string) => ['wiring-export', projectId];

/** Checks the status again shortly after any other data is reloaded (every edit reloads what it changed). */
function useRecheckAfterEdits(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.query.queryKey[0] === statusKey(projectId)[0]) return;
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: statusKey(projectId) }), 500);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [qc, projectId]);
}

function useWiringExportStatus(projectId: string) {
  return useQuery({
    queryKey: statusKey(projectId),
    queryFn: () => api.get<WiringExportStatus>(`/api/projects/${projectId}/wiring-export`),
    // Changes are made on other pages; check again whenever the project page is shown.
    refetchOnMount: 'always',
  }).data;
}

/** "Last exported 13 Nov 2026, 14:02 by Alice" (no name until there are user accounts). */
function exportedText(last: NonNullable<WiringExportStatus['last']>) {
  const when = new Date(last.exportedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `Last exported ${when}${last.exportedBy ? ` by ${last.exportedBy}` : ''}`;
}

/** "Wiring summary" download button; marked when the project changed since it was last exported. */
export function WiringSummaryButton({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const status = useWiringExportStatus(projectId);
  useRecheckAfterEdits(projectId);

  async function download() {
    setBusy(true);
    try {
      // Fetched rather than a plain link, so the export status updates as soon as the download is made.
      const res = await fetch(`/api/projects/${projectId}/wiring.md`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'wiring.md';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await qc.invalidateQueries({ queryKey: statusKey(projectId) });
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const changed = !!status?.changedSinceExport;
  const lines = ['Download a readable Markdown summary of every connector, pin and wire, e.g. to give to an AI assistant'];
  if (status) {
    if (!status.last) lines.push('Not exported yet.');
    else lines.push(`${changed ? 'Changes were made since the last export. ' : 'Up to date. '}${exportedText(status.last)}.`);
  }

  return (
    <button className="btn" onClick={download} disabled={busy} title={lines.join('\n\n')}>
      {busy ? 'Exporting…' : 'Wiring summary'}
      {changed && <span className="stale-dot" aria-label="changed since last export" />}
    </button>
  );
}

/** Notice shown while the project has changes that are not in the last exported wiring summary. */
export function WiringExportNotice({ projectId }: { projectId: string }) {
  const status = useWiringExportStatus(projectId);
  if (!status?.changedSinceExport || !status.last) return null;
  return (
    <p className="export-notice">
      <span aria-hidden>⚠</span>
      <span>
        Changes were made since the wiring summary was last exported. {exportedText(status.last)}.
      </span>
    </p>
  );
}
