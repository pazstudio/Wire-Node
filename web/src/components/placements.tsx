import { useState } from 'react';
import { imgUrl, type Placement } from '../api';

/** Checkable grid of the components placed in a project (chooses which ones a connection uses). */
export function PlacementPicker({
  placements,
  selected,
  onChange,
}: {
  placements: Placement[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = placements.filter((p) => {
    const hay = `${p.name} ${p.pcb.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const chosen = new Set(selected);

  function toggle(id: string) {
    onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  if (placements.length === 0) {
    return <p className="small muted">This project has no components yet. Add them on the Components tab first.</p>;
  }

  return (
    <div className="placement-picker">
      <div className="search-box">
        {placements.length > 6 && (
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search components…"
            aria-label="Search components"
          />
        )}
        <span className="small muted nowrap">{selected.length} selected</span>
      </div>
      <div className="placement-grid">
        {shown.map((p) => {
          const on = chosen.has(p.id);
          const count = p.pcb._count?.connectors;
          return (
            <label key={p.id} className={`placement-tile ${on ? 'on' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
              <img src={imgUrl(p.pcb.thumbPath)} alt="" loading="lazy" />
              <span className="placement-tile-text">
                <strong>{p.name}</strong>
                {count !== undefined && (
                  <span className="small muted">
                    {count} connector{count === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {shown.length === 0 && <p className="small muted">No components match “{search}”.</p>}
      </div>
    </div>
  );
}
