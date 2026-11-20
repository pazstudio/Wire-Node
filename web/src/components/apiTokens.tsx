import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api';
import { ErrorText, Modal } from './ui';

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The signed-in user's read-only API tokens, for scripts (e.g. downloading a wiring summary in CI). */
export function ApiTokensModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get<ApiToken[]>('/api/auth/tokens') });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const t = await api.post<ApiToken & { token: string }>('/api/auth/tokens', { name });
      setCreated(t.token);
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(t: ApiToken) {
    if (!confirm(`Revoke "${t.name}"? Scripts using it stop working.`)) return;
    await api.del(`/api/auth/tokens/${t.id}`);
    void qc.invalidateQueries({ queryKey: ['api-tokens'] });
  }

  const origin = window.location.origin;
  return (
    <Modal title="API tokens" onClose={onClose} wide>
      <p className="small">
        A token lets a script read Wire-Node as you, without signing in: projects, wiring summaries, build lists and
        checks. Tokens are <strong>read-only</strong>: they cannot change anything, and they do not get your admin rights
        (no backups or accounts).
      </p>
      <pre className="code-block small">
        {`curl -H "Authorization: Bearer wn_…" ${origin}/api/projects
curl -H "Authorization: Bearer wn_…" -o wiring.md ${origin}/api/projects/<project id>/wiring.md
curl -H "Authorization: Bearer wn_…" ${origin}/api/projects/<project id>/checks`}
      </pre>
      {created && (
        <div className="restore-result">
          <strong>Copy the token now; it is not shown again:</strong>
          <div className="input-row mt-s">
            <input readOnly value={created} className="mono" onFocus={(e) => e.target.select()} />
            <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(created)}>
              Copy
            </button>
          </div>
        </div>
      )}
      <form onSubmit={create} className="input-row mt">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Firmware CI" maxLength={100} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          Create token
        </button>
      </form>
      <ErrorText error={error} />
      <table className="table small mt">
        <thead>
          <tr>
            <th>Name</th>
            <th>Token</th>
            <th>Created</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td className="mono">{t.prefix}…</td>
              <td>{new Date(t.createdAt).toLocaleDateString()}</td>
              <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}</td>
              <td className="right">
                <button className="btn btn-sm btn-danger" onClick={() => revoke(t)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {q.data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No tokens.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
