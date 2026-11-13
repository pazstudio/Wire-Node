/**
 * "Arrange by folders" on the project map: every components folder becomes a zone, its
 * components are laid out in a grid inside it, and components outside any folder are placed
 * after the zones. Folders that share many wires are placed next to each other, so the lines
 * between zones stay short.
 */

export type LayoutPlacement = { id: string; name: string; folderId: string | null };
export type LayoutFolder = { id: string; name: string };
export type LayoutZone = { id: string; name: string; color: string; w: number; h: number };
export type LayoutEdge = { source: string; target: string; wireCount: number };

export type ArrangedZone = { id: string | null; name: string; color: string; x: number; y: number; w: number; h: number };
export type Arrangement = {
  positions: { id: string; mapX: number; mapY: number }[];
  /**
   * Zones to create (id null) or move: the existing zone with a folder's name, and zones not named after
   * a folder, which are stacked to the right of the layout so they do not cover it.
   */
  zones: ArrangedZone[];
};

/** Room per component block (blocks are 200px wide and about 180px tall). */
const CELL_W = 260;
const CELL_H = 240;
/** Space around the blocks inside a zone; the top has extra room for the zone label. */
const PAD = 40;
const LABEL = 24;
/** Space between zones. */
const GAP = 100;

export const ZONE_PALETTE = ['#3b82f6', '#16a34a', '#f97316', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#dc2626', '#4f46e5', '#059669'];

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
const key = (name: string) => name.trim().toLowerCase();

type Group = { folder: LayoutFolder | null; items: LayoutPlacement[]; cols: number; w: number; h: number };

/** Components with the most wires come first (top left), so the lines from them stay short; then by name. */
function makeGroup(folder: LayoutFolder | null, items: LayoutPlacement[], wires: Map<string, number>): Group {
  const cols = Math.ceil(Math.sqrt(items.length));
  const rows = Math.ceil(items.length / cols);
  const pad = folder ? PAD : 0;
  return {
    folder,
    items: [...items].sort((a, b) => (wires.get(b.id) ?? 0) - (wires.get(a.id) ?? 0) || byName(a, b)),
    cols,
    w: cols * CELL_W - (CELL_W - 200) + 2 * pad,
    h: rows * CELL_H - (CELL_H - 180) + 2 * pad + (folder ? LABEL : 0),
  };
}

/** Starts with the largest folder, then always takes the folder with the most wires to those already placed. */
function orderGroups(groups: Group[], edges: LayoutEdge[]): Group[] {
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.items.forEach((p) => groupOf.set(p.id, i)));
  const weight = groups.map(() => new Map<number, number>());
  for (const e of edges) {
    const a = groupOf.get(e.source);
    const b = groupOf.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    weight[a].set(b, (weight[a].get(b) ?? 0) + e.wireCount);
    weight[b].set(a, (weight[b].get(a) ?? 0) + e.wireCount);
  }
  const left = new Set(groups.map((_, i) => i));
  const order: number[] = [];
  const pick = (score: (i: number) => number) => {
    let best = -1;
    for (const i of left) {
      if (best < 0 || score(i) > score(best) || (score(i) === score(best) && byName(groups[i].folder!, groups[best].folder!) < 0)) best = i;
    }
    left.delete(best);
    order.push(best);
  };
  if (left.size) pick((i) => groups[i].items.length);
  while (left.size) pick((i) => order.reduce((s, j) => s + (weight[i].get(j) ?? 0), 0));
  return order.map((i) => groups[i]);
}

