import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type ConnectorType } from '../../api';
import { ConnectorTypeForm } from '../../components/forms';
import { Loading } from '../../components/ui';

export default function ConnectorsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['connectorTypes'], queryFn: () => api.get<ConnectorType[]>('/api/connector-types') });
  const [editing, setEditing] = useState<ConnectorType | 'new' | null>(null);

  async function remove(t: ConnectorType) {
    const used = t._count?.instances ?? 0;
    const msg = used
      ? `Connector "${t.name}" is used by ${used} connector(s) drawn on components. Delete it anyway? The drawings stay but lose their connector type.`
      : `Delete connector "${t.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api.del(`/api/connector-types/${t.id}`);
      qc.invalidateQueries({ queryKey: ['connectorTypes'] });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <section>
      <div className="section-head">
        <p className="muted small">Connectors are shared between all projects. Click a row to edit.</p>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New connector
        </button>
      </div>
      {q.data.length === 0 ? (
        <p className="empty">No connectors yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Pins</th>
                <th>Rows</th>
                <th>Crimp</th>
                <th>Used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id} onClick={() => setEditing(t)}>
                  <td className="thumb-cell">
                    {t.thumbPath ? <img src={imgUrl(t.thumbPath)} alt="" /> : <span className="thumb-empty" />}
                  </td>
                  <td>
                    <strong>{t.name}</strong>
                  </td>
                  <td>{t.pinCount}</td>
                  <td>{t.rowCount}</td>
                  <td>{t.crimpName}</td>
                  <td>{t._count?.instances ?? 0}</td>
                  <td className="right">
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(t);
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
        <ConnectorTypeForm
          type={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['connectorTypes'] });
          }}
        />
      )}
    </section>
  );
}
