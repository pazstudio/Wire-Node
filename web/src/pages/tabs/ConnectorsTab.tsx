import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type ConnectorType } from '../../api';
import { ConnectorTypeForm } from '../../components/forms';
import { ConnectorTemplatesModal } from '../../components/connectorTemplates';
import { useCan } from '../../auth';
import { Loading } from '../../components/ui';

export default function ConnectorsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['connectorTypes'], queryFn: () => api.get<ConnectorType[]>('/api/connector-types') });
  const [editing, setEditing] = useState<ConnectorType | 'new' | null>(null);
  const [templates, setTemplates] = useState(false);
  const canEdit = useCan('library.edit');
  const canDelete = useCan('library.delete');

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
        <div className="btn-row" hidden={!canEdit}>
          <button className="btn" onClick={() => setTemplates(true)}>
            Add common connectors…
          </button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + New connector
          </button>
        </div>
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
                <tr key={t.id} onClick={() => canEdit && setEditing(t)}>
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
                      hidden={!canDelete}
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
      {templates && <ConnectorTemplatesModal existing={q.data} onClose={() => setTemplates(false)} />}
    </section>
  );
}
