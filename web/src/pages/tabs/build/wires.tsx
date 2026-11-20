import { useDeferredValue, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api';
import { useCan } from '../../../auth';
import { colorLabel } from '../../../colors';
import { useFolders } from '../../../components/folders';
import { useAskReason } from '../../../components/reason';
import { ColorPicker, Loading, Swatch } from '../../../components/ui';
import { useWireChecks } from '../../../checkQueue';

const GAUGES = ['30 AWG', '28 AWG', '26 AWG', '24 AWG', '22 AWG', '20 AWG', '18 AWG', '16 AWG', '14 AWG', '0.14 mm²', '0.25 mm²', '0.5 mm²', '0.75 mm²', '1 mm²', '1.5 mm²', '2.5 mm²'];

type Missing = '' | 'gauge' | 'length' | 'color';

/** Every wire of the project in one table, to fill in gauge, length or color for many at once. */
export function WiresView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const ask = useAskReason();
  const canEdit = useCan('projects.edit');
  const { data, error } = useWireChecks(projectId, '');
  const folders = useFolders(projectId, 'connections').data ?? [];
  const [folder, setFolder] = useState('');
  const [conn, setConn] = useState('');
  const [missing, setMissing] = useState<Missing>('');
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim().toLowerCase());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gauge, setGauge] = useState('');
  const [length, setLength] = useState('');
  const [color, setColor] = useState('');
  const [shielded, setShielded] = useState<'' | 'yes' | 'no'>('');

  const shown = useMemo(() => {
    if (!data) return [];
    const connFolder = new Map(data.connections.map((c) => [c.id, c.folderId]));
    return data.wires.filter((w) => {
      if (conn && w.connectionId !== conn) return false;
      if (folder && connFolder.get(w.connectionId) !== (folder === 'none' ? null : folder)) return false;
      if (missing === 'gauge' && w.gauge) return false;
      if (missing === 'length' && w.lengthMm != null) return false;
      if (missing === 'color' && w.color) return false;
      if (query && ![w.ref, w.connectionName, w.from.text, w.to.text, w.color, w.gauge, w.note].join(' ').toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, conn, folder, missing, query]);

  if (!data) return <Loading error={error} />;

  const allShownSelected = shown.length > 0 && shown.every((w) => selected.has(w.id));
  const toggleAll = () => {
    const next = new Set(selected);
    for (const w of shown) {
      if (allShownSelected) next.delete(w.id);
      else next.add(w.id);
    }
    setSelected(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const set: Record<string, unknown> = {};
  if (gauge.trim()) set.gauge = gauge.trim();
  if (length.trim()) set.lengthMm = Number(length);
  if (color) set.color = color;
  if (shielded) set.shielded = shielded === 'yes';
  const lengthOk = !length.trim() || (Number.isFinite(Number(length)) && Number(length) >= 0);
  const changes = [
    set.gauge && `gauge ${set.gauge}`,
    set.lengthMm != null && `length ${set.lengthMm} mm`,
    set.color && `color ${colorLabel(String(set.color))}`,
    set.shielded != null && (set.shielded ? 'shielded' : 'not shielded'),
  ].filter(Boolean);

  async function apply() {
    const ids = [...selected];
    await ask({
      title: `Change ${ids.length} wire${ids.length > 1 ? 's' : ''}`,
      message: `Set ${changes.join(', ')}. Each connection touched gets an entry in its history. Checklist ticks of wires whose gauge or color changes have to be made again.`,
      confirmLabel: 'Change',
      action: async (reason) => {
        await api.post(`/api/projects/${projectId}/bulk-wires`, { wireIds: ids, set, reason });
        setSelected(new Set());
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['project-wires', projectId] }),
          qc.invalidateQueries({ queryKey: ['checks', projectId] }),
          qc.invalidateQueries({ queryKey: ['build-list', projectId] }),
          qc.invalidateQueries({ queryKey: ['build-status', projectId] }),
        ]);
      },
    });
  }

  const noGauge = data.wires.filter((w) => !w.gauge).length;
  const noLength = data.wires.filter((w) => w.lengthMm == null).length;
  return (
    <div>
      <p className="small muted">
        All {data.wires.length} wires of the project. {noGauge > 0 && <>{noGauge} have no gauge. </>}
        {noLength > 0 && <>{noLength} have no length. </>}Filter, tick the wires, and set their gauge, length, color or shielding
        in one go. A wire's own length overrides its connection's length.
      </p>
      <div className="filter-row">
        <input type="search" placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} />
        {folders.length > 0 && (
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
            <option value="">All folders</option>
            <option value="none">Not in a folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        <select value={conn} onChange={(e) => setConn(e.target.value)} aria-label="Connection">
          <option value="">All connections</option>
          {data.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={missing} onChange={(e) => setMissing(e.target.value as Missing)} aria-label="Missing">
          <option value="">Any wire</option>
          <option value="gauge">Without gauge</option>
          <option value="length">Without length</option>
          <option value="color">Without color</option>
        </select>
      </div>

      {canEdit && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <input list="gauge-presets" value={gauge} onChange={(e) => setGauge(e.target.value)} placeholder="Gauge" className="gauge-input" />
          <datalist id="gauge-presets">
            {GAUGES.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <span className="input-row">
            <input value={length} onChange={(e) => setLength(e.target.value)} placeholder="Length" className="length-input" inputMode="numeric" /> mm
          </span>
          <ColorPicker value={color} onChange={setColor} />
          <select value={shielded} onChange={(e) => setShielded(e.target.value as '' | 'yes' | 'no')} aria-label="Shielded">
            <option value="">Shielding: keep</option>
            <option value="yes">Shielded</option>
            <option value="no">Not shielded</option>
          </select>
          <button className="btn btn-primary" disabled={!changes.length || !lengthOk} onClick={apply}>
            Apply
          </button>
          <button className="btn-link small" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="table-wrap mt">
        <table className="table">
          <thead>
            <tr>
              {canEdit && (
                <th>
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown" />
                </th>
              )}
              <th>Wire</th>
              <th>Connection</th>
              <th>From → To</th>
              <th>Color</th>
              <th>Gauge</th>
              <th className="right">Length</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id} className={selected.has(w.id) ? 'row-selected' : ''} onClick={() => canEdit && toggle(w.id)}>
                {canEdit && (
                  <td>
                    <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} onClick={(e) => e.stopPropagation()} aria-label={w.ref} />
                  </td>
                )}
                <td className="nowrap">
                  <strong>{w.ref}</strong>
                </td>
                <td className="small">{w.connectionName}</td>
                <td className="small">
                  {w.from.short} → {w.to.short}
                </td>
                <td className="nowrap">
                  <span className="swatches">
                    <Swatch color={w.color} size={12} /> <span className="small">{colorLabel(w.color)}</span>
                  </span>
                </td>
                <td className="nowrap">{w.gauge || <em className="muted small">—</em>}</td>
                <td className="right nowrap">{w.lengthMm != null ? `${w.lengthMm} mm` : <em className="muted small">—</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="empty">No wires match.</p>}
      </div>
    </div>
  );
}
