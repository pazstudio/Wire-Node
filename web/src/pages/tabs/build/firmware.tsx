import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadText, errorMessage, slug, type Placement } from '../../../api';
import { useCan } from '../../../auth';
import { Loading } from '../../../components/ui';

const CONTROLLER = /duet|octopus|skr|spider|manta|ebb|toolboard|\b1lc\b|\b3hc\b|\b6hc\b|\b6xd\b|mini ?5|mainboard|controller/i;

/** Draft firmware config (RepRapFirmware or Klipper) from what is wired to the controller ports. */
export function FirmwareView({ projectId, projectName }: { projectId: string; projectName: string }) {
  const qc = useQueryClient();
  const canEdit = useCan('projects.edit');
  const [format, setFormat] = useState<'rrf' | 'klipper'>('rrf');
  const [showAll, setShowAll] = useState(false);
  const placements = useQuery({
    queryKey: ['placements', projectId],
    queryFn: () => api.get<Placement[]>(`/api/projects/${projectId}/pcbs`),
  });
  const cfg = useQuery({
    queryKey: ['firmware', projectId, format],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/firmware?format=${format}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.text();
    },
    refetchOnMount: 'always',
  });

  async function setAddress(p: Placement, fwAddress: string) {
    if ((p.fwAddress ?? '') === fwAddress.trim()) return;
    try {
      await api.patch(`/api/project-pcbs/${p.id}`, { fwAddress });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['placements', projectId] }),
        qc.invalidateQueries({ queryKey: ['firmware', projectId] }),
      ]);
    } catch (e) {
      alert(errorMessage(e));
    }
  }

  const boards = (placements.data ?? []).filter((p) => showAll || p.fwAddress || CONTROLLER.test(`${p.name} ${p.pcb.name}`));
  return (
    <div>
      <p className="small muted">
        A starting point for the firmware configuration, written from which device is wired to which controller port. Ports
        are recognised from connector labels (Duet: Driver 0, TEMP 1, OUT 3, IO_0; Klipper boards: M0, HE0, FAN0, T0) and
        devices from the names of what is wired to them. <strong>Check every line</strong> against the board documentation
        before using it.
      </p>
      <div className="panel">
        <h3>Controller boards</h3>
        <p className="small muted">
          RepRapFirmware: the CAN address of each board (empty or 0 = main board, e.g. 1 for a 3HC expansion board, 20 for a
          1LC toolboard). Klipper: the MCU name of extra boards (e.g. ebb), empty for the main MCU.
        </p>
        {!placements.data ? (
          <Loading error={placements.error} />
        ) : (
          <table className="table small">
            <tbody>
              {boards.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.name !== p.pcb.name && <span className="muted"> · {p.pcb.name}</span>}
                  </td>
                  <td className="right">
                    <input
                      key={p.fwAddress ?? ''}
                      defaultValue={p.fwAddress ?? ''}
                      disabled={!canEdit}
                      placeholder="main"
                      className="length-input"
                      aria-label={`Board address of ${p.name}`}
                      onBlur={(e) => setAddress(p, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                </tr>
              ))}
              {boards.length === 0 && (
                <tr>
                  <td className="muted">No controller boards recognised by name.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <label className="small inline-check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all components
        </label>
      </div>
      <div className="section-head">
        <span className="seg">
          <button className={format === 'rrf' ? 'active' : ''} onClick={() => setFormat('rrf')}>
            RepRapFirmware
          </button>
          <button className={format === 'klipper' ? 'active' : ''} onClick={() => setFormat('klipper')}>
            Klipper
          </button>
        </span>
        <span className="btn-row">
          <button className="btn" disabled={!cfg.data} onClick={() => cfg.data && navigator.clipboard?.writeText(cfg.data)}>
            Copy
          </button>
          <button
            className="btn"
            disabled={!cfg.data}
            onClick={() => cfg.data && downloadText(`${slug(projectName)}-${format === 'rrf' ? 'config.g' : 'printer.cfg'}`, cfg.data)}
          >
            Download
          </button>
        </span>
      </div>
      {cfg.data ? <pre className="code-block firmware-code">{cfg.data}</pre> : <Loading error={cfg.error} />}
    </div>
  );
}
