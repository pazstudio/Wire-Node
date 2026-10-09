import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type Pcb, type Placement } from '../../api';
import { PcbForm, sameName } from '../../components/forms';
import { ErrorText, Loading, Modal } from '../../components/ui';

export default function PcbsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['projectPcbs', projectId],
    queryFn: () => api.get<Placement[]>(`/api/projects/${projectId}/pcbs`),
  });
  const [editing, setEditing] = useState<Placement | 'new' | null>(null);
  // null = closed, true = open with nothing chosen, Pcb = open with that component chosen.
  const [picking, setPicking] = useState<Pcb | true | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['projectPcbs', projectId] });
    qc.invalidateQueries({ queryKey: ['projectConnectors', projectId] });
    qc.invalidateQueries({ queryKey: ['connections', projectId] });
    qc.invalidateQueries({ queryKey: ['pcbs'] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  async function detach(p: Placement) {
    try {
      const usage = await api.get<{ connections: { name: string }[] }>(`/api/project-pcbs/${p.id}/usage`);
      const lines = [`Remove "${p.name}" from this project? The component stays in the shared library.`];
      if (usage.connections.length)
        lines.push(`Its connectors and their wires will be removed from: ${usage.connections.map((x) => x.name).join(', ')}`);
      if (!confirm(lines.join('\n\n'))) return;
      await api.del(`/api/project-pcbs/${p.id}`);
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
        <p className="muted small">
          Components (PCBs, motors, power supplies…) live in a shared library. Add the same component several times
          under different names, e.g. "Main board - Master" and "Main board - Slave".
        </p>
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
            <Link to={`/projects/${projectId}/pcbs/${p.pcbId}`} className="card-main">
              <img src={imgUrl(p.pcb.thumbPath)} alt="" className="card-thumb" loading="lazy" />
              <h3>{p.name}</h3>
              {p.name !== p.pcb.name && <div className="small muted">Component: {p.pcb.name}</div>}
              {p.pcb.description && <p className="small">{p.pcb.description}</p>}
              <div className="small muted">{p.pcb._count?.connectors ?? 0} connectors drawn</div>
            </Link>
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button className="btn btn-sm" onClick={() => setPicking(p.pcb)} title="Add this component again under another name">
                Add another
              </button>
              <button className="btn btn-sm" onClick={() => detach(p)}>
                Remove from project
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => destroy(p.pcb)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <PcbForm
          pcb={editing === 'new' ? undefined : editing.pcb}
          placement={editing === 'new' ? undefined : editing}
          projectId={projectId}
          onClose={() => setEditing(null)}
          onUseExisting={(p) => {
            setEditing(null);
            setPicking(p);
          }}
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
        <PlacePcbModal
          projectId={projectId}
          placements={q.data}
          initial={picking === true ? null : picking}
          onClose={() => setPicking(null)}
          onPlaced={refresh}
        />
      )}
    </section>
  );
}

/** Picks a library component and places it in the project under a name of its own. */
function PlacePcbModal({
  projectId,
  placements,
  initial,
  onClose,
  onPlaced,
}: {
  projectId: string;
  placements: Placement[];
  initial: Pcb | null;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const q = useQuery({ queryKey: ['pcbs'], queryFn: () => api.get<Pcb[]>('/api/pcbs') });
  const placedAs = (p: Pcb) => placements.filter((x) => x.pcbId === p.id).map((x) => x.name);
  /** The component name for its first placement, then "<name> - 2", "<name> - 3", … */
  const suggestName = (p: Pcb) => {
    const n = placedAs(p).length;
    return n ? `${p.name} - ${n + 1}` : p.name;
  };

  // Opens straight on the name step when a component was chosen before opening.
  const [chosen, setChosen] = useState<Pcb | null>(initial);
  const [name, setName] = useState(() => (initial ? suggestName(initial) : ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function choose(p: Pcb) {
    setChosen(p);
    setName(suggestName(p));
    setError(null);
  }

  const taken = chosen ? placements.find((x) => sameName(x.name, name || chosen.name)) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    if (taken) {
      setError(`"${taken.name}" is already used in this project. Choose a different name.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/pcbs`, { pcbId: chosen.id, name: name.trim() });
      onPlaced();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (chosen) {
    const existing = placedAs(chosen);
    return (
      <Modal title={`Add "${chosen.name}"`} onClose={onClose}>
        <form onSubmit={submit} className="form">
          <div className="pick-item">
            <img src={imgUrl(chosen.thumbPath)} alt="" />
            <span>
              <strong>{chosen.name}</strong>
              <span className="small muted">{chosen._count?.connectors ?? 0} connectors</span>
            </span>
          </div>
          <label>
            Name in this project
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={chosen.name}
              autoFocus
              onFocus={(e) => e.target.select()}
            />
            <span className="hint">e.g. "{chosen.name} - Toolhead1" or "{chosen.name} - Master"</span>
          </label>
          {existing.length > 0 && (
            <p className="hint">
              Already in this project as: {existing.join(', ')}. You can rename those with Edit on their card.
            </p>
          )}
          {taken && <p className="error small">"{taken.name}" is already used in this project.</p>}
          <ErrorText error={error} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setChosen(null)}>
              Back
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !!taken}>
              {busy ? 'Adding…' : 'Add to project'}
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Add component from library" onClose={onClose} wide>
      {!q.data && <Loading error={q.error} />}
      {q.data && q.data.length === 0 && <p className="empty">The component library is empty. Upload a component first.</p>}
      <div className="pick-list">
        {(q.data ?? []).map((p) => {
          const here = placedAs(p).length;
          const elsewhere = (p.projects ?? []).filter((x) => x.project.id !== projectId).map((x) => x.project.name);
          return (
            <button key={p.id} className="pick-item" onClick={() => choose(p)}>
              <img src={imgUrl(p.thumbPath)} alt="" />
              <span>
                <strong>{p.name}</strong>
                <span className="small muted">
                  {p._count?.connectors ?? 0} connectors
                  {here > 0 && ` · ${here}× in this project`}
                  {elsewhere.length > 0 && ` · in ${elsewhere.join(', ')}`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
