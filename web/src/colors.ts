// Standard wire colors. A wire color is stored as "base" or "base/stripe" (e.g. "green/yellow").
export const WIRE_COLORS = [
  { key: 'black', label: 'Black', hex: '#1f1f1f' },
  { key: 'brown', label: 'Brown', hex: '#7c4a1e' },
  { key: 'red', label: 'Red', hex: '#dc2626' },
  { key: 'orange', label: 'Orange', hex: '#f97316' },
  { key: 'yellow', label: 'Yellow', hex: '#facc15' },
  { key: 'green', label: 'Green', hex: '#16a34a' },
  { key: 'blue', label: 'Blue', hex: '#2563eb' },
  { key: 'violet', label: 'Violet', hex: '#7c3aed' },
  { key: 'grey', label: 'Grey', hex: '#9ca3af' },
  { key: 'white', label: 'White', hex: '#f8fafc' },
  { key: 'pink', label: 'Pink', hex: '#f472b6' },
  { key: 'turquoise', label: 'Turquoise', hex: '#14b8a6' },
] as const;

function hexOf(key: string): string {
  return WIRE_COLORS.find((c) => c.key === key)?.hex ?? key;
}

export function colorParts(value: string | null | undefined): { base: string; stripe: string | null } | null {
  if (!value) return null;
  const [base, stripe] = value.split('/');
  return { base: hexOf(base), stripe: stripe ? hexOf(stripe) : null };
}

export function colorLabel(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .split('/')
    .map((k) => WIRE_COLORS.find((c) => c.key === k)?.label ?? k)
    .join(' / ');
}

/** CSS background for a swatch: solid or striped. */
export function colorBackground(value: string | null | undefined): string {
  const p = colorParts(value);
  if (!p) return 'transparent';
  if (!p.stripe) return p.base;
  return `repeating-linear-gradient(45deg, ${p.base} 0 5px, ${p.stripe} 5px 8px)`;
}

/** Hex "#rrggbb" plus alpha -> rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
