import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, formatLength, parseLength, type ConnectionSummary, type Folder, type Placement } from '../../api';
import {
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
import { PlacementPicker } from '../../components/placements';
import { ErrorText, Loading, Modal } from '../../components/ui';

export default function ConnectionsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const q = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => api.get<ConnectionSummary[]>(`/api/projects/${projectId}/connections`),
  });
  const foldersQ = useFolders(projectId, 'connections');
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [folderForm, setFolderForm] = useState<Folder | 'new' | null>(null);
  const collapsed = useCollapsed();
  const dnd = useFolderDnd('connections', (id, folderId) => {
    const c = q.data?.find((x) => x.id === id);
    if (c) moveTo(c, folderId);
  });

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

  async function moveTo(c: ConnectionSummary, folderId: string | null) {
    if (c.folderId === folderId) return;
    // Move the row right away; the server answer follows.
    qc.setQueryData<ConnectionSummary[]>(['connections', projectId], (list) =>
      list?.map((x) => (x.id === c.id ? { ...x, folderId } : x)),
    );
    try {
      await api.patch(`/api/connections/${c.id}`, { folderId });
    } catch (e) {
      alert(errorMessage(e));
    }
    qc.invalidateQueries({ queryKey: ['connections', projectId] });
  }

  async function removeFolder(f: Folder, count: number) {
    if (!(await deleteFolder(f, count))) return;
    qc.invalidateQueries({ queryKey: foldersKey(projectId, 'connections') });
    qc.invalidateQueries({ queryKey: ['connections', projectId] });
  }

  if (!q.data || !foldersQ.data) return <Loading error={q.error || foldersQ.error} />;
  const connections = q.data;
  const folders = foldersQ.data;
  const loose = itemsIn(connections, folders, null);

  const table = (list: ConnectionSummary[]) => (
    <div className="table-wrap">
      {/* Fixed column widths so the tables of all folders line up. */}
      <table className="table clickable conn-table">
        <colgroup>
          <col style={{ width: '24%' }} />
          <col style={{ width: '9%' }} />
          <col />
          <col style={{ width: '9%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: folders.length ? 300 : 150 }} />
        </colgroup>
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
          {list.map((c) => (
            <tr
              key={c.id}
              className={dnd.dragging === c.id ? 'row-dragging' : ''}
              onClick={() => navigate(`/projects/${projectId}/connections/${c.id}`)}
              {...dnd.itemProps(c.id)}
            >
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
                {folders.length > 0 && (
                  <FolderSelect folders={folders} value={c.folderId} onChange={(f) => moveTo(c, f)} label={`Folder of ${c.name}`} />
                )}{' '}
                <Link
                  className="btn btn-sm"
                  to={`/projects/${projectId}/connections/${c.id}/edit`}
                  onClick={(e) => e.stopPropagation()}
                  draggable={false}
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
  );

  return (
    <section>
      <div className="section-head">
        <p className="muted small">
          A connection links connectors drawn on components. Add more than two connectors to build a harness with splits.
          Sort connections into folders: drag a row onto a folder.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => setFolderForm('new')}>
            + New folder
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            + New connection
          </button>
        </div>
      </div>
      {connections.length === 0 && (
        <p className="empty">No connections yet. Draw connectors on at least one component first, then create a connection.</p>
      )}

      {folders.map((f) => {
        const items = itemsIn(connections, folders, f.id);
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
            emptyText="Empty. Drag connections here, or choose this folder on a connection."
          >
            {table(items)}
          </FolderSection>
        );
      })}
      {folders.length > 0 && (
        <LooseSection count={loose.length} dropping={dnd.isOver(null)} zone={dnd.zoneProps(null)}>
          {table(loose)}
        </LooseSection>
      )}
      {folders.length === 0 && connections.length > 0 && table(connections)}

      {creating && (
        <NewConnectionModal
          projectId={projectId}
          folders={folders}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ['connections', projectId] });
            navigate(`/projects/${projectId}/connections/${id}/edit`);
          }}
        />
      )}
      {folderForm && (
        <FolderModal
          projectId={projectId}
          kind="connections"
          folder={folderForm === 'new' ? null : folderForm}
          onClose={() => setFolderForm(null)}
          onSaved={() => {
            setFolderForm(null);
            qc.invalidateQueries({ queryKey: foldersKey(projectId, 'connections') });
          }}
        />
      )}
    </section>
  );
}

function NewConnectionModal({
  projectId,
  folders,
  onClose,
  onCreated,
}: {
  projectId: string;
  folders: Folder[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [length, setLength] = useState('');
  const [placementIds, setPlacementIds] = useState<string[]>([]);
  const [folderId, setFolderId] = useState('');
  const placementsQ = useQuery({
    queryKey: ['projectPcbs', projectId],
    queryFn: () => api.get<Placement[]>(`/api/projects/${projectId}/pcbs`),
  });
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
        placementIds,
        folderId: folderId || null,
      });
      onCreated(c.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New connection" onClose={onClose} wide>
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
        {folders.length > 0 && (
          <label>
            Folder
            <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  📁 {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="field">
          <span className="field-label">Components in this connection</span>
          <span className="small muted">Only connectors of these components are listed in the editor. You can change this later.</span>
          {placementsQ.data ? (
            <PlacementPicker projectId={projectId} placements={placementsQ.data} selected={placementIds} onChange={setPlacementIds} />
          ) : (
            <Loading error={placementsQ.error} />
          )}
        </div>
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
