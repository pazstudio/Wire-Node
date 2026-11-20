import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Project, type ProjectDiff } from '../api';
import { Loading } from './ui';

/**
 * What changed compared with another project, e.g. the previous revision of the machine
 * (duplicate a project to start a revision, then compare the two).
 */
export function CompareProjects({ projectId }: { projectId: string }) {
  const [other, setOther] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const diff = useQuery({
    queryKey: ['compare', projectId, other],
    queryFn: () => api.get<ProjectDiff>(`/api/projects/${projectId}/compare/${other}`),
    enabled: !!other,
  });
  const others = (projects.data ?? []).filter((p) => p.id !== projectId);

  return (
    <div className="panel">
      <h3>Compare with another project</h3>
      <p className="small muted">
        Shows what is different here compared with another project, such as the previous revision of this machine.
        Components and connections are matched by name, wires by the pins they join.
      </p>
      <select value={other} onChange={(e) => setOther(e.target.value)} aria-label="Project to compare with">
        <option value="">— choose a project —</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.lockedAt ? ' (locked)' : ''}
          </option>
        ))}
      </select>
      {other && !diff.data && <Loading error={diff.error} />}
      {other && diff.data && <DiffView diff={diff.data} />}
    </div>
  );
}

function DiffView({ diff }: { diff: ProjectDiff }) {
  const { components: c, connections } = diff;
  if (diff.total === 0) return <p className="restore-result">Same wiring as “{diff.a.name}”.</p>;
  return (
    <div className="diff mt">
      <p className="small">
        <strong>{diff.total}</strong> difference{diff.total > 1 ? 's' : ''} from “{diff.a.name}” to “{diff.b.name}”.
      </p>
      {(c.added.length > 0 || c.removed.length > 0 || c.changed.length > 0) && (
        <>
          <h4>Components</h4>
          <ul className="diff-list">
            {c.added.map((n) => (
              <li key={`a${n}`} className="diff-add">
                + {n}
              </li>
            ))}
            {c.removed.map((n) => (
              <li key={`r${n}`} className="diff-del">
                − {n}
              </li>
            ))}
            {c.changed.map((n) => (
              <li key={`c${n}`} className="diff-mod">
                ~ {n}
              </li>
            ))}
          </ul>
        </>
      )}
      {connections.length > 0 && <h4>Connections</h4>}
      {connections.map((conn) => (
        <details key={`${conn.status}${conn.name}`} className={`diff-conn diff-conn-${conn.status}`} open={conn.status === 'changed'}>
          <summary>
            <span className={`badge diff-badge-${conn.status}`}>{conn.status}</span> <strong>{conn.name}</strong>
            {conn.status !== 'changed' && <span className="small muted"> · {conn.lines.length} wire(s)</span>}
          </summary>
          <ul className="diff-list small">
            {conn.lines.map((l, i) => (
              <li key={i} className={l.startsWith('Added') ? 'diff-add' : l.startsWith('Removed') ? 'diff-del' : conn.status === 'changed' ? 'diff-mod' : ''}>
                {l}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
