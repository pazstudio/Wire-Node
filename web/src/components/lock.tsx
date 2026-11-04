import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Project } from '../api';

export function useProject(projectId: string) {
  return useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<Project>(`/api/projects/${projectId}`) });
}

/** True while the project is locked; false until it has loaded. */
export function useLocked(projectId: string) {
  return !!useProject(projectId).data?.lockedAt;
}

const lockedDate = (p: Project) => new Date(p.lockedAt!).toLocaleDateString();

export function LockBanner({ project, text }: { project: Project; text?: string }) {
  if (!project.lockedAt) return null;
  return (
    <p className="lock-banner">
      <span aria-hidden>🔒</span>
      <span>
        {text ??
          `Locked on ${lockedDate(project)}. Nothing in this project can be changed, and changes in the component library
          no longer affect it. Duplicate it to start a new revision.`}
      </span>
    </p>
  );
}

export function LockButton({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const locked = !!project.lockedAt;

  async function toggle() {
    const message = locked
      ? `Unlock "${project.name}"?\n\nIt switches back to the components, connectors and cables in the library, so changes made ` +
        'there since it was locked will show up in it. Components that were deleted from the library (or lost a connector ' +
        'that is wired) are put back into the library instead.\n\nTo change a shipped revision, duplicating it is usually better.'
      : `Lock "${project.name}"?\n\nUse this when the device has shipped. The project keeps its own copy of every component, ` +
        'connector and cable it uses, so editing or deleting them in the library no longer changes it, and nothing in the ' +
        'project can be changed until it is unlocked.';
    if (!confirm(message)) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${project.id}/${locked ? 'unlock' : 'lock'}`, {});
      // Everything shown for the project now points at other components.
      await qc.invalidateQueries();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn" onClick={toggle} disabled={busy}>
      {busy ? (locked ? 'Unlocking…' : 'Locking…') : locked ? '🔓 Unlock' : '🔒 Lock project'}
    </button>
  );
}
