import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api';
import { ErrorText } from '../components/ui';

type Info = { projects: number; pcbs: number; connectorTypes: number; cables: number; connections: number };
type RestoreResult = {
  ok: true;
  exportedAt: string;
  counts: Record<string, number>;
  missingFiles: string[];
  /** Backup of the state before the restore, kept on the server. */
  safetyBackup: string | null;
};

interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  /** Also the last backup of each day, for this many days (0 = off). */
  keepDays: number;
}

/** Same rule as the server (backupRetention.ts): the newest `keep`, plus the newest of each of the last `keepDays` days. */
function backupsToKeep(files: { name: string }[], s: { keep: number; keepDays: number }) {
  const newestFirst = [...files].sort((a, b) => b.name.localeCompare(a.name));
  const keep = new Set(newestFirst.slice(0, s.keep).map((f) => f.name));
  const days = new Set<string>();
  for (const f of newestFirst) {
    if (days.size >= s.keepDays) break;
    const day = /-(\d{8})-\d{6}\.tar\.gz$/.exec(f.name)?.[1] ?? '';
    if (days.has(day)) continue;
    days.add(day);
    keep.add(f.name);
  }
  return keep;
}
interface BackupFile {
  name: string;
  kind: 'auto' | 'before-restore';
  size: number;
  createdAt: string;
}
interface BackupsState {
  settings: BackupSettings;
  files: BackupFile[];
  lastRun: { at: string; ok: boolean; file?: string; error?: string } | null;
  nextRunAt: string | null;
  running: boolean;
  dir: string;
}

