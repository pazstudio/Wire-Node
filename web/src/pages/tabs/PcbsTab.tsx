import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type Pcb } from '../../api';
import { PcbForm } from '../../components/forms';
import { Loading, Modal } from '../../components/ui';

export default function PcbsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['projectPcbs', projectId],
    queryFn: () => api.get<Pcb[]>(`/api/projects/${projectId}/pcbs`),
  });
  const [editing, setEditing] = useState<Pcb | 'new' | null>(null);
  const [picking, setPicking] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['projectPcbs', projectId] });
    qc.invalidateQueries({ queryKey: ['pcbs'] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  async function detach(p: Pcb) {
    if (!confirm(`Remove "${p.name}" from this project? The component stays in the shared library.`)) return;
    try {
      await api.del(`/api/projects/${projectId}/pcbs/${p.id}`);
      refresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  async function destroy(p: Pcb) {
    try {
      const usage = await api.get<{ projects: { name: string }[]; connections: { name: string }[] }>(`/api/pcbs/${p.id}/usage`);
      const lines = [`Permanently delete component "${p.name}", its picture and all connectors drawn on it?`];
      if (usage.projects.length) lines.push(`Used in projects: ${usage.projects.map((x) => x.name).join(', ')}`);
      if (usage.connections.length)
        lines.push(`Wires in these connections will be removed: ${usage.connections.map((x) => x.name).join(', ')}`);
      if (!confirm(lines.join('\n\n'))) return;
      await api.del(`/api/pcbs/${p.id}`);
      refresh();
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <section>
      <div className="section-head">
        <p className="muted small">Components (PCBs, motors, power supplies…) live in a shared library and can be used in several projects.</p>
        <div className="btn-row">
          <button className="btn" onClick={() => setPicking(true)}>
            Add existing component
          </button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Upload component
          </button>
        </div>
      </div>
      {q.data.length === 0 && <p className="empty">No components in this project yet. Upload a picture of a PCB, motor or power supply to start.</p>}
      <div className="card-grid">
        {q.data.map((p) => (
          <div key={p.id} className="card">
            <Link to={`/projects/${projectId}/pcbs/${p.id}`} className="card-main">
              <img src={imgUrl(p.thumbPath)} alt="" className="card-thumb" loading="lazy" />
              <h3>{p.name}</h3>
              {p.description && <p className="small">{p.description}</p>}
              <div className="small muted">{p._count?.connectors ?? 0} connectors drawn</div>
            </Link>
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button className="btn btn-sm" onClick={() => detach(p)}>
                Remove from project
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => destroy(p)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <PcbForm
          pcb={editing === 'new' ? undefined : editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            const isNew = editing === 'new';
            setEditing(null);
            refresh();
            qc.invalidateQueries({ queryKey: ['pcb', p.id] });
            // After uploading, open the component page so connectors can be drawn right away.
            if (isNew) navigate(`/projects/${projectId}/pcbs/${p.id}?edit=1`);
          }}
        />
      )}
      {picking && (
        <AttachPcbModal
          projectId={projectId}
          attachedIds={new Set(q.data.map((p) => p.id))}
          onClose={() => setPicking(false)}
          onAttached={refresh}
        />
      )}
    </section>
  );
}

function AttachPcbModal({
  projectId,
  attachedIds,
  onClose,
  onAttached,
}: {
  projectId: string;
  attachedIds: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const q = useQuery({ queryKey: ['pcbs'], queryFn: () => api.get<Pcb[]>('/api/pcbs') });
  const available = (q.data ?? []).filter((p) => !attachedIds.has(p.id));

  async function attach(p: Pcb) {
    try {
      await api.post(`/api/projects/${projectId}/pcbs`, { pcbId: p.id });
      onAttached();
      onClose();
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  return (
    <Modal title="Add component from library" onClose={onClose} wide>
      {!q.data && <Loading error={q.error} />}
      {q.data && available.length === 0 && <p className="empty">All library components are already in this project.</p>}
      <div className="pick-list">
        {available.map((p) => (
          <button key={p.id} className="pick-item" onClick={() => attach(p)}>
            <img src={imgUrl(p.thumbPath)} alt="" />
            <span>
              <strong>{p.name}</strong>
              <span className="small muted">
                {p._count?.connectors ?? 0} connectors
                {p.projects?.length ? ` · in ${p.projects.map((x) => x.project.name).join(', ')}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
