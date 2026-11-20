import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type ConnectorType } from '../api';
import { Modal } from './ui';

interface Family {
  family: string;
  pitch: string;
  /** Housing part number for n pins. */
  housing: (n: number) => string;
  crimp: string;
  pins: number[];
  /** Rows for n pins (dual-row families). */
  rows?: (n: number) => number;
}

/** Common wire-to-board and wire-to-wire connectors, with the part numbers of the cable side. */
const FAMILIES: Family[] = [
  { family: 'JST XH', pitch: '2.5 mm', housing: (n) => `XHP-${n}`, crimp: 'SXH-001T-P0.6', pins: [2, 3, 4, 5, 6, 8] },
  { family: 'JST PH', pitch: '2.0 mm', housing: (n) => `PHR-${n}`, crimp: 'SPH-002T-P0.5S', pins: [2, 3, 4, 5, 6, 8] },
  { family: 'JST ZH', pitch: '1.5 mm', housing: (n) => `ZHR-${n}`, crimp: 'SZH-002T-P0.5', pins: [2, 3, 4, 5, 6] },
  { family: 'JST VH', pitch: '3.96 mm', housing: (n) => `VHR-${n}N`, crimp: 'SVH-21T-P1.1', pins: [2, 3, 4, 6] },
  { family: 'JST SM', pitch: '2.5 mm', housing: (n) => `SMP-0${n}V-BC`, crimp: 'SHF-001T-0.8BS', pins: [2, 3, 4] },
  { family: 'Molex KK 254', pitch: '2.54 mm', housing: (n) => `22-01-30${n}7`, crimp: '08-50-0114', pins: [2, 3, 4, 5, 6] },
  { family: 'Molex PicoBlade', pitch: '1.25 mm', housing: (n) => `51021-${String(n).padStart(2, '0')}00`, crimp: '50079-8000', pins: [2, 3, 4, 5, 6] },
  { family: 'Molex Micro-Fit 3.0', pitch: '3.0 mm', housing: (n) => `43025-${String(n).padStart(2, '0')}00`, crimp: '43030-0007', pins: [2, 4, 6, 8, 10, 12], rows: (n) => (n >= 4 ? 2 : 1) },
  { family: 'Molex Mini-Fit Jr', pitch: '4.2 mm', housing: (n) => `5557-${String(n).padStart(2, '0')}R`, crimp: '5556T', pins: [2, 4, 6, 8, 10, 24], rows: (n) => (n >= 4 ? 2 : 1) },
  { family: 'Dupont', pitch: '2.54 mm', housing: (n) => `1x${n} housing`, crimp: 'Dupont female', pins: [1, 2, 3, 4, 5, 6, 8] },
  { family: 'Deutsch DT', pitch: '', housing: (n) => `DT06-${n}S`, crimp: '0462-201-16141', pins: [2, 3, 4, 6, 8, 12] },
  { family: 'M12 A-coded', pitch: '', housing: (n) => `M12 ${n}-pin, field-wireable`, crimp: '', pins: [4, 5, 8] },
  { family: 'XT60', pitch: '', housing: () => 'XT60', crimp: '', pins: [2] },
  { family: 'XT30', pitch: '', housing: () => 'XT30', crimp: '', pins: [2] },
];

const nameOf = (f: Family, n: number) => `${f.family} ${n}-pin (${f.housing(n)})`;

/** Adds common connector types to the library in one go. */
export function ConnectorTemplatesModal({ existing, onClose }: { existing: ConnectorType[]; onClose: () => void }) {
  const qc = useQueryClient();
  const have = useMemo(() => new Set(existing.map((t) => t.name.trim().toLowerCase())), [existing]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };

  async function add() {
    setBusy(true);
    let added = 0;
    try {
      for (const f of FAMILIES) {
        for (const n of f.pins) {
          const name = nameOf(f, n);
          if (!picked.has(name) || have.has(name.toLowerCase())) continue;
          const fd = new FormData();
          fd.append('name', name);
          fd.append('pinCount', String(n));
          fd.append('rowCount', String(f.rows?.(n) ?? 1));
          fd.append('crimpName', f.crimp);
          await api.post('/api/connector-types', fd);
          added++;
        }
      }
      setDone(`Added ${added} connector type${added === 1 ? '' : 's'}.`);
      setPicked(new Set());
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['connectorTypes'] });
    }
  }

  return (
    <Modal title="Add common connectors" onClose={onClose} wide>
      <p className="small muted">
        Pick the sizes you use. Each becomes a connector type in the library with its housing part number and crimp, so the
        Build tab can count housings and crimps. Check the part numbers against your supplier; they can be edited later.
      </p>
      {done && <p className="restore-result">{done}</p>}
      <div className="template-grid">
        {FAMILIES.map((f) => (
          <div key={f.family} className="template-family">
            <strong>{f.family}</strong>
            <span className="small muted">{[f.pitch, f.crimp && `crimp ${f.crimp}`].filter(Boolean).join(' · ')}</span>
            <div className="template-pins">
              {f.pins.map((n) => {
                const name = nameOf(f, n);
                const exists = have.has(name.toLowerCase());
                return (
                  <label key={n} className={`chip ${exists ? 'chip-done' : ''}`} title={exists ? 'Already in the library' : name}>
                    <input type="checkbox" disabled={exists} checked={exists || picked.has(name)} onChange={() => toggle(name)} /> {n}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" disabled={!picked.size || busy} onClick={add}>
          {busy ? 'Adding…' : `Add ${picked.size || ''}`}
        </button>
      </div>
    </Modal>
  );
}
