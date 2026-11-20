import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** QR code as an SVG (black modules on white), e.g. a link to a connection for a harness tag. */
export function QrCode({ value, size = 96, title }: { value: string; size?: number; title?: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    }
    return { path: d, count: n + 4 };
  }, [value]);
  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? `QR code: ${value}`}
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Absolute link to a page of this app (QR codes are scanned by another device). */
export function appUrl(path: string) {
  return `${window.location.origin}${path}`;
}
