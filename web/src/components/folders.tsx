import { useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage, type Folder, type FolderKind } from '../api';
import { ErrorText, Modal } from './ui';

const NO_FOLDER = 'none';

export const foldersKey = (projectId: string, kind: FolderKind) => ['folders', projectId, kind];

export function useFolders(projectId: string, kind: FolderKind) {
  return useQuery({
    queryKey: foldersKey(projectId, kind),
    queryFn: () => api.get<Folder[]>(`/api/projects/${projectId}/folders?kind=${kind}`),
  });
}

/** Items in a folder; items whose folder no longer exists count as "not in a folder" (null). */
export function itemsIn<T extends { folderId: string | null }>(items: T[], folders: Folder[], folderId: string | null) {
  const ids = new Set(folders.map((f) => f.id));
  return items.filter((x) => (x.folderId && ids.has(x.folderId) ? x.folderId : null) === folderId);
}

/**
 * Drag and drop of items (component cards, connection rows) between folders.
 * `itemProps(id)` goes on each draggable item, `zoneProps(folderId)` on each folder.
 */
export function useFolderDnd(kind: FolderKind, onDrop: (itemId: string, folderId: string | null) => void) {
  const type = `application/x-wire-node-${kind}`;
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  function itemProps(id: string) {
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(type, id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(id);
      },
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
    };
  }

  function zoneProps(folderId: string | null) {
    const key = folderId ?? NO_FOLDER;
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(type)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((t) => (t === key ? null : t));
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(null);
        // The item re-mounts in its new folder, so its own dragend never arrives.
        setDragging(null);
        const id = e.dataTransfer.getData(type);
        if (id) onDrop(id, folderId);
      },
    };
  }

  return { dragging, isOver: (folderId: string | null) => over === (folderId ?? NO_FOLDER), itemProps, zoneProps };
}

/** A collapsible folder that takes dropped items. */
export function FolderSection({
  folder,
  count,
  open,
  dropping,
  zone,
  onToggle,
  onRename,
  onDelete,
  emptyText,
  children,
}: {
  folder: Folder;
  count: number;
  open: boolean;
  dropping: boolean;
  zone: ReturnType<ReturnType<typeof useFolderDnd>['zoneProps']>;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <div className={`folder ${dropping ? 'folder-drop' : ''}`} {...zone}>
      <div className="folder-head">
        <button className="folder-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="comp-chevron">{open ? '▾' : '▸'}</span>
          <span aria-hidden>📁</span>
          <span className="folder-name">{folder.name}</span>
          <span className="small muted">{count}</span>
        </button>
        <button className="btn btn-sm" onClick={onRename}>
          Rename
        </button>
        <button className="btn btn-sm btn-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
      {open && (count ? children : <p className="folder-empty">{emptyText}</p>)}
    </div>
  );
}

/** Items outside any folder; also where items are dropped to take them out of a folder. */
export function LooseSection({
  count,
  dropping,
  zone,
  children,
}: {
  count: number;
  dropping: boolean;
  zone: ReturnType<ReturnType<typeof useFolderDnd>['zoneProps']>;
  children: ReactNode;
}) {
  return (
    <div className={`folder folder-loose ${dropping ? 'folder-drop' : ''}`} {...zone}>
      <div className="folder-head">
        <span className="folder-name muted">Not in a folder</span>
        <span className="small muted">{count}</span>
      </div>
      {count ? children : <p className="folder-empty">Drop here to take an item out of its folder.</p>}
    </div>
  );
}

/** Dropdown to move one item to a folder (works where drag and drop does not, e.g. touch screens). */
export function FolderSelect({
  folders,
  value,
  onChange,
  label,
}: {
  folders: Folder[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  label: string;
}) {
  const current = value && folders.some((f) => f.id === value) ? value : '';
  return (
    <select
      className="folder-select"
      value={current}
      onChange={(e) => onChange(e.target.value || null)}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      title="Move to folder"
    >
      <option value="">No folder</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          📁 {f.name}
        </option>
      ))}
    </select>
  );
}

/** Asks, then deletes a folder; what was in it stays in the project. */
export async function deleteFolder(folder: Folder, count: number) {
  const msg = count
    ? `Delete folder "${folder.name}"? The ${count} item(s) in it stay in the project, outside any folder.`
    : `Delete folder "${folder.name}"?`;
  if (!confirm(msg)) return false;
  try {
    await api.del(`/api/folders/${folder.id}`);
  } catch (e) {
    alert(errorMessage(e));
  }
  return true;
}

export function FolderModal({
  projectId,
  kind,
  folder,
  onClose,
  onSaved,
}: {
  projectId: string;
  kind: FolderKind;
  folder: Folder | null;
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
      if (folder) await api.patch(`/api/folders/${folder.id}`, { name });
      else await api.post(`/api/projects/${projectId}/folders`, { name, kind });
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
            placeholder={kind === 'components' ? 'e.g. Toolhead, Frame, Electronics box' : 'e.g. Toolhead, Power, Sensors'}
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

/** Which folders are collapsed (per tab, for this visit). */
export function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return { isOpen: (id: string) => !collapsed.has(id), toggle };
}
