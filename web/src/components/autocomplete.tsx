import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type PinNameStat } from '../api';

// Offered even before anyone has used them; names already used in the library rank first.
const PIN_NAME_PRESETS = [
  'GND',
  'VCC',
  '3V3',
  '5V',
  '12V',
  '24V',
  'VIN',
  'V+',
  'V-',
  'SDA',
  'SCL',
  'TX',
  'RX',
  'CAN_H',
  'CAN_L',
  'MOSI',
  'MISO',
  'SCK',
  'CS',
  'A+',
  'A-',
  'B+',
  'B-',
  'SIG',
  'PWM',
  'TACH',
  'EN',
  'NC',
];

/**
 * Pin names to suggest, most used first: every name saved on any connector, then names typed
 * on this page that are not saved yet, then presets. Case-insensitive duplicates are merged.
 */
export function usePinNameSuggestions(pageNames: string[]) {
  const q = useQuery({ queryKey: ['pinNames'], queryFn: () => api.get<PinNameStat[]>('/api/pin-names') });
  return useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (name: string) => {
      const t = name.trim();
      const key = t.toLowerCase();
      if (!t || seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    (q.data ?? []).forEach((s) => add(s.name));
    pageNames.forEach(add);
    PIN_NAME_PRESETS.forEach(add);
    return out;
  }, [q.data, pageNames]);
}

/** Options starting with the typed text first, then options containing it. */
function suggest(options: string[], typed: string, limit = 6) {
  const t = typed.trimStart().toLowerCase();
  if (!t) return [];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const o of options) {
    const l = o.toLowerCase();
    if (l === t) continue;
    if (l.startsWith(t)) prefix.push(o);
    else if (l.includes(t)) contains.push(o);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * Text input with suggestions. The best match is shown greyed out after the cursor:
 * Tab accepts it and moves on, Enter or → accepts and stays, ↑/↓ pick another, Esc hides.
 */
export function AutocompleteInput({
  value,
  onChange,
  options,
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState(false); // chose a suggestion with ↑/↓
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const matches = focused && !dismissed ? suggest(options, value) : [];
  const current = matches.length ? matches[Math.min(active, matches.length - 1)] : null;
  const ghost =
    current && current.toLowerCase().startsWith(value.toLowerCase()) ? current.slice(value.length) : '';
  const open = matches.length > 0;

  // The list is fixed-positioned so a scrolling side panel cannot clip it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 160) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
    setPicked(false);
  }, [value]);

  function accept(name: string) {
    onChange(name);
    setDismissed(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!current) return;
    const el = e.currentTarget;
    const atEnd = el.selectionStart === value.length && el.selectionEnd === value.length;
    switch (e.key) {
      case 'Tab':
        // Accept without blocking focus from moving to the next field.
        if (!e.shiftKey && (ghost || picked)) accept(current);
        break;
      case 'Enter':
        e.preventDefault();
        accept(current);
        break;
      case 'ArrowRight':
        if (ghost && atEnd) {
          e.preventDefault();
          accept(current);
        }
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((a) => (Math.min(a, matches.length - 1) + step + matches.length) % matches.length);
        setPicked(true);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        break;
    }
  }

  return (
    <span className="ac-wrap">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {ghost && (
        <span className="ac-ghost" aria-hidden>
          <span className="ac-typed">{value}</span>
          {ghost}
        </span>
      )}
      {open &&
        pos &&
        createPortal(
          <ul className="ac-list" style={pos} role="listbox">
            {matches.map((m, i) => (
              <li
                key={m}
                role="option"
                aria-selected={m === current}
                className={m === current ? 'active' : ''}
                // mousedown, not click: keeps focus in the input
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(m);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {m}
              </li>
            ))}
            <li className="ac-hint" aria-hidden>
              Tab to accept · ↑↓ to choose
            </li>
          </ul>,
          document.body,
        )}
    </span>
  );
}
