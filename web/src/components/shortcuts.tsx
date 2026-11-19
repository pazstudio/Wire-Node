import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Modal } from './ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const HINT_KEY = 'wn-shortcuts-hint-seen';

interface Shortcut {
  keys: string[][];
  what: ReactNode;
}

interface Group {
  title: string;
  items: Shortcut[];
}

// keys: alternatives, each a key combination; e.g. [[MOD, 'K'], ['/']] = "Ctrl K or /".
const GROUPS: Group[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: [[MOD, 'K'], ['/']], what: 'Go to a component, connection, project or page' },
      { keys: [['?']], what: 'Show this help' },
      { keys: [['Esc']], what: 'Close a dialog or menu' },
      { keys: [['Alt', '←']], what: 'Back to the previous page' },
    ],
  },
  {
    title: 'In "Go to"',
    items: [
      { keys: [['↑'], ['↓']], what: 'Move through the results' },
      { keys: [['Enter']], what: 'Open the selected result' },
      { keys: [['c:']], what: 'Only components, e.g. "c: duet"' },
      { keys: [['w:']], what: 'Only connections (wiring), e.g. "w: motor"' },
      { keys: [['p:']], what: 'Only projects' },
      { keys: [], what: 'Leave it empty to see recently opened components and connections' },
    ],
  },
  {
    title: 'Connection editor',
    items: [
      { keys: [], what: 'Drag from a pin to a pin to draw a wire' },
      { keys: [], what: 'Drag on an empty area to select several connectors' },
      { keys: [[MOD, 'click']], what: 'Add to the selection' },
      { keys: [['Delete'], ['Backspace']], what: 'Delete the selected wires or connectors' },
      { keys: [['Right-drag'], ['Middle-drag']], what: 'Move the view' },
      { keys: [['Wheel']], what: 'Zoom' },
    ],
  },
  {
    title: 'Pin name suggestions',
    items: [
      { keys: [['↑'], ['↓']], what: 'Pick a suggestion' },
      { keys: [['Tab'], ['Enter'], ['→']], what: 'Accept the suggestion' },
      { keys: [['Esc']], what: 'Hide the suggestions' },
    ],
  },
  {
    title: 'Component photo',
    items: [
      { keys: [['Wheel']], what: 'Zoom around the pointer' },
      { keys: [], what: 'In Edit mode, drag on the photo to draw a connector; switch to Pan to move the photo' },
    ],
  },
];

function Keys({ keys }: { keys: string[][] }) {
  return (
    <span className="sc-keys">
      {keys.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sc-or">or</span>}
          {combo.map((k, j) => (
            <Fragment key={k}>
              {j > 0 && <span className="sc-plus">+</span>}
              <kbd>{k}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts and tips" onClose={onClose} wide>
      <p className="muted small sc-intro">
        On a phone or tablet, tap <strong>🔍</strong> in the top bar to search, and tap the project name to switch between
        its pages and recently opened items.
      </p>
      <div className="sc-grid">
        {GROUPS.map((g) => (
          <section key={g.title} className="sc-group">
            <h3>{g.title}</h3>
            <table className="sc-table">
              <tbody>
                {g.items.map((s, i) => (
                  <tr key={i}>
                    <td className="sc-key-cell">{s.keys.length ? <Keys keys={s.keys} /> : <span className="sc-tip">tip</span>}</td>
                    <td>{s.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      <p className="muted small sc-credit">Wire-Node, made by Zdeněk Pazourek</p>
    </Modal>
  );
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return true;
  }
}

function markHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/**
 * "?" button in the top bar that opens the shortcut list (also the ? key).
 * New users get a one-time hint pointing at it.
 */
export function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(() => !hintSeen());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function dismissHint() {
    setHint(false);
    markHintSeen();
  }

  function show() {
    dismissHint();
    setOpen(true);
  }

  return (
    <span className="sc-anchor">
      <button className="topbar-help" onClick={show} title="Keyboard shortcuts and tips (?)" aria-label="Keyboard shortcuts and tips">
        ?
      </button>
      {hint && (
        <div className="sc-hint no-print" role="status">
          <strong>New here?</strong> Press <kbd>{MOD}</kbd> <kbd>K</kbd> to jump to any component or connection. See all
          shortcuts under <strong>?</strong>
          <div className="sc-hint-actions">
            <button className="btn btn-sm btn-primary" onClick={show}>
              Show shortcuts
            </button>
            <button className="btn btn-sm" onClick={dismissHint}>
              Got it
            </button>
          </div>
        </div>
      )}
      {open && <ShortcutsModal onClose={() => setOpen(false)} />}
    </span>
  );
}
