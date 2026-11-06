import { useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Connection } from '../../api';
import { MiniDiagram } from '../../components/connectorConnections';
import { useFolders } from '../../components/folders';
import { Loading } from '../../components/ui';
import { searchConnections, type NodeHit } from '../../connectionSearch';

const PAGE = 24;
const MAX_HITS_SHOWN = 4;

export default function SearchTab({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const deferred = useDeferredValue(query);
  const [shown, setShown] = useState(PAGE);

  const q = useQuery({
    queryKey: ['connectionsFull', projectId],
    queryFn: () => api.get<Connection[]>(`/api/projects/${projectId}/connections/full`),
    staleTime: 0,
  });
  const foldersQ = useFolders(projectId, 'connections');
  const results = useMemo(
    () => (q.data ? searchConnections(q.data, foldersQ.data ?? [], deferred) : []),
    [q.data, foldersQ.data, deferred],
  );

  function setQuery(v: string) {
    setShown(PAGE);
    setParams(
      (p) => {
        if (v) p.set('q', v);
        else p.delete('q');
        return p;
      },
      { replace: true },
    );
  }

  if (!q.data) return <Loading error={q.error} />;

  return (
    <section>
      <div className="search-box">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search connections, e.g. "Motor", "1LC", "io1.in master duet"'
          aria-label="Search connections"
        />
        {deferred.trim() && (
          <span className="small muted nowrap">
            {results.length} connection{results.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {!deferred.trim() ? (
        <p className="muted small">
          Search the {q.data.length} connections of this project by component, connector, connector type, pin name, zone,
          folder, wire color or note. Several words narrow the search: "6HC Motor" finds connections that have both.
          Matching connectors are highlighted.
        </p>
      ) : results.length === 0 ? (
        <p className="empty">No connection matches "{deferred.trim()}".</p>
      ) : (
        <>
          <div className="search-results">
            {results.slice(0, shown).map((r) => (
              <MiniDiagram
                key={r.conn.id}
                conn={r.conn}
                highlight={r.highlight}
                to={`/projects/${projectId}/connections/${r.conn.id}`}
                info={<span className="small muted">{r.conn.wires.length} wires</span>}
              >
                <SearchHits hits={r.hits} />
              </MiniDiagram>
            ))}
          </div>
          {results.length > shown && (
            <div className="search-more">
              <button className="btn" onClick={() => setShown((n) => n + PAGE)}>
                Show more ({results.length - shown} left)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SearchHits({ hits }: { hits: NodeHit[] }) {
  if (!hits.length) return null;
  return (
    <ul className="search-hits small">
      {hits.slice(0, MAX_HITS_SHOWN).map((h) => (
        <li key={h.nodeId}>
          <strong>{h.name}</strong>
          {h.pins.length > 0 && (
            <ul>
              {h.pins.map((p) => (
                <li key={p.n}>
                  pin {p.n}
                  {p.name && <> {p.name}</>}
                  {p.to.length ? <span className="muted"> → {p.to.join(', ')}</span> : <span className="muted"> · not wired here</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
      {hits.length > MAX_HITS_SHOWN && <li className="muted">+{hits.length - MAX_HITS_SHOWN} more matching connectors</li>}
    </ul>
  );
}
