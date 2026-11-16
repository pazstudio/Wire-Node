import { Link, useParams, useSearchParams } from 'react-router-dom';
import { LockBanner, LockButton, useProject } from '../components/lock';
import { Loading } from '../components/ui';
import { WiringExportNotice, WiringSummaryButton } from '../components/wiringExport';
import PcbsTab from './tabs/PcbsTab';
import CablesTab from './tabs/CablesTab';
import ConnectorsTab from './tabs/ConnectorsTab';
import ConnectionsTab from './tabs/ConnectionsTab';
import SearchTab from './tabs/SearchTab';
import { HistoryList } from '../components/history';

const TABS = [
  { key: 'pcbs', label: 'Components' },
  { key: 'cables', label: 'Cables' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'connections', label: 'Connections' },
  { key: 'search', label: 'Search' },
  { key: 'history', label: 'History' },
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
          <WiringSummaryButton projectId={pid} />
          <Link to={`/projects/${pid}/map`} className="btn btn-primary">
            Project map
          </Link>
        </div>
      </div>
      <LockBanner project={project} />
      <WiringExportNotice projectId={pid} />
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
      {tab === 'search' && <SearchTab projectId={pid} />}
      {tab === 'history' && (
        <div className="panel">
          <h3>Recent changes</h3>
          <p className="small muted">
            Changes to this project's connections, and to the library components placed in it, with who made them and why.
          </p>
          <HistoryList filter={{ projectId: pid }} projectId={pid} showEntity />
        </div>
      )}
    </div>
  );
}
