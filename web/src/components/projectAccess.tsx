import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Project } from '../api';
import { useCan } from '../auth';
import { ErrorText, Loading, Modal } from './ui';

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
  group?: { name: string; isAdmin: boolean };
  groupName?: string;
}

/** "Access" button on the project page, for those who manage users. */
export function ProjectAccessButton({ project }: { project: Project }) {
  const canManage = useCan('users.manage');
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)} title="Who can see this project">
        {project.restricted ? '👥 Restricted' : 'Access'}
      </button>
      {open && <ProjectAccessModal project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectAccessModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useQuery({
    queryKey: ['access', project.id],
    queryFn: () => api.get<{ restricted: boolean; userIds: string[] }>(`/api/projects/${project.id}/access`),
  });
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<UserRow[]>('/api/admin/users') });
  const [restricted, setRestricted] = useState(false);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (access.data && !loaded) {
      setRestricted(access.data.restricted);
      setMembers(new Set(access.data.userIds));
      setLoaded(true);
    }
  }, [access.data, loaded]);

  async function save() {
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/access`, { restricted, userIds: [...members] });
      await Promise.all([qc.invalidateQueries({ queryKey: ['project', project.id] }), qc.invalidateQueries({ queryKey: ['projects'] })]);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const isAdmin = (u: UserRow) => u.group?.isAdmin ?? false;
  return (
    <Modal title={`Who can see "${project.name}"`} onClose={onClose}>
      {!loaded || !users.data ? (
        <Loading error={access.error ?? users.error} />
      ) : (
        <>
          <label className="check">
            <input type="radio" checked={!restricted} onChange={() => setRestricted(false)} /> Everyone signed in (what they may
            change depends on their group)
          </label>
          <label className="check">
            <input type="radio" checked={restricted} onChange={() => setRestricted(true)} /> Only these people, and admins
          </label>
          {restricted && (
            <div className="member-list">
              {users.data
                .filter((u) => !u.disabled)
                .map((u) => (
                  <label key={u.id} className="check">
                    <input
                      type="checkbox"
                      disabled={isAdmin(u)}
                      checked={isAdmin(u) || members.has(u.id)}
                      onChange={(e) => {
                        const next = new Set(members);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        setMembers(next);
                      }}
                    />{' '}
                    {u.displayName || u.username} <span className="small muted">({u.username}{isAdmin(u) ? ', admin' : ''})</span>
                  </label>
                ))}
            </div>
          )}
          <p className="small muted">
            Others do not see a restricted project anywhere: not in the project list, search, history or the library's "used
            in" lists. Library components stay shared.
          </p>
          <ErrorText error={error} />
          <div className="form-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
