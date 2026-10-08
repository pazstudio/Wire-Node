import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Cable } from '../../api';
import { CableForm } from '../../components/forms';
import { Loading, Swatch } from '../../components/ui';

export default function CablesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cables'], queryFn: () => api.get<Cable[]>('/api/cables') });
  const [editing, setEditing] = useState<Cable | 'new' | null>(null);

  async function remove(c: Cable) {
    const used = c._count?.wires ?? 0;
    const msg = used
      ? `Cable "${c.name}" is used by ${used} wire(s). Delete it anyway? Those wires keep their color but lose the cable reference.`
      : `Delete cable "${c.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api.del(`/api/cables/${c.id}`);
      qc.invalidateQueries({ queryKey: ['cables'] });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <section>
      <div className="section-head">
        <p className="muted small">Cables are shared between all projects. Click a row to edit.</p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New cable
        </button>
      </div>
      {q.data.length === 0 ? (
        <p className="empty">No cables yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Cores</th>
                <th>Shielded</th>
                <th>Gauge</th>
                <th>Length</th>
                <th>Used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((c) => (
                <tr key={c.id} onClick={() => setEditing(c)}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.description && <div className="small muted">{c.description}</div>}
                  </td>
                  <td>
                    <span className="swatches">
                      {c.coreCount}×{' '}
                      {c.cores.map((core, i) => (
                        <Swatch key={i} color={core.color} size={12} />
                      ))}
                    </span>
                  </td>
                  <td>{c.shielded ? 'Yes' : 'No'}</td>
                  <td>{c.gauge}</td>
                  <td>{c.lengthMm != null ? `${c.lengthMm} mm` : ''}</td>
                  <td>{c._count?.wires ?? 0} wires</td>
                  <td className="right">
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
      {editing && (
        <CableForm
          cable={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['cables'] });
          }}
        />
      )}
    </section>
  );
}