const INTERVALS = [
  { hours: 1, label: 'Every hour' },
  { hours: 3, label: 'Every 3 hours' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Every day' },
  { hours: 48, label: 'Every 2 days' },
  { hours: 168, label: 'Every week' },
];

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatSpan(hours: number) {
  if (hours < 48) return `${hours} hours`;
  const days = hours / 24;
  return days < 60 ? `${Math.round(days)} days` : `${Math.round(days / 30)} months`;
}

/** Automatic backups: how often, how many are kept, and the backup files on the server. */
export function AutoBackupPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupsState>('/api/backups'), refetchInterval: 15_000 });
  const [draft, setDraft] = useState<BackupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<RestoreResult | null>(null);

  if (!q.data) return <div className="panel">{q.error ? <ErrorText error={errorMessage(q.error)} /> : <p className="muted small">Loading…</p>}</div>;
  const state = q.data;
  const s = draft ?? state.settings;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(state.settings);
  const custom = !INTERVALS.some((i) => i.hours === s.intervalHours);
  const refresh = () => qc.invalidateQueries({ queryKey: ['backups'] });

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const autos = state.files.filter((f) => f.kind === 'auto');
    const removing = autos.length - backupsToKeep(autos, s).size;
    if (removing > 0 && !confirm(`With these settings, ${removing} older automatic backup(s) are deleted now. Continue?`)) return;
    await run('save', async () => {
      await api.put('/api/backups/settings', s);
      setDraft(null);
    });
  }

  async function restore(f: BackupFile) {
    const ok = confirm(
      `Restore "${f.name}" (${new Date(f.createdAt).toLocaleString()})?\n\n` +
        'ALL current projects, components, pictures, cables, connectors, connections and history are replaced by this backup. ' +
        'The current state is saved as a "before restore" backup first, so it can be restored again.\n\nContinue?',
    );
    if (!ok) return;
    await run(`restore:${f.name}`, async () => {
      setRestored(await api.post<RestoreResult>(`/api/backups/${encodeURIComponent(f.name)}/restore`, {}));
      qc.invalidateQueries();
    });
  }

  const autoFiles = state.files.filter((f) => f.kind === 'auto');
  return (
    <div className="panel">
      <h3>Automatic backups</h3>
      <form className="form" onSubmit={save}>
        <label className="check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setDraft({ ...s, enabled: e.target.checked })} />
          Make backups automatically
        </label>
        <div className="form-row">
          <label>
            How often
            <select
              value={custom ? 'custom' : s.intervalHours}
              disabled={!s.enabled}
              onChange={(e) => setDraft({ ...s, intervalHours: e.target.value === 'custom' ? s.intervalHours : Number(e.target.value) })}
            >
              {INTERVALS.map((i) => (
                <option key={i.hours} value={i.hours}>
                  {i.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {custom && (
            <label>
              Hours between backups
              <input
                type="number"
                min={1}
                max={720}
                value={s.intervalHours}
                disabled={!s.enabled}
                onChange={(e) => setDraft({ ...s, intervalHours: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              />
            </label>
          )}
          <label>
            Newest backups to keep
            <input
              type="number"
              min={1}
              max={1000}
              value={s.keep}
              onChange={(e) => setDraft({ ...s, keep: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
            />
          </label>
          <label>
            Plus one per day, for days
            <input
              type="number"
              min={0}
              max={3650}
              value={s.keepDays}
              onChange={(e) => setDraft({ ...s, keepDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
          </label>
        </div>
        <p className="hint">
          {s.enabled
            ? `Keeps the newest ${s.keep} backups (about ${formatSpan(s.keep * s.intervalHours)} back)` +
              (s.keepDays > 0
                ? `, and also the last backup of each day for the last ${s.keepDays} days that have a backup.`
                : '.') +
              ' Older backups are deleted when a new one is made.'
            : 'No backups are made automatically. Stored backups stay until you delete them.'}
        </p>
        <ErrorText error={error} />
        <div className="btn-row">
          <button className="btn btn-primary" disabled={!dirty || !!busy}>
            {busy === 'save' ? 'Saving…' : 'Save settings'}
          </button>
          {dirty && (
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Undo
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!!busy || state.running}
            onClick={() => run('run', () => api.post('/api/backups/run', {}))}
          >
            {busy === 'run' || state.running ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
      </form>

      <p className="small muted backup-status">
        {state.lastRun ? (
          state.lastRun.ok ? (
            <>Last backup: {new Date(state.lastRun.at).toLocaleString()}. </>
          ) : (
            <span className="error">
              Last backup FAILED on {new Date(state.lastRun.at).toLocaleString()}: {state.lastRun.error}.{' '}
            </span>
          )
        ) : (
          <>No automatic backup yet. </>
        )}
        {state.nextRunAt && <>Next: {new Date(state.nextRunAt).toLocaleString()}. </>}
        Stored on the server in <code>{state.dir}</code>.
      </p>

      {restored && (
        <div className="restore-result">
          <strong>Restore complete.</strong> Backup made {new Date(restored.exportedAt).toLocaleString()}.
          {restored.safetyBackup && <> The previous state was saved as {restored.safetyBackup}.</>}
        </div>
      )}

      {state.files.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Backup</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.files.map((f) => (
                <tr key={f.name}>
                  <td>
                    {new Date(f.createdAt).toLocaleString()}{' '}
                    {f.kind === 'before-restore' && (
                      <span className="badge" title="Made automatically before a restore">
                        before restore
                      </span>
                    )}
                    <div className="small muted">{f.name}</div>
                  </td>
                  <td>{formatSize(f.size)}</td>
                  <td className="btn-row backup-actions">
                    <a className="btn btn-sm" href={`/api/backups/${encodeURIComponent(f.name)}/download`} download>
                      Download
                    </a>
                    <button className="btn btn-sm" disabled={!!busy} onClick={() => restore(f)}>
                      {busy === `restore:${f.name}` ? 'Restoring…' : 'Restore'}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={!!busy}
                      onClick={() =>
                        confirm(`Delete backup ${f.name}?`) &&
                        run(`del:${f.name}`, () => api.del(`/api/backups/${encodeURIComponent(f.name)}`))
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {autoFiles.length === 0 && <p className="muted small">No backups stored on the server yet.</p>}
    </div>
  );
}

export default function BackupPage() {
  return (
    <div className="page narrow">
      <div className="crumbs">
        <Link to="/">Projects</Link> / <span>Backup &amp; restore</span>
      </div>
      <h1>Backup &amp; restore</h1>
      <BackupPanels />
    </div>
  );
}

/** Automatic backups, download and restore (the Backups tab of the admin panel). */
export function BackupPanels() {
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
    <div>
      <p className="muted">
        A backup is one <code>.tar.gz</code> file with all data, pictures, change history and accounts. Use it to keep a copy,
        or to move Wire-Node to another server: download it here, start a fresh container on the new server, and restore it
        there. Backups contain password hashes, so keep them private.
      </p>

      <AutoBackupPanel />

      <div className="panel">
        <h3>Download backup</h3>
        {info && (
          <p className="small muted">
            This server has {info.projects} projects, {info.pcbs} components, {info.connectorTypes} connectors, {info.cables} cables and{' '}
            {info.connections} connections.
          </p>
        )}
        <p className="small muted">
          The backup also has a readable wiring summary of each project in the <code>wiring</code> folder. To get one
          project's summary on its own, use <strong>Wiring summary</strong> on the project page.
        </p>
        <a className="btn btn-primary" href="/api/backup" download>
          Download backup
        </a>
      </div>


      <div className="panel">
        <h3>Restore from a backup file</h3>
        <p className="small muted">
          Replaces <strong>all</strong> projects, library and history on this server with the contents of the backup file. The
          current state is saved as a "before restore" backup first. Accounts on this server are kept; accounts in the backup
          are added if their username is not taken.
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
              {result.counts.history != null && <li>{result.counts.history} history entries</li>}
              {!!result.counts.accountsAdded && <li>{result.counts.accountsAdded} accounts added</li>}
            </ul>
            {result.safetyBackup && (
              <p className="small muted">The previous state was saved as {result.safetyBackup} (see Automatic backups).</p>
            )}
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
