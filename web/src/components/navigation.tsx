import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ConnectionSummary, type Placement, type Project } from '../api';
import { useRecents, type RecentEntry } from '../recents';
import { useProject } from './lock';

// ---------- Data ----------

/** Project id of the current page, if it belongs to a project. */
export function useCurrentProjectId(): string | undefined {
  return useMatch('/projects/:pid/*')?.params.pid;
}

/** Components and connections of a project (the same queries as the project tabs, so they share the cache). */
function useProjectIndex(projectId: string | undefined) {
  const placements = useQuery({
    queryKey: ['projectPcbs', projectId],
    queryFn: () => api.get<Placement[]>(`/api/projects/${projectId}/pcbs`),
    enabled: !!projectId,
  });
  const connections = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => api.get<ConnectionSummary[]>(`/api/projects/${projectId}/connections`),
    enabled: !!projectId,
  });
  return { placements: placements.data, connections: connections.data };
}

type ItemKind = 'pcb' | 'connection' | 'project' | 'page';

interface NavItem {
  key: string;
  kind: ItemKind;
  title: string;
  subtitle?: string;
  to: string;
}

const KIND_ICON: Record<ItemKind, string> = { pcb: '▣', connection: '⇄', project: '▤', page: '→' };
const KIND_LABEL: Record<ItemKind, string> = {
  pcb: 'component',
  connection: 'connection',
  project: 'project',
  page: 'page',
};

const pcbUrl = (pid: string, pcbId: string) => `/projects/${pid}/pcbs/${pcbId}`;
const connUrl = (pid: string, cid: string) => `/projects/${pid}/connections/${cid}`;

function projectPages(pid: string): NavItem[] {
  return [
    { key: 'p-pcbs', kind: 'page', title: 'Components', to: `/projects/${pid}?tab=pcbs` },
    { key: 'p-connections', kind: 'page', title: 'Connections', to: `/projects/${pid}?tab=connections` },
    { key: 'p-map', kind: 'page', title: 'Project map', to: `/projects/${pid}/map` },
    { key: 'p-search', kind: 'page', title: 'Search connections', to: `/projects/${pid}?tab=search` },
    { key: 'p-cables', kind: 'page', title: 'Cables', to: `/projects/${pid}?tab=cables` },
    { key: 'p-connectors', kind: 'page', title: 'Connectors', to: `/projects/${pid}?tab=connectors` },
  ];
}

/**
 * Recents of a project with their current names. Entries whose component or connection
 * no longer exists in the project are dropped once the project lists have loaded.
 */
function useResolvedRecents(projectId: string | undefined): NavItem[] {
  const recents = useRecents(projectId);
  const { placements, connections } = useProjectIndex(projectId);
  return useMemo(() => {
    if (!projectId) return [];
    const out: NavItem[] = [];
    for (const r of recents) {
      const item = resolveRecent(projectId, r, placements, connections);
      if (item) out.push(item);
    }
    return out;
  }, [projectId, recents, placements, connections]);
}

function resolveRecent(
  pid: string,
  r: RecentEntry,
  placements: Placement[] | undefined,
  connections: ConnectionSummary[] | undefined,
): NavItem | null {
  if (r.kind === 'pcb') {
    let title = r.name;
    if (placements) {
      const p = placements.find((x) => x.pcbId === r.id);
      if (!p) return null;
      title = p.name;
    }
    return { key: `r-pcb-${r.id}`, kind: 'pcb', title, to: pcbUrl(pid, r.id) };
  }
  let title = r.name;
  if (connections) {
    const c = connections.find((x) => x.id === r.id);
    if (!c) return null;
    title = c.name;
  }
  return { key: `r-conn-${r.id}`, kind: 'connection', title, to: connUrl(pid, r.id) };
}

// ---------- Matching ----------

const PREFIXES: Record<string, ItemKind> = { c: 'pcb', w: 'connection', p: 'project' };

/** "w: motor" -> only connections, words ["motor"]. */
function parseQuery(query: string): { kind: ItemKind | null; words: string[] } {
  const m = /^\s*([cwp]):\s*(.*)$/i.exec(query);
  const kind = m ? PREFIXES[m[1].toLowerCase()] : null;
  const text = m ? m[2] : query;
  return { kind, words: text.toLowerCase().split(/\s+/).filter(Boolean) };
}

