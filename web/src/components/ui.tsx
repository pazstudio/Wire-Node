import { useEffect, type ReactNode } from 'react';
import { WIRE_COLORS, colorBackground, colorLabel } from '../colors';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Swatch({ color, size = 16 }: { color: string | null | undefined; size?: number }) {
  if (!color) return <span className="swatch swatch-empty" style={{ width: size, height: size }} title="No color" />;
  return (
    <span
      className="swatch"
      style={{ width: size, height: size, background: colorBackground(color) }}
      title={colorLabel(color)}
    />
  );
}

/** Picks a base color and an optional stripe color. Value: "" | "base" | "base/stripe". */
export function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [base, stripe = ''] = value ? value.split('/') : ['', ''];
  return (
    <span className="color-picker">
      <Swatch color={value} />
      <select
        value={base}
        disabled={disabled}
        onChange={(e) => {
          const b = e.target.value;
          onChange(b ? (stripe ? `${b}/${stripe}` : b) : '');
        }}
        aria-label="Wire color"
      >
        <option value="">— color —</option>
        {WIRE_COLORS.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <select
        value={stripe}
        disabled={disabled || !base}
        onChange={(e) => onChange(e.target.value ? `${base}/${e.target.value}` : base)}
        aria-label="Stripe color"
      >
        <option value="">no stripe</option>
        {WIRE_COLORS.filter((c) => c.key !== base).map((c) => (
          <option key={c.key} value={c.key}>
            / {c.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <p className="error">{error}</p>;
}

export function SaveIndicator({
  status,
  onRetry,
}: {
  status: 'saved' | 'saving' | 'error';
  onRetry?: () => void;
}) {
  if (status === 'saving') return <span className="save-ind saving">Saving…</span>;
  if (status === 'error')
    return (
      <span className="save-ind error">
        Save failed{' '}
        {onRetry && (
          <button className="btn-link" onClick={onRetry}>
            Retry
          </button>
        )}
      </span>
    );
  return <span className="save-ind saved">✓ Saved</span>;
}

export function Loading({ error }: { error?: unknown }) {
  if (error) return <p className="page error">Failed to load: {error instanceof Error ? error.message : String(error)}</p>;
  return <p className="page muted">Loading…</p>;
}
