import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, imgUrl, type Folder, type Pcb, type Placement } from '../../api';
import {
  FolderField,
  FolderModal,
  FolderSection,
  FolderSelect,
  LooseSection,
  deleteFolder,
  foldersKey,
  itemsIn,
  useCollapsed,
  useFolderDnd,
  useFolders,
} from '../../components/folders';
import { PcbForm, sameName } from '../../components/forms';
import { ErrorText, Loading, Modal } from '../../components/ui';

export default function PcbsTab({ projectId, locked }: { projectId: string; locked: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['projectPcbs', projectId],
    queryFn: () => api.get<Placement[]>(`/api/projects/${projectId}/pcbs`),
  });
  const [editing, setEditing] = useState<Placement | 'new' | null>(null);
  // null = closed; pcb null = open with nothing chosen yet. folderId is the folder suggested for the new placement.
  const [picking, setPicking] = useState<{ pcb: Pcb | null; folderId: string | null } | null>(null);
  const foldersQ = useFolders(projectId, 'components');
  const [folderForm, setFolderForm] = useState<Folder | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Pcb | null>(null);
  const collapsed = useCollapsed();
  const dnd = useFolderDnd('components', (id, folderId) => {
    const p = q.data?.find((x) => x.id === id);
    if (p) moveTo(p, folderId);
  }, !locked);

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

  async function removeFolder(f: Folder, count: number) {
    if (!(await deleteFolder(f, count))) return;
    qc.invalidateQueries({ queryKey: foldersKey(projectId, 'components') });
    qc.invalidateQueries({ queryKey: ['projectPcbs', projectId] });
  }

  if (!q.data || !foldersQ.data) return <Loading error={q.error || foldersQ.error} />;
  const placements = q.data;
  const folders = foldersQ.data;
  const loose = itemsIn(placements, folders, null);

  const card = (p: Placement) => (
    <div key={p.id} className={`card ${dnd.dragging === p.id ? 'card-dragging' : ''}`} {...dnd.itemProps(p.id)}>
      <Link to={`/projects/${projectId}/pcbs/${p.pcbId}`} className="card-main" draggable={false}>
        <img src={imgUrl(p.pcb.thumbPath)} alt="" className="card-thumb" loading="lazy" draggable={false} />
        <h3>{p.name}</h3>
        {p.name !== p.pcb.name && <div className="small muted">Component: {p.pcb.name}</div>}
        {p.pcb.description && <p className="small">{p.pcb.description}</p>}
        <div className="small muted">{p.pcb._count?.connectors ?? 0} connectors drawn</div>
      </Link>
      {!locked && (
        <div className="card-actions">
          <button className="btn btn-sm" onClick={() => setEditing(p)}>
            Edit
          </button>
          <button className="btn btn-sm" onClick={() => setPicking({ pcb: p.pcb, folderId: p.folderId })}
            title="Add this component again under another name">
            Add another
          </button>
          <button className="btn btn-sm" onClick={() => detach(p)}>
            Remove from project
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => setDeleting(p.pcb)}>
            Delete
          </button>
          {folders.length > 0 && (
            <FolderSelect folders={folders} value={p.folderId} onChange={(f) => moveTo(p, f)} label={`Folder of ${p.name}`} />
          )}
        </div>
      )}
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
        {!locked && (
          <div className="btn-row">
            <button className="btn" onClick={() => setFolderForm('new')}>
              + New folder
            </button>
            <button className="btn" onClick={() => setPicking({ pcb: null, folderId: null })}>
              Add existing component
            </button>
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              + Upload component
            </button>
          </div>
        )}
      </div>
      {placements.length === 0 && <p className="empty">No components in this project yet. Upload a picture of a PCB, motor or power supply to start.</p>}

      {folders.map((f) => {
        const items = itemsIn(placements, folders, f.id);
        return (
          <FolderSection
            key={f.id}
            folder={f}
            count={items.length}
            open={collapsed.isOpen(f.id)}
            dropping={dnd.isOver(f.id)}
            zone={dnd.zoneProps(f.id)}
            onToggle={() => collapsed.toggle(f.id)}
            onRename={() => setFolderForm(f)}
            onDelete={() => removeFolder(f, items.length)}
            readOnly={locked}
            emptyText="Empty. Drag components here, or choose this folder on a component card."
          >
            <div className="card-grid">{items.map(card)}</div>
          </FolderSection>
        );
      })}
      {folders.length > 0 && (
        <LooseSection count={loose.length} dropping={dnd.isOver(null)} zone={dnd.zoneProps(null)}>
          <div className="card-grid">{loose.map(card)}</div>
        </LooseSection>
      )}
      {folders.length === 0 && <div className="card-grid">{placements.map(card)}</div>}

      {editing && (
        <PcbForm
          pcb={editing === 'new' ? undefined : editing.pcb}
          placement={editing === 'new' ? undefined : editing}
          projectId={projectId}
          folders={folders}
          onClose={() => setEditing(null)}
          onUseExisting={(p, folderId) => {
            setEditing(null);
            setPicking({ pcb: p, folderId });
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
          kind="components"
          folder={folderForm === 'new' ? null : folderForm}
          onClose={() => setFolderForm(null)}
          onSaved={() => {
            setFolderForm(null);
            qc.invalidateQueries({ queryKey: foldersKey(projectId, 'components') });
          }}
        />
      )}
      {deleting && (
        <DeletePcbModal
          pcb={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      )}
      {picking && (
        <PlacePcbModal
          projectId={projectId}
          placements={q.data}
          folders={folders}
          initial={picking.pcb}
          initialFolderId={picking.folderId}
          onClose={() => setPicking(null)}
          onPlaced={refresh}
        />
      )}
    </section>
  );
}

/** Typed so a component is never deleted from the library (and every project) by a stray click. */
const DELETE_PHRASE = 'permanentlydeletefromallprojects';

/** Deletes a component from the library; the user has to type DELETE_PHRASE first. */
function DeletePcbModal({ pcb, onClose, onDeleted }: { pcb: Pcb; onClose: () => void; onDeleted: () => void }) {
  const usageQ = useQuery({
    queryKey: ['pcbUsage', pcb.id],
    queryFn: () => api.get<{ projects: { name: string }[]; connections: { name: string }[] }>(`/api/pcbs/${pcb.id}/usage`),
    gcTime: 0,
  });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = typed.trim() === DELETE_PHRASE;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/pcbs/${pcb.id}?confirm=${DELETE_PHRASE}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const usage = usageQ.data;
  return (
    <Modal title={`Delete "${pcb.name}" permanently`} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p>
          This deletes the component, its picture and all connectors drawn on it from the library and from{' '}
          <strong>every project</strong>. It cannot be undone. To take it out of this project only, use{' '}
          <strong>Remove from project</strong> instead.
        </p>
        {!usage && <Loading error={usageQ.error} />}
        {usage && usage.projects.length > 0 && (
          <p className="small">Used in projects: {usage.projects.map((x) => x.name).join(', ')}</p>
        )}
        {usage && usage.connections.length > 0 && (
          <p className="small">
            Wires in these connections will be removed: {usage.connections.map((x) => x.name).join(', ')}
          </p>
        )}
        <label>
          Type <code>{DELETE_PHRASE}</code> to confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <ErrorText error={error} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={!confirmed || busy || !usage}>
            {busy ? 'Deleting…' : 'Delete permanently'}
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
  folders,
  initial,
  initialFolderId,
  onClose,
  onPlaced,
}: {
  projectId: string;
  placements: Placement[];
  folders: Folder[];
  initial: Pcb | null;
  initialFolderId: string | null;
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
  const [folderId, setFolderId] = useState(initialFolderId);
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
      await api.post(`/api/projects/${projectId}/pcbs`, { pcbId: chosen.id, name: name.trim(), folderId });
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
          <FolderField folders={folders} value={folderId} onChange={setFolderId} />
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
