import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type Unit, type UnitStatus } from '../../../api';
import { useCan } from '../../../auth';
import { CommentThread } from '../../../components/comments';
import { ErrorText, Loading } from '../../../components/ui';
import { ProgressLine, unitsKey, useUnits } from './checklist';

const STATUSES: { key: UnitStatus; label: string }[] = [
  { key: 'building', label: 'Building' },
  { key: 'tested', label: 'Tested' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'retired', label: 'Retired' },
];

/** Machines built from this project, each with its own checklist, notes and comments. */
export function UnitsView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useUnits(projectId);
  const canEdit = useCan('projects.edit');
  const [serial, setSerial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [, setParams] = useSearchParams();

  const refresh = () => qc.invalidateQueries({ queryKey: unitsKey(projectId) });

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/units`, { serial });
      setSerial('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function patch(u: Unit, data: Partial<Pick<Unit, 'serial' | 'status' | 'notes'>>) {
    try {
      await api.patch(`/api/units/${u.id}`, data);
      await refresh();
    } catch (err) {
      alert(errorMessage(err));
    }
  }

  async function remove(u: Unit) {
    if (!confirm(`Delete unit ${u.serial}, with its checklist ticks and comments?`)) return;
    await api.del(`/api/units/${u.id}`);
    await refresh();
  }

  const openIn = (u: Unit, view: 'checklist' | 'test') =>
    setParams(
      (p) => {
        p.set('view', view);
        p.set('unit', u.id);
        return p;
      },
      { replace: true },
    );

  if (!q.data) return <Loading error={q.error} />;
  const nextSerial = suggestSerial(q.data.map((u) => u.serial));
  return (
    <div>
      <p className="small muted">
        A unit is one machine built from this project (e.g. serial RC4-003). Each unit has its own checklist and test results,
        notes and comments ("J3 replaced on this one"). Lock the project once the design is final, then add a unit per machine.
      </p>
      {canEdit && (
        <form onSubmit={add} className="input-row">
          <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder={`Serial, e.g. ${nextSerial}`} maxLength={100} />
          <button className="btn btn-primary" disabled={!serial.trim()}>
            + Add unit
          </button>
        </form>
      )}
      <ErrorText error={error} />
      {q.data.length === 0 && <p className="empty mt">No units yet. Without units, the checklist belongs to the project itself.</p>}
      <div className="unit-list mt">
        {q.data.map((u) => (
          <div key={u.id} className={`panel unit unit-${u.status}`}>
            <div className="unit-head">
              <strong className="unit-serial">{u.serial}</strong>
              <select
                value={u.status}
                disabled={!canEdit}
                onChange={(e) => patch(u, { status: e.target.value as UnitStatus })}
                aria-label="Status"
              >
                {STATUSES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <span className="grow" />
              <button className="btn btn-sm" onClick={() => openIn(u, 'checklist')}>
                Checklist
              </button>
              <button className="btn btn-sm" onClick={() => openIn(u, 'test')}>
                📱 Test
              </button>
              <button className="btn btn-sm" onClick={() => setOpen(open === u.id ? null : u.id)}>
                {open === u.id ? 'Close' : 'Notes & comments'}
              </button>
              {canEdit && (
                <button className="btn btn-sm btn-danger" onClick={() => remove(u)}>
                  Delete
                </button>
              )}
            </div>
            <div className="progress-grid">
              <ProgressLine label="Crimped" done={u.crimped} total={u.wires} />
              <ProgressLine label="Tested" done={u.tested} total={u.wires} failed={u.failed} />
            </div>
            {open === u.id && (
              <div className="unit-body">
                <label className="field">
                  <span className="field-label">Notes</span>
                  <textarea
                    rows={3}
                    defaultValue={u.notes}
                    disabled={!canEdit}
                    placeholder="e.g. customer, ship date, deviations from the design"
                    onBlur={(e) => e.target.value !== u.notes && patch(u, { notes: e.target.value })}
                  />
                </label>
                <h4>Comments</h4>
                <CommentThread entityType="unit" entityId={u.id} projectId={projectId} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Next serial in the series: "RC4-003" after "RC4-002". */
function suggestSerial(serials: string[]) {
  const last = [...serials].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (!last) return 'SN-001';
  const m = /^(.*?)(\d+)$/.exec(last);
  if (!m) return `${last}-2`;
  return `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}`;
}
