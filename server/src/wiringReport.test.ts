import { describe, expect, it } from 'vitest';
import { buildWiringReport, type WiringRows } from './wiringReport.js';

function rows(): WiringRows {
  return {
    projects: [{ id: 'p', name: 'Printer', machine: 'CoreXY', description: '' }],
    cables: [{ id: 'cab', name: '4x0.25' }],
    connectorTypes: [{ id: 'xh4', name: 'JST-XH 4P', pinCount: 4, crimpName: '' }],
    pcbs: [
      { id: 'octo', name: 'Octopus', description: 'Main board' },
      { id: 'mot', name: 'Stepper', description: '' },
    ],
    folders: [],
    projectPcbs: [
      { id: 'pp1', projectId: 'p', pcbId: 'octo', name: '' },
      { id: 'pp2', projectId: 'p', pcbId: 'mot', name: 'X motor' },
    ],
    pcbConnectors: [
      { id: 'm0', pcbId: 'octo', connectorTypeId: 'xh4', label: 'M0', name: 'Motor 0', pins: [{ n: 1, name: '2B' }, { n: 2, name: '2A' }] },
      { id: 'm1', pcbId: 'octo', connectorTypeId: 'xh4', label: 'M1', name: 'Motor 1', pins: [] },
      { id: 'mc', pcbId: 'mot', connectorTypeId: null, label: 'J1', name: '', pins: [{ n: 1, name: 'B+' }, { n: 2, name: 'A+' }] },
    ],
    connections: [{ id: 'c', projectId: 'p', name: 'X motor cable', kind: 'harness', description: '' }],
    connectionNodes: [
      { id: 'n1', connectionId: 'c', pcbConnectorId: 'm0', projectPcbId: 'pp1', label: '' },
      { id: 'n2', connectionId: 'c', pcbConnectorId: null, projectPcbId: null, label: 'Frame plug', pinCount: 2 },
      { id: 'n3', connectionId: 'c', pcbConnectorId: 'mc', projectPcbId: 'pp2', label: '' },
    ],
    wires: [
      { id: 'w1', connectionId: 'c', fromNodeId: 'n1', fromPin: 1, toNodeId: 'n2', toPin: 1, cableId: 'cab', coreIndex: 0, color: 'red' },
      { id: 'w2', connectionId: 'c', fromNodeId: 'n2', fromPin: 1, toNodeId: 'n3', toPin: 1, color: 'red', note: '' },
    ],
  };
}

describe('buildWiringReport', () => {
  const md = buildWiringReport(rows(), 'p', '2026-01-01T00:00:00.000Z')!;

  it('covers only the requested project', () => {
    const r = rows();
    r.projects.push({ id: 'q', name: 'Other machine' });
    r.projectPcbs.push({ id: 'pp3', projectId: 'q', pcbId: 'octo', name: 'Other board' });
    r.connections.push({ id: 'c2', projectId: 'q', name: 'Other cable', kind: 'direct' });
    const out = buildWiringReport(r, 'p')!;
    expect(out).toContain('# Wiring: Printer');
    expect(out).not.toContain('Other');
    expect(buildWiringReport(r, 'missing')).toBeNull();
  });

  it('follows wires through inline connectors to the far board pin', () => {
    expect(md).toContain(
      '  - pin 1 "2B" → X motor › J1 pin 1 "B+" (via inline connector "Frame plug" pin 1) — connection "X motor cable"',
    );
    expect(md).toContain('  - pin 2 "2A": not connected');
  });

  it('marks unused connectors as free and numbers their pins from the type', () => {
    expect(md).toContain('- **M1** — Motor 1 · JST-XH 4P (4 pins) · **FREE**');
    expect(md).toContain('- Octopus › M1 — Motor 1 · JST-XH 4P (4 pins)');
    expect(md).toContain('  - pin 4: not connected');
  });

  it('lists each wire of a connection with its details', () => {
    expect(md).toContain('- Octopus › M0 "Motor 0" pin 1 "2B" → inline connector "Frame plug" pin 1 [red, cable "4x0.25" core 1]');
  });
});
