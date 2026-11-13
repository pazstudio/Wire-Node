import { describe, expect, it } from 'vitest';
import { arrangeByFolders, type Arrangement } from './mapLayout.js';

const BLOCK = { w: 200, h: 180 };

function rectOf(a: Arrangement, id: string) {
  const p = a.positions.find((q) => q.id === id)!;
  return { x: p.mapX, y: p.mapY, w: BLOCK.w, h: BLOCK.h };
}

const inside = (z: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }) =>
  r.x >= z.x && r.y >= z.y && r.x + r.w <= z.x + z.w && r.y + r.h <= z.y + z.h;

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('arrangeByFolders', () => {
  const folders = [
    { id: 'f1', name: 'Toolhead' },
    { id: 'f2', name: 'Frame' },
    { id: 'f3', name: 'Empty' },
  ];
  const placements = [
    { id: 'a', name: 'Hotend', folderId: 'f1' },
    { id: 'b', name: 'Fan', folderId: 'f1' },
    { id: 'c', name: 'Thermistor', folderId: 'f1' },
    { id: 'd', name: 'Mainboard', folderId: 'f2' },
    { id: 'e', name: 'PSU', folderId: 'f2' },
    { id: 'f', name: 'Display', folderId: null },
  ];

  it('makes one zone per non-empty folder with its components inside', () => {
    const a = arrangeByFolders(placements, folders, [], []);
    expect(a.zones.map((z) => z.name).sort()).toEqual(['Frame', 'Toolhead']);
    expect(a.positions).toHaveLength(placements.length);
    for (const p of placements.filter((q) => q.folderId)) {
      const zone = a.zones.find((z) => z.name === folders.find((f) => f.id === p.folderId)!.name)!;
      expect(inside(zone, rectOf(a, p.id))).toBe(true);
    }
  });

  it('keeps zones, blocks and loose components from overlapping', () => {
    const a = arrangeByFolders(placements, folders, [], []);
    for (const z of a.zones) for (const y of a.zones) if (z !== y) expect(overlap(z, y)).toBe(false);
    const ids = placements.map((p) => p.id);
    for (const i of ids) for (const j of ids) if (i !== j) expect(overlap(rectOf(a, i), rectOf(a, j))).toBe(false);
    for (const z of a.zones) expect(overlap(z, rectOf(a, 'f'))).toBe(false);
  });

  it('reuses an existing zone with the folder name (ignoring case) and its color', () => {
    const a = arrangeByFolders(placements, folders, [{ id: 'z1', name: ' toolhead ', color: '#123456', w: 1, h: 1 }], []);
    const zone = a.zones.find((z) => z.name === 'Toolhead')!;
    expect(zone).toMatchObject({ id: 'z1', color: '#123456' });
    expect(a.zones.find((z) => z.name === 'Frame')!.id).toBeNull();
    expect(a.zones.find((z) => z.name === 'Frame')!.color).not.toBe('#123456');
  });

  it('lays out a project without folders as a grid', () => {
    const loose = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, folderId: null }));
    const a = arrangeByFolders(loose, [], [], []);
    expect(a.zones).toEqual([]);
    expect(new Set(a.positions.map((p) => p.mapX)).size).toBe(3);
    expect(new Set(a.positions.map((p) => p.mapY)).size).toBe(3);
  });

  it('puts folders that share wires next to each other', () => {
    const fs = ['A', 'B', 'C', 'D'].map((n) => ({ id: n, name: n }));
    const ps = fs.flatMap((f) => [1, 2, 3, 4].map((i) => ({ id: `${f.id}${i}`, name: `${f.id}${i}`, folderId: f.id })));
    // A is wired to D only; B and C are not wired to anything.
    const a = arrangeByFolders(ps, fs, [], [{ source: 'A1', target: 'D1', wireCount: 5 }]);
    expect(a.zones.slice(0, 2).map((z) => z.name)).toEqual(['A', 'D']);
  });
});

describe('arrangeByFolders other zones', () => {
  it('moves zones not named after a folder next to the layout, keeping their size', () => {
    const ps = [{ id: 'a', name: 'A', folderId: 'f' }];
    const a = arrangeByFolders(ps, [{ id: 'f', name: 'F' }], [{ id: 'old', name: 'Power line', color: '#000000', w: 900, h: 700 }], []);
    const f = a.zones.find((z) => z.name === 'F')!;
    const old = a.zones.find((z) => z.id === 'old')!;
    expect(old).toMatchObject({ name: 'Power line', color: '#000000', w: 900, h: 700 });
    expect(overlap(f, old)).toBe(false);
  });
});

describe('arrangeByFolders order inside a zone', () => {
  it('puts the most wired component first', () => {
    const ps = ['A', 'B', 'Hub'].map((n) => ({ id: n, name: n, folderId: 'f' }));
    const a = arrangeByFolders(ps, [{ id: 'f', name: 'F' }], [], [
      { source: 'Hub', target: 'A', wireCount: 2 },
      { source: 'Hub', target: 'B', wireCount: 2 },
    ]);
    const first = [...a.positions].sort((p, q) => p.mapY - q.mapY || p.mapX - q.mapX)[0];
    expect(first.id).toBe('Hub');
  });
});

describe('arrangeByFolders line length', () => {
  it('moves a block wired to another zone to the side facing it', () => {
    const fs = [{ id: 'L', name: 'A left' }, { id: 'R', name: 'B right' }];
    // Two zones of 2x2 blocks side by side; only L1 and R1 are wired, across the zones.
    const ps = [
      ...['L1', 'L2', 'L3', 'L4'].map((n) => ({ id: n, name: n, folderId: 'L' })),
      ...['R1', 'R2', 'R3', 'R4'].map((n) => ({ id: n, name: n, folderId: 'R' })),
    ];
    const edges = [{ source: 'L1', target: 'R1', wireCount: 1 }];
    const a = arrangeByFolders(ps, fs, [], edges);
    const left = a.zones.find((z) => z.name === 'A left')!;
    const right = a.zones.find((z) => z.name === 'B right')!;
    const pos = (id: string) => a.positions.find((p) => p.id === id)!;
    const leftOf = left.x < right.x;
    // L1 is in the column of its zone nearest the other zone, and R1 likewise.
    const lxs = ['L1', 'L2', 'L3', 'L4'].map((id) => pos(id).mapX);
    const rxs = ['R1', 'R2', 'R3', 'R4'].map((id) => pos(id).mapX);
    expect(pos('L1').mapX).toBe(leftOf ? Math.max(...lxs) : Math.min(...lxs));
    expect(pos('R1').mapX).toBe(leftOf ? Math.min(...rxs) : Math.max(...rxs));
  });
});
