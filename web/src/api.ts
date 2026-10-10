// ---------- Types shared with the backend ----------

export interface Project {
  id: string;
  name: string;
  machine: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  _count?: { pcbs: number; connections: number };
}

export interface Pcb {
  id: string;
  name: string;
  description: string;
  imagePath: string;
  thumbPath: string;
  imageWidth: number;
  imageHeight: number;
  _count?: { connectors: number };
  projects?: { project: { id: string; name: string } }[];
}

/** A library component placed in a project. The same component can be placed several times. */
export interface Placement {
  id: string;
  projectId: string;
  pcbId: string;
  /** Name in this project, e.g. "Peltier Driver - Toolhead1" (the component name if none was given). */
  name: string;
  mapX: number;
  mapY: number;
  /** Folder on the Components tab; null = not in a folder. */
  folderId: string | null;
  pcb: Pcb;
}

export type FolderKind = 'components' | 'connections';

/** Folder on a project tab (e.g. "Toolhead", "Frame"), for components or for connections. */
export interface Folder {
  id: string;
  projectId: string;
  kind: FolderKind;
  name: string;
}

export interface ConnectorType {
  id: string;
  name: string;
  pinCount: number;
  rowCount: number;
  crimpName: string;
  imagePath: string | null;
  thumbPath: string | null;
  _count?: { instances: number };
}

export interface Pin {
  n: number;
  name: string;
  color: string;
}

/** Board fields used to show where a connector sits on the component photo. */
export interface PcbPreview {
  id: string;
  name: string;
  thumbPath: string;
  imageWidth: number;
  imageHeight: number;
}

export interface PcbConnector {
  id: string;
  pcbId: string;
  connectorTypeId: string | null;
  /** Designator on the board, e.g. "J3". */
  label: string;
  /** What it is for, e.g. "Power", "Temperature sensor". */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  pins: Pin[];
  connectorType?: ConnectorType | null;
  pcb?: PcbPreview;
}

/** A connector on one placement of a component (a component placed twice lists its connectors twice). */
export type ProjectConnector = PcbConnector & { pcb: PcbPreview; placement: { id: string; name: string } };

export interface PinNameStat {
  name: string;
  count: number;
}

export interface PcbDetail extends Pcb {
  connectors: PcbConnector[];
}

export interface Cable {
  id: string;
  name: string;
  description: string;
  coreCount: number;
  cores: { color: string }[];
  shielded: boolean;
  gauge: string;
  lengthMm: number | null;
  _count?: { wires: number };
}

export interface ConnectionNodeDto {
  id: string;
  pcbConnectorId: string | null;
  /** Placement of the component in the project; null for free connectors. */
  projectPcbId: string | null;
  connectorTypeId: string | null;
  label: string;
  pinCount: number;
  x: number;
  y: number;
  pcbConnector?: (PcbConnector & { pcb: PcbPreview }) | null;
  /** name is empty when the placement uses the component name. */
  projectPcb?: { id: string; name: string } | null;
  connectorType?: ConnectorType | null;
}

export interface WireModel {
  id: string;
  fromNodeId: string;
  fromPin: number;
  toNodeId: string;
  toPin: number;
  cableId: string | null;
  coreIndex: number | null;
  color: string;
  /** null = same as the connection length. */
  lengthMm: number | null;
  note: string;
}

export interface WireDto extends WireModel {
  cable?: Cable | null;
}

export interface Connection {
  id: string;
  projectId: string;
  name: string;
  description: string;
  kind: string;
  lengthMm: number | null;
  /** Components chosen for this connection (placement ids). */
  placementIds: string[];
  /** Zones drawn in the diagram (e.g. "Frame", "Toolhead"). */
  zones: ZoneShape[];
  nodes: ConnectionNodeDto[];
  wires: WireDto[];
}

export interface ConnectionSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  lengthMm: number | null;
  /** Folder on the Connections tab; null = not in a folder. */
  folderId: string | null;
  wireCount: number;
  endpoints: string[];
}

/** A named rectangle grouping blocks by machine part, on the project map or in a connection diagram. */
export interface ZoneShape {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone extends ZoneShape {
  projectId: string;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  wireCount: number;
  connections: { id: string; name: string; wireCount: number }[];
}

export interface MapData {
  project: Project;
  placements: Placement[];
  zones: Zone[];
  edges: MapEdge[];
}

// ---------- HTTP helpers ----------

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.message) message = j.message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export const imgUrl = (p?: string | null) => (p ? `/uploads/${p}` : '');

/** UUID v4 that also works on plain-HTTP LAN addresses (crypto.randomUUID needs a secure context). */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' && window.isSecureContext) {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** "J3 · Power" style display name for a connector drawn on a board. */
export function connectorDisplayName(c: { label: string; name?: string | null }) {
  return [c.label, c.name].filter(Boolean).join(' · ');
}

/**
 * Next name in a numbered series that is not taken yet (ignoring case), keeping zero padding:
 * "V.out1" -> "V.out2", "J09" -> "J10", "FAN" -> "FAN2".
 */
export function nextNumberedName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()));
  const m = /^(.*?)(\d+)$/.exec(name);
  const base = m ? m[1] : name;
  const width = m ? m[2].length : 0;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  const make = (i: number) => `${base}${String(i).padStart(width, '0')}`;
  while (used.has(make(n).toLowerCase())) n++;
  return make(n);
}

/** Formats a length in mm, e.g. 1250 -> "1250 mm". */
export function formatLength(mm: number | null | undefined) {
  return mm == null ? '' : `${mm} mm`;
}

/** Parses a length input; empty -> null. */
export function parseLength(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Resize a pin list to n pins, keeping existing names/colors. */
export function resizePins(pins: Pin[], n: number): Pin[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    const existing = pins.find((p) => p.n === i + 1);
    return existing ?? { n: i + 1, name: '', color: '' };
  });
}
