import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Folder } from '../api';
import { useAskReason } from './reason';
import { ErrorText, Modal } from './ui';

interface ImportSummary {
  rows: number;
  errors: string[];
  connections: { name: string; isNew: boolean; wires: number }[];
  applied: boolean;
}

/** Imports wires from a CSV file (one wire per row): a preview first, then the import. */
export function ImportWiresModal({ projectId, folders, onClose }: { projectId: string; folders: Folder[]; onClose: () => void }) {
  const qc = useQueryClient();
  const ask = useAskReason();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [folderId, setFolderId] = useState('');
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(text: string) {
    setCsv(text);
    setError(null);
    setPreview(null);
    if (!text.trim()) return;
    setBusy(true);
    try {
      setPreview(await api.post<ImportSummary>(`/api/projects/${projectId}/import-wires`, { csv: text }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    const wires = preview.connections.reduce((s, c) => s + c.wires, 0);
    await ask({
      title: 'Import wires',
      message: `Add ${wires} wire(s) in ${preview.connections.length} connection(s). Each connection's history gets an entry with this reason, so it can be reverted.`,
      confirmLabel: 'Import',
      initial: fileName ? `Imported from ${fileName}` : 'Imported from a CSV file',
      action: async (reason) => {
        await api.post(`/api/projects/${projectId}/import-wires`, { csv, apply: true, reason, folderId: folderId || null });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['connections', projectId] }),
          qc.invalidateQueries({ queryKey: ['map', projectId] }),
        ]);
        onClose();
      },
    });
  }

  const total = preview?.connections.reduce((s, c) => s + c.wires, 0) ?? 0;
  return (
    <Modal title="Import wires from CSV" onClose={onClose} wide>
      <p className="small">
        One wire per row with the columns <code>Connection, From component, From connector, From pin, To component, To
        connector, To pin</code> and optionally <code>Color, Gauge, Length, Note</code>. Components are matched by their
        name in this project, connectors by label (e.g. J3) or name, pins by number or pin name. Leave the component empty
        for an inline connector or splice. Wires already in a connection are skipped.{' '}
        <a href="/api/import-wires/template.csv">Download a template</a>.
      </p>
      <div className="form">
        <label>
          CSV file (comma, semicolon or tab separated)
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              await load(await f.text());
            }}
          />
        </label>
        <details>
          <summary className="small">…or paste the rows</summary>
          <textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} onBlur={() => load(csv)} className="mono" />
        </details>
        {folders.length > 0 && (
          <label>
            Folder for new connections
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">— none —</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorText error={error} />
      {busy && <p className="muted small">Reading…</p>}
      {preview && (
        <div className="mt">
          {preview.errors.length > 0 && (
            <div className="import-errors">
              <strong>
                {preview.errors.length} row{preview.errors.length > 1 ? 's' : ''} cannot be imported. Fix them in the file
                and pick it again:
              </strong>
              <ul className="small">
                {preview.errors.slice(0, 30).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {preview.errors.length > 30 && <li>… and {preview.errors.length - 30} more</li>}
              </ul>
            </div>
          )}
          {preview.connections.length === 0 ? (
            <p className="muted">Nothing new to import ({preview.rows} rows read).</p>
          ) : (
            <table className="table small">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th />
                  <th className="right">New wires</th>
                </tr>
              </thead>
              <tbody>
                {preview.connections.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.isNew ? <span className="badge diff-badge-added">new</span> : <span className="badge">add to existing</span>}</td>
                    <td className="right">{c.wires}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!preview || !total || preview.errors.length > 0 || busy} onClick={apply}>
          Import {total ? `${total} wire${total > 1 ? 's' : ''}` : ''}
        </button>
      </div>
    </Modal>
  );
}