export function arrangeByFolders(
  placements: LayoutPlacement[],
  folders: LayoutFolder[],
  existingZones: LayoutZone[],
  edges: LayoutEdge[],
): Arrangement {
  const folderIds = new Set(folders.map((f) => f.id));
  const wires = new Map<string, number>();
  for (const e of edges) for (const id of [e.source, e.target]) wires.set(id, (wires.get(id) ?? 0) + e.wireCount);
  const folderGroups = folders
    .map((f) => makeGroup(f, placements.filter((p) => p.folderId === f.id), wires))
    .filter((g) => g.items.length > 0);
  const ordered = orderGroups(folderGroups, edges);
  const loose = placements.filter((p) => !p.folderId || !folderIds.has(p.folderId));

  // Shelf packing: rows of zones about as wide as the whole layout is tall.
  const area = ordered.reduce((s, g) => s + (g.w + GAP) * (g.h + GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area) * 1.4, ...ordered.map((g) => g.w));
  const positions: Arrangement['positions'] = [];
  const zones: ArrangedZone[] = [];
  const zoneByName = new Map(existingZones.map((z) => [key(z.name), z]));
  const usedColors = new Set(existingZones.map((z) => z.color.toLowerCase()));
  let nextColor = 0;
  const freshColor = () => {
    const free = ZONE_PALETTE.find((c) => !usedColors.has(c));
    const c = free ?? ZONE_PALETTE[nextColor++ % ZONE_PALETTE.length];
    usedColors.add(c);
    return c;
  };

  let x = 0;
  let y = 0;
  let rowH = 0;
  const cellGroups: Arrangement['positions'][] = [];
  const place = (g: Group, gx: number, gy: number) => {
    const pad = g.folder ? PAD : 0;
    const top = gy + pad + (g.folder ? LABEL : 0);
    const cells = g.items.map((p, i) => ({ id: p.id, mapX: gx + pad + (i % g.cols) * CELL_W, mapY: top + Math.floor(i / g.cols) * CELL_H }));
    positions.push(...cells);
    cellGroups.push(cells);
  };
  for (const g of ordered) {
    if (x > 0 && x + g.w > rowWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    place(g, x, y);
    const existing = zoneByName.get(key(g.folder!.name));
    zoneByName.delete(key(g.folder!.name));
    zones.push({ id: existing?.id ?? null, name: g.folder!.name, color: existing?.color ?? freshColor(), x, y, w: g.w, h: g.h });
    x += g.w + GAP;
    rowH = Math.max(rowH, g.h);
  }

  // Components outside folders go in a wide grid below the zones.
  if (loose.length) {
    const g = makeGroup(null, loose, wires);
    if (ordered.length) g.cols = Math.max(1, Math.min(loose.length, Math.floor((rowWidth + CELL_W - 200) / CELL_W)));
    place(g, 0, ordered.length ? y + rowH + GAP : 0);
  }
  shortenLines(cellGroups, edges);

  const right = Math.max(0, ...zones.map((z) => z.x + z.w), ...positions.map((p) => p.mapX + 200));
  let otherY = 0;
  for (const z of [...zoneByName.values()].sort(byName)) {
    zones.push({ id: z.id, name: z.name, color: z.color, x: right + 2 * GAP, y: otherY, w: z.w, h: z.h });
    otherY += z.h + GAP;
  }
  return { positions, zones };
}

/**
 * Swaps blocks inside each zone while that makes the lines shorter overall, so a block wired to
 * another zone moves to the side facing it and wired blocks sit next to each other.
 * Each line counts once, however many wires it has: what clutters the map is the number of lines.
 */
function shortenLines(groups: Arrangement['positions'][], edges: LayoutEdge[]) {
  const at = new Map<string, { mapX: number; mapY: number }>();
  for (const g of groups) for (const c of g) at.set(c.id, c);
  const links = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target || !at.has(e.source) || !at.has(e.target)) continue;
    links.set(e.source, [...(links.get(e.source) ?? []), e.target]);
    links.set(e.target, [...(links.get(e.target) ?? []), e.source]);
  }
  // Length of the lines of `id` if it stood at `pos` (ignoring a line to `skip`, which a swap keeps as long).
  const cost = (id: string, pos: { mapX: number; mapY: number }, skip: string) =>
    (links.get(id) ?? []).reduce((s, o) => {
      if (o === skip) return s;
      const q = at.get(o)!;
      return s + Math.hypot(pos.mapX - q.mapX, pos.mapY - q.mapY);
    }, 0);
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const a = g[i];
          const b = g[j];
          if (!links.has(a.id) && !links.has(b.id)) continue;
          const before = cost(a.id, a, b.id) + cost(b.id, b, a.id);
          const after = cost(a.id, b, b.id) + cost(b.id, a, a.id);
          if (after < before - 1) {
            [a.mapX, b.mapX] = [b.mapX, a.mapX];
            [a.mapY, b.mapY] = [b.mapY, a.mapY];
            [g[i], g[j]] = [b, a];
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
}