/** 0 = no match; higher is better. Every word must appear in the title or subtitle. */
function score(item: NavItem, words: string[]): number {
  const title = item.title.toLowerCase();
  const hay = `${title} ${(item.subtitle ?? '').toLowerCase()}`;
  if (!words.every((w) => hay.includes(w))) return 0;
  let s = 1;
  if (words.every((w) => title.includes(w))) s += 2;
  if (title.startsWith(words[0])) s += 3;
  else if (title.includes(` ${words[0]}`) || title.includes(`-${words[0]}`)) s += 1;
  return s;
}

// ---------- Quick switcher ----------

interface Section {
  label: string;
  items: NavItem[];
}

const PER_SECTION = 8;

function useSwitcherSections(query: string): Section[] {
  const pid = useCurrentProjectId();
  const { placements, connections } = useProjectIndex(pid);
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const recents = useResolvedRecents(pid);

  return useMemo(() => {
    const components: NavItem[] = pid
      ? (placements ?? []).map((p) => ({
          key: `pl-${p.id}`,
          kind: 'pcb' as const,
          title: p.name,
          subtitle: p.name !== p.pcb.name ? p.pcb.name : undefined,
          to: pcbUrl(pid, p.pcbId),
        }))
      : [];
    const conns: NavItem[] = pid
      ? (connections ?? []).map((c) => ({
          key: `c-${c.id}`,
          kind: 'connection' as const,
          title: c.name,
          subtitle: [...new Set(c.endpoints)].join(' · '),
          to: connUrl(pid, c.id),
        }))
      : [];
    const projects: NavItem[] = (projectsQ.data ?? []).map((p) => ({
      key: `pr-${p.id}`,
      kind: 'project' as const,
      title: p.name,
      subtitle: p.machine || undefined,
      to: `/projects/${p.id}`,
    }));
    const pages: NavItem[] = [
      ...(pid ? projectPages(pid) : []),
      { key: 'g-projects', kind: 'page', title: 'All projects', to: '/' },
      { key: 'g-backup', kind: 'page', title: 'Backup & restore', to: '/backup' },
    ];

    const { kind, words } = parseQuery(query);

    if (!words.length && !kind) {
      return [
        { label: 'Recent', items: recents.slice(0, PER_SECTION) },
        { label: pid ? 'Go to' : 'Pages', items: pages },
        ...(pid ? [] : [{ label: 'Projects', items: projects.slice(0, PER_SECTION) }]),
      ].filter((s) => s.items.length);
    }

    const rank = (items: NavItem[], limit = PER_SECTION) =>
      items
        .map((item, i) => ({ item, s: words.length ? score(item, words) : 1, i }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, kind ? 50 : limit)
        .map((x) => x.item);

    const sections: Section[] = [
      { label: 'Components', items: !kind || kind === 'pcb' ? rank(components) : [] },
      { label: 'Connections', items: !kind || kind === 'connection' ? rank(conns) : [] },
      { label: 'Projects', items: !kind || kind === 'project' ? rank(projects, 5) : [] },
      { label: 'Pages', items: !kind ? rank(pages, 5) : [] },
    ];
    return sections.filter((s) => s.items.length);
  }, [query, pid, placements, connections, projectsQ.data, recents]);
}

function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const sections = useSwitcherSections(query);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const listRef = useRef<HTMLDivElement>(null);
  const pid = useCurrentProjectId();

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(item: NavItem | undefined) {
    if (!item) return;
    onClose();
    navigate(item.to);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  let index = 0;
  return (
    <div className="qs-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs" role="dialog" aria-label="Go to">
        <input
          className="qs-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={pid ? 'Go to a component, connection, project or page…' : 'Go to a project or page…'}
          aria-label="Search"
          role="combobox"
          aria-expanded="true"
          aria-controls="qs-list"
          aria-activedescendant={flat[active] ? `qs-${flat[active].key}` : undefined}
        />
        <div className="qs-list" id="qs-list" role="listbox" ref={listRef}>
          {sections.length === 0 && <p className="qs-empty">Nothing matches "{query.trim()}".</p>}
          {sections.map((s) => (
            <div key={s.label} role="group" aria-label={s.label}>
              <div className="qs-section">{s.label}</div>
              {s.items.map((item) => {
                const i = index++;
                return (
                  <div
                    key={item.key}
                    id={`qs-${item.key}`}
                    role="option"
                    aria-selected={i === active}
                    className={`qs-item ${i === active ? 'active' : ''}`}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => go(item)}
                  >
                    <span className="qs-icon" aria-hidden title={KIND_LABEL[item.kind]}>
                      {KIND_ICON[item.kind]}
                    </span>
                    <span className="qs-text">
                      <span className="qs-title">{item.title}</span>
                      {item.subtitle && <span className="qs-sub">{item.subtitle}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="qs-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
          </span>
          <span>
            {pid && (
              <>
                <kbd>c:</kbd> components · <kbd>w:</kbd> connections ·{' '}
              </>
            )}
            <kbd>p:</kbd> projects
          </span>
        </div>
      </div>
    </div>
  );
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Top-bar search button and the quick switcher it opens (also Ctrl+K, or / when not typing). */
export function QuickSwitcherButton() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close when something else navigates (e.g. browser back).
  useEffect(() => setOpen(false), [location.key]);

  return (
    <>
      <button className="topbar-search" onClick={() => setOpen(true)} title="Go to… (Ctrl+K or /)">
        <span aria-hidden>⌕</span>
        <span className="topbar-search-text">Go to…</span>
        <kbd className="topbar-search-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && <QuickSwitcher onClose={() => setOpen(false)} />}
    </>
  );
}

// ---------- Top-bar project menu ----------

/** Current project in the top bar, with a menu of its pages and recent items. */
export function ProjectMenu() {
  const pid = useCurrentProjectId();
  if (!pid) return null;
  return <ProjectMenuInner key={pid} projectId={pid} />;
}

function ProjectMenuInner({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);
  const recents = useResolvedRecents(projectId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.key]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = location.pathname + location.search;
  const pages = projectPages(projectId).slice(0, 4);

  return (
    <div className="project-menu" ref={ref}>
      <span className="topbar-sep" aria-hidden>
        /
      </span>
      <button
        className="project-menu-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Pages and recent items of this project"
      >
        <span className="project-menu-name">{projectQ.data?.name ?? '…'}</span>
        {projectQ.data?.lockedAt && <span aria-label="locked"> 🔒</span>}
        <span aria-hidden className="project-menu-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="project-menu-pop" role="menu">
          <div className="menu-section">Project</div>
          <Link role="menuitem" className="menu-item" to={`/projects/${projectId}`}>
            <span className="qs-icon">▤</span> Overview
          </Link>
          {pages.map((p) => (
            <Link
              key={p.key}
              role="menuitem"
              className={`menu-item ${current === p.to ? 'active' : ''}`}
              to={p.to}
            >
              <span className="qs-icon">{KIND_ICON.page}</span> {p.title}
            </Link>
          ))}
          {recents.length > 0 && (
            <>
              <div className="menu-section">Recent</div>
              {recents.slice(0, 6).map((r) => (
                <Link
                  key={r.key}
                  role="menuitem"
                  className={`menu-item ${location.pathname === r.to ? 'active' : ''}`}
                  to={r.to}
                >
                  <span className="qs-icon">{KIND_ICON[r.kind]}</span> <span className="menu-item-text">{r.title}</span>
                </Link>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Project page / breadcrumbs ----------

/** "Recent: ▣ Duet 6HC  ⇄ Toolhead harness …" above the project tabs. */
export function RecentStrip({ projectId }: { projectId: string }) {
  const recents = useResolvedRecents(projectId);
  if (!recents.length) return null;
  return (
    <div className="recent-strip no-print">
      <span className="recent-label">Recent</span>
      {recents.slice(0, 8).map((r) => (
        <Link key={r.key} to={r.to} className="recent-chip" title={`Open ${KIND_LABEL[r.kind]} "${r.title}"`}>
          <span aria-hidden className="recent-icon">
            {KIND_ICON[r.kind]}
          </span>
          {r.title}
        </Link>
      ))}
    </div>
  );
}

/** Link to the project overview, labelled with the project name. */
export function ProjectCrumb({ projectId }: { projectId: string }) {
  const q = useProject(projectId);
  return <Link to={`/projects/${projectId}`}>{q.data?.name ?? 'Project'}</Link>;
}
