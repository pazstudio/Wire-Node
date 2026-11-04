import { Link, useParams, useSearchParams } from 'react-router-dom';
import { LockBanner, LockButton, useProject } from '../components/lock';
import { Loading } from '../components/ui';
import PcbsTab from './tabs/PcbsTab';
import CablesTab from './tabs/CablesTab';
import ConnectorsTab from './tabs/ConnectorsTab';
import ConnectionsTab from './tabs/ConnectionsTab';

const TABS = [
  { key: 'pcbs', label: 'Components' },
  { key: 'cables', label: 'Cables' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'connections', label: 'Connections' },
] as const;

export default function ProjectPage() {
  const { pid } = useParams() as { pid: string };
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'pcbs';
  const q = useProject(pid);

  if (!q.data) return <Loading error={q.error} />;
  const project = q.data;
  const locked = !!project.lockedAt;

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/">Projects</Link> / <span>{project.name}</span>
      </div>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.machine && <div className="muted">{project.machine}</div>}
        </div>
        <div className="btn-row">
          <LockButton project={project} />
          <Link to={`/projects/${pid}/map`} className="btn btn-primary">
            Project map
          </Link>
        </div>
      </div>
      <LockBanner project={project} />
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'pcbs' && <PcbsTab projectId={pid} locked={locked} />}
      {tab === 'cables' && <CablesTab />}
      {tab === 'connectors' && <ConnectorsTab />}
      {tab === 'connections' && <ConnectionsTab projectId={pid} locked={locked} />}
    </div>
  );
}
