import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, formatLength, parseLength, type ConnectionSummary } from '../../api';
import { ErrorText, Loading, Modal } from '../../components/ui';

export default function ConnectionsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const q = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => api.get<ConnectionSummary[]>(`/api/projects/${projectId}/connections`),
  });
  const [creating, setCreating] = useState(params.get('new') === '1');

  async function remove(c: ConnectionSummary) {
    if (!confirm(`Delete connection "${c.name}" and its ${c.wireCount} wire(s)?`)) return;
    try {
      await api.del(`/api/connections/${c.id}`);
      qc.invalidateQueries({ queryKey: ['connections', projectId] });
      qc.invalidateQueries({ queryKey: ['map', projectId] });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <section>
      <div className="section-head">
        <p className="muted small">
          A connection links connectors drawn on components. Add more than two connectors to build a harness with splits.
        </p>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + New connection
        </button>
      </div>
      {q.data.length === 0 ? (
        <p className="empty">No connections yet. Draw connectors on at least one component first, then create a connection.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Connectors</th>
                <th>Length</th>
                <th>Wires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id} onClick={() => navigate(`/projects/${projectId}/connections/${c.id}`)}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.description && <div className="small muted">{c.description}</div>}
                  </td>
                  <td>
                    <span className={`badge ${c.kind === 'harness' ? 'badge-harness' : ''}`}>{c.kind}</span>
                  </td>
                  <td className="small">{c.endpoints.join(' · ')}</td>
                  <td className="nowrap">{formatLength(c.lengthMm)}</td>
                  <td>{c.wireCount}</td>
                  <td className="right nowrap">
                    <Link
                      className="btn btn-sm"
                      to={`/projects/${projectId}/connections/${c.id}/edit`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Edit
                    </Link>{' '}
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(c);
                      }}
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
      {creating && (
        <NewConnectionModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ['connections', projectId] });
            navigate(`/projects/${projectId}/connections/${id}/edit`);
          }}
        />
      )}
    </section>
  );
}

function NewConnectionModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [length, setLength] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.post<{ id: string }>(`/api/projects/${projectId}/connections`, {
        name,
        description,
        lengthMm: parseLength(length),
      });
      onCreated(c.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New connection" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. Mainboard → Toolhead" />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </label>
        <label>
          Cable length (mm, optional)
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={length}
            onChange={(e) => setLength(e.target.value)}
            placeholder="e.g. 450"
          />
        </label>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Create &amp; open wizard
          </button>
        </div>
      </form>
    </Modal>
  );
}
