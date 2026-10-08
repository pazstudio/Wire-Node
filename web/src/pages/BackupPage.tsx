import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorText } from '../components/ui';

type Info = { projects: number; pcbs: number; connectorTypes: number; cables: number; connections: number };
type RestoreResult = {
  ok: true;
  exportedAt: string;
  counts: Record<string, number>;
  missingFiles: string[];
};

export default function BackupPage() {
  const qc = useQueryClient();
  const infoQ = useQuery({ queryKey: ['backupInfo'], queryFn: () => api.get<Info>('/api/backup/info'), staleTime: 0 });
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'restoring' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const info = infoQ.data;
  const hasData = !!info && info.projects + info.pcbs + info.cables + info.connectorTypes > 0;

  function upload(replace: boolean) {
    if (!file) return;
    setError(null);
    setResult(null);
    setProgress(0);
    setPhase('uploading');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/restore${replace ? '?replace=true' : ''}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.upload.onload = () => setPhase('restoring');
    xhr.onerror = () => {
      setPhase('idle');
      setError('Network error while uploading the backup.');
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        setResult(body);
        setPhase('done');
        qc.invalidateQueries(); // everything changed
        return;
      }
      if (xhr.status === 409 && !replace) {
        setPhase('idle');
        if (confirm(`${body?.message ?? 'This server already has data.'}\n\nReplace everything with the backup?`)) upload(true);
        return;
      }
      setPhase('idle');
      setError(body?.message ?? `Restore failed (${xhr.status} ${xhr.statusText})`);
    };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  }

  function startRestore() {
    if (!file) return;
    if (hasData) {
      const ok = confirm(
        'This server already contains data.\n\n' +
          'Restoring will DELETE all current projects, components, pictures, cables, connectors and connections, ' +
          'and replace them with the backup. This cannot be undone.\n\n' +
          'Tip: download a backup of this server first.\n\nContinue?',
      );
      if (!ok) return;
    }
    upload(hasData);
  }

  const busy = phase === 'uploading' || phase === 'restoring';

  return (
    <div className="page narrow">
      <div className="crumbs">
        <Link to="/">Projects</Link> / <span>Backup &amp; restore</span>
      </div>
      <h1>Backup &amp; restore</h1>
      <p className="muted">
        A backup is one <code>.tar.gz</code> file with all data and pictures. Use it to keep a copy, or to move Wire-Node to
        another server: download it here, start a fresh container on the new server, and restore it there.
      </p>

      <div className="panel">
        <h3>Download backup</h3>
        {info && (
          <p className="small muted">
            This server has {info.projects} projects, {info.pcbs} components, {info.connectorTypes} connectors, {info.cables} cables and{' '}
            {info.connections} connections.
          </p>
        )}
        <a className="btn btn-primary" href="/api/backup" download>
          Download backup
        </a>
      </div>

      <div className="panel">
        <h3>Restore from backup</h3>
        <p className="small muted">
          Replaces <strong>all</strong> data on this server with the contents of the backup file.
        </p>
        <div className="form">
          <input
            type="file"
            accept=".gz,.tgz,application/gzip"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setError(null);
            }}
          />
          {busy && (
            <div>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round((phase === 'restoring' ? 1 : progress) * 100)}%` }} />
              </div>
              <p className="small muted">
                {phase === 'uploading' ? `Uploading… ${Math.round(progress * 100)}%` : 'Restoring data and pictures…'}
              </p>
            </div>
          )}
          <ErrorText error={error} />
          <div>
            <button className="btn btn-danger" disabled={!file || busy} onClick={startRestore}>
              Restore
            </button>
          </div>
        </div>
        {result && (
          <div className="restore-result">
            <p>
              <strong>Restore complete.</strong> Backup made {new Date(result.exportedAt).toLocaleString()}.
            </p>
            <ul className="small">
              <li>{result.counts.projects} projects</li>
              <li>{result.counts.pcbs} components with {result.counts.pcbConnectors} drawn connectors</li>
              <li>{result.counts.connectorTypes} connectors, {result.counts.cables} cables</li>
              <li>
                {result.counts.connections} connections with {result.counts.wires} wires
              </li>
              <li>{result.counts.zones} map zones</li>
            </ul>
            {result.missingFiles.length > 0 && (
              <p className="error small">
                {result.missingFiles.length} picture(s) were missing from the backup and will show as broken images.
              </p>
            )}
            <Link to="/" className="btn">
              Go to projects
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
