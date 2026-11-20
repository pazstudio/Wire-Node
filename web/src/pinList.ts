import { WIRE_COLORS } from './colors';
import type { Pin, PinRole } from './api';

const ROLE_WORDS: Record<string, PinRole> = {
  power: 'power',
  pwr: 'power',
  supply: 'power',
  ground: 'ground',
  gnd: 'ground',
  input: 'input',
  in: 'input',
  output: 'output',
  out: 'output',
  bidir: 'bidir',
  'in/out': 'bidir',
  can_h: 'can_h',
  canh: 'can_h',
  can_l: 'can_l',
  canl: 'can_l',
  shield: 'shield',
  shld: 'shield',
};

function colorKey(word: string): string | null {
  const parts = word.toLowerCase().replace('gray', 'grey').replace('purple', 'violet').split('/');
  if (parts.length > 2) return null;
  return parts.every((p) => WIRE_COLORS.some((c) => c.key === p)) ? parts.join('/') : null;
}

/**
 * Reads a pasted pin list: "1 GND", "2;24V;red;5A;power", "3\tSTEP_X", or just names (numbered in
 * order). The first column is the pin number when it is one, the next the name, then any of color,
 * current ("5A", "0.5 A") and role, in any order.
 */
export function parsePinList(text: string): { pins: (Partial<Pin> & { n: number })[]; errors: string[] } {
  const pins: (Partial<Pin> & { n: number })[] = [];
  const errors: string[] = [];
  let next = 1;
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const delimited = /[\t;,]/.test(line);
      const cells = (delimited ? line.split(/\s*[\t;,]\s*/) : line.split(/\s+/)).filter((c) => c !== '');
      let n = next;
      if (/^(pin\s*)?\d+$/i.test(cells[0] ?? '')) n = Number(cells.shift()!.replace(/\D/g, ''));
      if (!cells.length) {
        errors.push(`Line ${i + 1}: no pin name`);
        return;
      }
      const pin: Partial<Pin> & { n: number } = { n, name: cells.shift()! };
      const rest: string[] = [];
      for (const c of cells) {
        const cur = /^(\d+(?:[.,]\d+)?)\s*a$/i.exec(c);
        if (cur) pin.current = Number(cur[1].replace(',', '.'));
        else if (colorKey(c)) pin.color = colorKey(c)!;
        else if (ROLE_WORDS[c.toLowerCase()]) pin.role = ROLE_WORDS[c.toLowerCase()];
        else rest.push(c);
      }
      // Names with spaces ("Motor A+") when the line was split on spaces.
      if (rest.length && !delimited) pin.name = [pin.name, ...rest].join(' ');
      if (pins.some((p) => p.n === n)) errors.push(`Line ${i + 1}: pin ${n} is listed twice`);
      pins.push(pin);
      next = n + 1;
    });
  return { pins, errors };
}
