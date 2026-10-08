import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Project } from '../api';
import { ProjectForm } from '../components/forms';
import { Loading } from '../components/ui';

export default function ProjectsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const [editing, setEditing] = useState<Project | 'new' | null>(null);

  async function remove(p: Project) {
    if (!confirm(`Delete project "${p.name}"? Its connections and map are deleted. Library components, cables and connectors are kept.`)) return;
    try {
      await api.del(`/api/projects/${p.id}`);
      qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Projects</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New project
        </button>
      </div>
      {q.data.length === 0 && <p className="empty">No projects yet. Create one for each machine.</p>}
      <div className="card-grid">
        {q.data.map((p) => (
          <div key={p.id} className="card">
            <Link to={`/projects/${p.id}`} className="card-main">
              <h3>{p.name}</h3>
              {p.machine && <div className="muted">{p.machine}</div>}
              {p.description && <p className="small">{p.description}</p>}
              <div className="small muted">
                {p._count?.pcbs ?? 0} components · {p._count?.connections ?? 0} connections
              </div>
            </Link>
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(p)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <ProjectForm
          project={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            const isNew = editing === 'new';
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['projects'] });
            qc.invalidateQueries({ queryKey: ['project', p.id] });
            if (isNew) navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
