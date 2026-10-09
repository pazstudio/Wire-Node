import { useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type ComponentFolder, type Pcb, type Placement } from '../../api';
import { PcbForm, sameName } from '../../components/forms';
import { ErrorText, Loading, Modal } from '../../components/ui';

const DRAG_TYPE = 'application/x-wire-node-placement';
const NO_FOLDER = 'none';

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
  const foldersQ = useQuery({
    queryKey: ['folders', projectId],
    queryFn: () => api.get<ComponentFolder[]>(`/api/projects/${projectId}/folders`),
  });
  const [folderForm, setFolderForm] = useState<ComponentFolder | 'new' | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<string | null>(null); // placement id
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder id or NO_FOLDER

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

  async function moveTo(p: Placement, folderId: string | null) {
    if (p.folderId === folderId) return;
    // Move the card right away; the server answer follows.
    qc.setQueryData<Placement[]>(['projectPcbs', projectId], (list) =>
      list?.map((x) => (x.id === p.id ? { ...x, folderId } : x)),
    );
    try {
      await api.patch(`/api/project-pcbs/${p.id}`, { folderId });
    } catch (e) {
      alert(errorMessage(e));
    }
    qc.invalidateQueries({ queryKey: ['projectPcbs', projectId] });
  }

  async function removeFolder(f: ComponentFolder, count: number) {
    const msg = count
      ? `Delete folder "${f.name}"? Its ${count} component(s) stay in the project, outside any folder.`
      : `Delete folder "${f.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api.del(`/api/component-folders/${f.id}`);
    } catch (e) {
      alert(errorMessage(e));
    }
    qc.invalidateQueries({ queryKey: ['folders', projectId] });
    qc.invalidateQueries({ queryKey: ['projectPcbs', projectId] });
  }

  function toggleFolder(id: string) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  if (!q.data || !foldersQ.data) return <Loading error={q.error || foldersQ.error} />;
  const placements = q.data;
  const folders = foldersQ.data;
  const folderIds = new Set(folders.map((f) => f.id));
  const inFolder = (folderId: string | null) =>
    placements.filter((p) => (p.folderId && folderIds.has(p.folderId) ? p.folderId : null) === folderId);
  const loose = inFolder(null);

  /** Lets a folder (or "not in a folder", null) take a dragged component card. */
  function dropZone(folderId: string | null) {
    const key = folderId ?? NO_FOLDER;
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropTarget(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === key ? null : t));
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        // The card re-mounts in its new folder, so its own dragend never arrives.
        setDragging(null);
        const p = placements.find((x) => x.id === e.dataTransfer.getData(DRAG_TYPE));
        if (p) moveTo(p, folderId);
      },
    };
  }

  const card = (p: Placement) => (
    <div
      key={p.id}
      className={`card ${dragging === p.id ? 'card-dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, p.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(p.id);
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
    >
      <Link to={`/projects/${projectId}/pcbs/${p.pcbId}`} className="card-main" draggable={false}>
        <img src={imgUrl(p.pcb.thumbPath)} alt="" className="card-thumb" loading="lazy" draggable={false} />
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
        {folders.length > 0 && (
          <select
            className="folder-select"
            value={p.folderId && folderIds.has(p.folderId) ? p.folderId : ''}
            onChange={(e) => moveTo(p, e.target.value || null)}
            aria-label={`Folder of ${p.name}`}
            title="Move to folder"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                📁 {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );

  return (
    <section>
      <div className="section-head">
        <p className="muted small">
          Components (PCBs, motors, power supplies…) live in a shared library. Add the same component several times
          under different names, e.g. "Main board - Master" and "Main board - Slave". Sort them into folders by machine
          part: drag a card onto a folder.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => setFolderForm('new')}>
            + New folder
          </button>
          <button className="btn" onClick={() => setPicking(true)}>
            Add existing component
          </button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Upload component
          </button>
        </div>
      </div>
      {placements.length === 0 && <p className="empty">No components in this project yet. Upload a picture of a PCB, motor or power supply to start.</p>}

      {folders.map((f) => {
        const items = inFolder(f.id);
        const open = !collapsed.has(f.id);
        return (
          <div key={f.id} className={`folder ${dropTarget === f.id ? 'folder-drop' : ''}`} {...dropZone(f.id)}>
            <div className="folder-head">
              <button className="folder-toggle" onClick={() => toggleFolder(f.id)} aria-expanded={open}>
                <span className="comp-chevron">{open ? '▾' : '▸'}</span>
                <span className="folder-icon" aria-hidden>
                  📁
                </span>
                <span className="folder-name">{f.name}</span>
                <span className="small muted">{items.length}</span>
              </button>
              <button className="btn btn-sm" onClick={() => setFolderForm(f)}>
                Rename
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => removeFolder(f, items.length)}>
                Delete
              </button>
            </div>
            {open &&
              (items.length ? (
                <div className="card-grid">{items.map(card)}</div>
              ) : (
                <p className="folder-empty">Empty. Drag components here, or choose this folder on a component card.</p>
              ))}
          </div>
        );
      })}

      {folders.length > 0 && (
        <div className={`folder folder-loose ${dropTarget === NO_FOLDER ? 'folder-drop' : ''}`} {...dropZone(null)}>
          <div className="folder-head">
            <span className="folder-name muted">Not in a folder</span>
            <span className="small muted">{loose.length}</span>
          </div>
          {loose.length ? (
            <div className="card-grid">{loose.map(card)}</div>
          ) : (
            <p className="folder-empty">Drop here to take a component out of its folder.</p>
          )}
        </div>
      )}
      {folders.length === 0 && <div className="card-grid">{placements.map(card)}</div>}

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
      {folderForm && (
        <FolderModal
          projectId={projectId}
          folder={folderForm === 'new' ? null : folderForm}
          onClose={() => setFolderForm(null)}
          onSaved={() => {
            setFolderForm(null);
            qc.invalidateQueries({ queryKey: ['folders', projectId] });
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

function FolderModal({
  projectId,
  folder,
  onClose,
  onSaved,
}: {
  projectId: string;
  folder: ComponentFolder | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(folder?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (folder) await api.patch(`/api/component-folders/${folder.id}`, { name });
      else await api.post(`/api/projects/${projectId}/folders`, { name });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={folder ? 'Rename folder' : 'New folder'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="e.g. Toolhead, Frame, Electronics box"
          />
        </label>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {folder ? 'Rename' : 'Create folder'}
          </button>
        </div>
      </form>
    </Modal>
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
