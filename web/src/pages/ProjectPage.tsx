import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type BuildStatus } from '../api';
import { LockBanner, LockButton, useProject } from '../components/lock';
import { Loading } from '../components/ui';
import { WiringExportNotice, WiringSummaryButton } from '../components/wiringExport';
import PcbsTab from './tabs/PcbsTab';
import CablesTab from './tabs/CablesTab';
import ConnectorsTab from './tabs/ConnectorsTab';
import ConnectionsTab from './tabs/ConnectionsTab';
import SearchTab from './tabs/SearchTab';
import BuildTab, { buildKeys } from './tabs/BuildTab';
import { HistoryList } from '../components/history';
import { CompareProjects } from '../components/compare';
import { CommentThread } from '../components/comments';
import { ProjectAccessButton } from '../components/projectAccess';

const TABS = [
  { key: 'pcbs', label: 'Components' },
  { key: 'cables', label: 'Cables' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'connections', label: 'Connections' },
  { key: 'search', label: 'Search' },
  { key: 'build', label: 'Build' },
  { key: 'history', label: 'History' },
] as const;

export default function ProjectPage() {
  const { pid } = useParams() as { pid: string };
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'pcbs';
  const q = useProject(pid);
  const status = useQuery({
    queryKey: buildKeys.status(pid),
    queryFn: () => api.get<BuildStatus>(`/api/projects/${pid}/build-status`),
    refetchOnMount: 'always',
  }).data;

  if (!q.data) return <Loading error={q.error} />;
  const project = q.data;
  const locked = !!project.lockedAt;

  return (
    <div className={`page ${tab === 'build' ? 'page-build' : ''} ${tab === 'build' && params.get('view') === 'test' ? 'page-testmode' : ''}`}>
      <div className="crumbs">
        <Link to="/">Projects</Link> / <span>{project.name}</span>
      </div>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.machine && <div className="muted">{project.machine}</div>}
        </div>
        <div className="btn-row">
          <ProjectAccessButton project={project} />
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
            {t.key === 'build' && status && <BuildBadge status={status} />}
          </button>
        ))}
      </nav>
      {tab === 'pcbs' && <PcbsTab projectId={pid} locked={locked} />}
      {tab === 'cables' && <CablesTab />}
      {tab === 'connectors' && <ConnectorsTab />}
      {tab === 'connections' && <ConnectionsTab projectId={pid} locked={locked} />}
      {tab === 'search' && <SearchTab projectId={pid} />}
      {tab === 'build' && <BuildTab projectId={pid} projectName={project.name} />}
      {tab === 'history' && (
        <div className="panel">
          <h3>Project comments</h3>
          <CommentThread entityType="project" entityId={pid} projectId={pid} />
        </div>
      )}
      {tab === 'history' && (
        <div className="mt">
          <CompareProjects projectId={pid} />
        </div>
      )}
      {tab === 'history' && (
        <div className="panel mt">
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

/** Next to the Build tab: design errors, else checklist progress. */
function BuildBadge({ status }: { status: BuildStatus }) {
  if (status.failed > 0) {
    return (
      <span className="tab-badge tab-badge-error" title={`${status.failed} wire test(s) failed`}>
        ✗{status.failed}
      </span>
    );
  }
  if (status.checks.error > 0) {
    return (
      <span className="tab-badge tab-badge-error" title={`${status.checks.error} design error(s)`}>
        {status.checks.error}
      </span>
    );
  }
  if (!status.wires || !status.tested) return null;
  const pct = Math.round((status.tested / status.wires) * 100);
  return (
    <span className={`tab-badge ${pct === 100 ? 'tab-badge-ok' : ''}`} title={`${status.tested} of ${status.wires} wires tested`}>
      {pct}%
    </span>
  );
}
