import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { Image as KImage, Label, Layer, Rect, Stage, Tag, Text, Transformer } from 'react-konva';
import {
  api,
  connectorDisplayName,
  errorMessage,
  imgUrl,
  resizePins,
  uuid,
  type ConnectorType,
  type PcbConnector,
  type PcbDetail,
} from '../api';
import { ConnectorTypeForm } from '../components/forms';
import { ColorPicker, Loading, SaveIndicator, Swatch } from '../components/ui';
import { colorLabel } from '../colors';

// Allow pinch-zoom while a drag is in progress.
Konva.hitOnDragEnabled = true;

// Suggestions for "Name on component"; any text is allowed.
const NAME_PRESETS = [
  'Power',
  'Power in',
  'Power out',
  'Temperature sensor',
  'Thermistor',
  'Heater',
  'Hotend heater',
  'Bed heater',
  'Fan',
  'Part cooling fan',
  'Hotend fan',
  'Stepper motor',
  'Endstop',
  'Probe',
  'Filament sensor',
  'LED',
  'USB',
  'CAN bus',
  'UART',
  'SPI',
  'I2C',
  'Display',
];

type SaveStatus ='saved' | 'saving' | 'error';
type View = { scale: number; x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function toPayload(c: PcbConnector) {
  const w = clamp(c.w, 0.0005, 1);
  const h = clamp(c.h, 0.0005, 1);
  return {
    pcbId: c.pcbId,
    connectorTypeId: c.connectorTypeId,
    label: c.label,
    name: c.name ?? '',
    x: clamp(c.x, 0, 1 - w),
    y: clamp(c.y, 0, 1 - h),
    w,
    h,
    rotation: c.rotation,
    pins: c.pins,
  };
}

function useHtmlImage(src: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const i = new window.Image();
    i.onload = () => setImg(i);
    i.src = src;
    return () => {
      i.onload = null;
    };
  }, [src]);
  return img;
}

/**
 * Debounced, per-connector autosave. Saves for the same connector are chained so
 * they always reach the server in order; the latest local state is sent each time.
 */
function useConnectorAutosave(getItem: (id: string) => PcbConnector | undefined) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chains = useRef(new Map<string, Promise<void>>());
  const inflight = useRef(0);
  const failed = useRef(new Set<string>());
  const getRef = useRef(getItem);
  getRef.current = getItem;
  const [status, setStatus] = useState<SaveStatus>('saved');

  const refresh = useCallback(() => {
    setStatus(failed.current.size ? 'error' : timers.current.size || inflight.current ? 'saving' : 'saved');
  }, []);

  const send = useCallback(
    (id: string) => {
      timers.current.delete(id);
      inflight.current++;
      refresh();
      const prev = chains.current.get(id) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const item = getRef.current(id);
          if (!item) return;
          try {
            await api.put(`/api/pcb-connectors/${id}`, toPayload(item));
            failed.current.delete(id);
          } catch {
            failed.current.add(id);
          }
        })
        .finally(() => {
          inflight.current--;
          refresh();
        });
      chains.current.set(id, next);
      return next;
    },
    [refresh],
  );

  const schedule = useCallback(
    (id: string) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.set(
        id,
        setTimeout(() => send(id), 400),
      );
      refresh();
    },
    [send, refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.delete(id);
      failed.current.delete(id);
      await (chains.current.get(id) ?? Promise.resolve());
      refresh();
    },
    [refresh],
  );

  const retry = useCallback(() => {
    const ids = [...failed.current];
    failed.current.clear();
    ids.forEach((id) => send(id));
  }, [send]);

  const flush = useCallback(() => {
    const entries = [...timers.current.entries()];
    entries.forEach(([id, t]) => {
      clearTimeout(t);
      send(id);
    });
  }, [send]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (timers.current.size || inflight.current || failed.current.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushRef.current(); // save anything pending when leaving the page
    };
  }, []);

  return { status, schedule, cancel, retry };
}

export default function PcbPage() {
  const { pid, pcbId } = useParams() as { pid: string; pcbId: string };
  const pcbQ = useQuery({
    queryKey: ['pcb', pcbId],
    queryFn: () => api.get<PcbDetail>(`/api/pcbs/${pcbId}`),
    gcTime: 0,
    staleTime: 0,
  });
  const typesQ = useQuery({ queryKey: ['connectorTypes'], queryFn: () => api.get<ConnectorType[]>('/api/connector-types') });
  if (!pcbQ.data || !typesQ.data) return <Loading error={pcbQ.error || typesQ.error} />;
  return <PcbEditor key={pcbQ.data.id} pcb={pcbQ.data} projectId={pid} types={typesQ.data} />;
}

function PcbEditor({ pcb, projectId, types }: { pcb: PcbDetail; projectId: string; types: ConnectorType[] }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const imgW = pcb.imageWidth;
  const imgH = pcb.imageHeight;
  const image = useHtmlImage(imgUrl(pcb.imagePath));

  const [rects, setRects] = useState<PcbConnector[]>(pcb.connectors);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const [mode, setMode] = useState<'view' | 'edit'>(params.get('edit') === '1' ? 'edit' : 'view');
  const [tool, setTool] = useState<'draw' | 'pan'>('draw');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [creatingTypeFor, setCreatingTypeFor] = useState<string | null>(null);

  const saver = useConnectorAutosave((id) => rectsRef.current.find((r) => r.id === id));

  // ----- Sizing: fit the photo into the available area -----
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const [box, setBox] = useState({ w: 800, h: 500 });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(200, el.clientWidth);
      const availH = Math.max(280, window.innerHeight - el.getBoundingClientRect().top - 12);
      const h = Math.max(240, Math.min(availH, Math.round((w * imgH) / imgW)));
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [imgW, imgH]);

  const fit = Math.min(box.w / imgW, box.h / imgH);
  const [view, setView] = useState<View>({ scale: fit, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const resetView = useCallback(() => {
    setView({ scale: fit, x: (box.w - imgW * fit) / 2, y: (box.h - imgH * fit) / 2 });
  }, [fit, box.w, box.h, imgW, imgH]);
  useEffect(resetView, [resetView]);

  const scale = view.scale;
  const minScale = fit * 0.5;
  const maxScale = fit * 25;

  function zoomAt(point: { x: number; y: number }, newScale: number) {
    const v = viewRef.current;
    const s = clamp(newScale, minScale, maxScale);
    const mx = (point.x - v.x) / v.scale;
    const my = (point.y - v.y) / v.scale;
    setView({ scale: s, x: point.x - mx * s, y: point.y - my * s });
  }

  // ----- Rect helpers -----
  const updateRect = useCallback(
    (id: string, patch: Partial<PcbConnector>, save = true) => {
      setRects((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      if (save) saver.schedule(id);
    },
    [saver],
  );

  function nextLabel() {
    const used = new Set(rectsRef.current.map((r) => r.label));
    let i = 1;
    while (used.has(`J${i}`)) i++;
    return `J${i}`;
  }

  function duplicateRect(id: string) {
    const src = rectsRef.current.find((r) => r.id === id);
    if (!src) return;
    const copy: PcbConnector = {
      ...src,
      id: uuid(),
      label: `${src.label} copy`,
      x: clamp(src.x + 0.02, 0, 1 - src.w),
      y: clamp(src.y + 0.02, 0, 1 - src.h),
      pins: src.pins.map((p) => ({ ...p })),
    };
    setRects((rs) => [...rs, copy]);
    saver.schedule(copy.id);
    setSelectedId(copy.id);
    setPanelId(copy.id);
  }

  async function removeRect(id: string) {
    const r = rectsRef.current.find((x) => x.id === id);
    if (!r) return;
    let used: { name: string }[] = [];
    try {
      used = (await api.get<{ connections: { name: string }[] }>(`/api/pcb-connectors/${id}/usage`)).connections;
    } catch {
      /* not saved yet */
    }
    const msg = used.length
      ? `"${r.label}" is used in: ${used.map((c) => c.name).join(', ')}.\nRemoving it also removes its wires there. Continue?`
      : `Remove connector "${r.label}"?`;
    if (!confirm(msg)) return;
    await saver.cancel(id);
    setRects((rs) => rs.filter((x) => x.id !== id));
    setSelectedId(null);
    setPanelId(null);
    try {
      await api.del(`/api/pcb-connectors/${id}`);
    } catch (e) {
      alert(`Could not delete: ${errorMessage(e)}`);
    }
  }

  // ----- Stage events -----
  const canPan = mode === 'view' || tool === 'pan';
  const isBackground = (e: KonvaEventObject<Event>) =>
    e.target === e.target.getStage() || e.target.name() === 'pcb-image';

  function pointerInImage() {
    const p = stageRef.current?.getRelativePointerPosition();
    if (!p) return null;
    return { x: clamp(p.x, 0, imgW), y: clamp(p.y, 0, imgH) };
  }

  function onDown(e: KonvaEventObject<MouseEvent | TouchEvent>) {
    if (mode !== 'edit' || tool !== 'draw' || !isBackground(e)) return;
    if ('touches' in e.evt && e.evt.touches.length > 1) {
      setDraft(null);
      return;
    }
    const p = pointerInImage();
    if (p) setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }

  function onMove() {
    if (!draft) return;
    const p = pointerInImage();
    if (p) setDraft((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  }

  function onUp() {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0);
    const h = Math.abs(d.y1 - d.y0);
    if (w * scale < 8 || h * scale < 8) return; // a tap, not a drag
    const c: PcbConnector = {
      id: uuid(),
      pcbId: pcb.id,
      connectorTypeId: null,
      label: nextLabel(),
      name: '',
      x: x / imgW,
      y: y / imgH,
      w: w / imgW,
      h: h / imgH,
      rotation: 0,
      pins: [],
    };
    setRects((rs) => [...rs, c]);
    saver.schedule(c.id);
    setSelectedId(c.id);
    setPanelId(c.id);
  }

  // Pinch-zoom on touch screens.
  const pinch = useRef<{ dist: number; center: { x: number; y: number } } | null>(null);
  function onTouchMove(e: KonvaEventObject<TouchEvent>) {
    const t = e.evt.touches;
    if (t.length !== 2) return onMove();
    e.evt.preventDefault();
    setDraft(null);
    const stage = stageRef.current!;
    if (stage.isDragging()) stage.stopDrag();
    const r = stage.container().getBoundingClientRect();
    const p1 = { x: t[0].clientX - r.left, y: t[0].clientY - r.top };
    const p2 = { x: t[1].clientX - r.left, y: t[1].clientY - r.top };
    const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    if (!pinch.current) {
      pinch.current = { dist, center };
      return;
    }
    const v = viewRef.current;
    const s = clamp(v.scale * (dist / pinch.current.dist), minScale, maxScale);
    const mx = (center.x - v.x) / v.scale;
    const my = (center.y - v.y) / v.scale;
    const dx = center.x - pinch.current.center.x;
    const dy = center.y - pinch.current.center.y;
    setView({ scale: s, x: center.x - mx * s + dx, y: center.y - my * s + dy });
    pinch.current = { dist, center };
  }

  function onWheel(e: KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const p = stageRef.current?.getPointerPosition();
    if (!p) return;
    zoomAt(p, viewRef.current.scale * (e.evt.deltaY > 0 ? 1 / 1.15 : 1.15));
  }

  function onStageClick(e: KonvaEventObject<MouseEvent | TouchEvent>) {
    if (!isBackground(e)) return;
    setSelectedId(null);
    if (mode === 'view') setPanelId(null);
  }

  function onRectClick(id: string) {
    if (mode === 'edit') setSelectedId(id);
    else setPanelId(id);
  }

  // Attach the resize handles to the selected rectangle.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = mode === 'edit' && selectedId ? stageRef.current?.findOne(`#${selectedId}`) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, mode, rects]);

  useEffect(() => {
    if (mode === 'view') setSelectedId(null);
  }, [mode]);

  const selected = rects.find((r) => r.id === selectedId) ?? null;
  const panelRect = rects.find((r) => r.id === panelId) ?? null;

  // Floating action menu next to the selected rectangle (screen coordinates).
  let menuPos: { left: number; top: number } | null = null;
  if (selected && mode === 'edit' && !draft) {
    const left = view.x + (selected.x + selected.w) * imgW * scale + 8;
    const top = view.y + selected.y * imgH * scale;
    menuPos = { left: clamp(left, 4, box.w - 120), top: clamp(top, 4, box.h - 110) };
  }

  const draftRect = draft && {
    x: Math.min(draft.x0, draft.x1),
    y: Math.min(draft.y0, draft.y1),
    w: Math.abs(draft.x1 - draft.x0),
    h: Math.abs(draft.y1 - draft.y0),
  };

  return (
    <div className="pcb-page">
      <div className="pcb-toolbar no-print">
        <div className="crumbs">
          <Link to={`/projects/${projectId}`}>Project</Link> / <strong>{pcb.name}</strong>
        </div>
        <div className="btn-row">
          <div className="seg">
            <button className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
              View
            </button>
            <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
              Edit
            </button>
          </div>
          {mode === 'edit' && (
            <div className="seg">
              <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')} title="Drag on the photo to draw a connector">
                ▭ Draw
              </button>
              <button className={tool === 'pan' ? 'active' : ''} onClick={() => setTool('pan')} title="Drag to move the photo">
                ✋ Pan
              </button>
            </div>
          )}
          <div className="seg">
            <button onClick={() => zoomAt({ x: box.w / 2, y: box.h / 2 }, scale / 1.3)} aria-label="Zoom out">
              −
            </button>
            <button onClick={resetView}>Fit</button>
            <button onClick={() => zoomAt({ x: box.w / 2, y: box.h / 2 }, scale * 1.3)} aria-label="Zoom in">
              +
            </button>
          </div>
          <SaveIndicator status={saver.status} onRetry={saver.retry} />
          <Link className="btn btn-sm" to={`/projects/${projectId}?tab=connections&new=1`}>
            New connection
          </Link>
        </div>
      </div>
      {mode === 'edit' && (
        <p className="hint no-print">
          {tool === 'draw'
            ? 'Drag on the photo to draw a rectangle around a connector. Tap a rectangle to edit, duplicate or remove it.'
            : 'Drag to move the photo. Rectangles can still be moved and resized.'}
        </p>
      )}

      <div className="pcb-layout">
        <div ref={wrapRef} className="pcb-stage-wrap" style={{ height: box.h }}>
          <Stage
            ref={stageRef}
            width={box.w}
            height={box.h}
            scaleX={scale}
            scaleY={scale}
            x={view.x}
            y={view.y}
            draggable={canPan}
            onDragMove={(e) => {
              if (e.target === e.target.getStage()) setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
            }}
            onDragEnd={(e) => {
              if (e.target === e.target.getStage()) setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
            }}
            onWheel={onWheel}
            onMouseDown={onDown}
            onTouchStart={onDown}
            onMouseMove={onMove}
            onTouchMove={onTouchMove}
            onMouseUp={onUp}
            onTouchEnd={() => {
              pinch.current = null;
              onUp();
            }}
            onClick={onStageClick}
            onTap={onStageClick}
          >
            <Layer>
              {image && <KImage image={image} width={imgW} height={imgH} name="pcb-image" />}
              {rects.map((r) => {
                const isSel = r.id === selectedId || (mode === 'view' && r.id === panelId);
                return (
                  <Rect
                    key={r.id}
                    id={r.id}
                    x={r.x * imgW}
                    y={r.y * imgH}
                    width={r.w * imgW}
                    height={r.h * imgH}
                    stroke={isSel ? '#f97316' : '#22c55e'}
                    strokeWidth={2 / scale}
                    fill={isSel ? 'rgba(249,115,22,0.18)' : 'rgba(34,197,94,0.15)'}
                    draggable={mode === 'edit'}
                    onClick={() => onRectClick(r.id)}
                    onTap={() => onRectClick(r.id)}
                    onDragStart={() => setSelectedId(r.id)}
                    onDragMove={(e) => updateRect(r.id, { x: e.target.x() / imgW, y: e.target.y() / imgH }, false)}
                    onDragEnd={(e) => {
                      const x = clamp(e.target.x() / imgW, 0, 1 - r.w);
                      const y = clamp(e.target.y() / imgH, 0, 1 - r.h);
                      e.target.position({ x: x * imgW, y: y * imgH });
                      updateRect(r.id, { x, y });
                    }}
                    onTransformEnd={(e) => {
                      const n = e.target;
                      const w = Math.max(4, n.width() * n.scaleX());
                      const h = Math.max(4, n.height() * n.scaleY());
                      n.scaleX(1);
                      n.scaleY(1);
                      updateRect(r.id, { x: n.x() / imgW, y: n.y() / imgH, w: w / imgW, h: h / imgH });
                    }}
                  />
                );
              })}
              {rects.map((r) => (
                <Label key={`l-${r.id}`} x={r.x * imgW} y={r.y * imgH - 20 / scale} listening={false}>
                  <Tag fill="rgba(15,23,42,0.8)" cornerRadius={3 / scale} />
                  <Text text={connectorDisplayName(r) || '?'} fontSize={12 / scale} padding={3 / scale} fill="#fff" />
                </Label>
              ))}
              {draftRect && (
                <Rect
                  x={draftRect.x}
                  y={draftRect.y}
                  width={draftRect.w}
                  height={draftRect.h}
                  stroke="#3b82f6"
                  strokeWidth={2 / scale}
                  dash={[6 / scale, 4 / scale]}
                  fill="rgba(59,130,246,0.15)"
                  listening={false}
                />
              )}
              <Transformer
                ref={trRef}
                rotateEnabled={false}
                keepRatio={false}
                ignoreStroke
                anchorSize={12}
                borderStroke="#f97316"
                anchorStroke="#f97316"
                boundBoxFunc={(oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox)}
              />
            </Layer>
          </Stage>
          {!image && <div className="stage-loading">Loading picture…</div>}
          {menuPos && selected && (
            <div className="rect-menu" style={menuPos}>
              <button onClick={() => setPanelId(selected.id)}>Edit</button>
              <button onClick={() => duplicateRect(selected.id)}>Duplicate</button>
              <button className="danger" onClick={() => removeRect(selected.id)}>
                Remove
              </button>
            </div>
          )}
        </div>

        <aside className="pcb-side">
          {panelRect ? (
            mode === 'edit' ? (
              <ConnectorPanel
                rect={panelRect}
                types={types}
                onChange={(patch) => updateRect(panelRect.id, patch)}
                onClose={() => setPanelId(null)}
                onNewType={() => setCreatingTypeFor(panelRect.id)}
                onRemove={() => removeRect(panelRect.id)}
                onDuplicate={() => duplicateRect(panelRect.id)}
              />
            ) : (
              <ConnectorInfo rect={panelRect} types={types} onClose={() => setPanelId(null)} />
            )
          ) : (
            <div className="panel">
              <h3>Connectors on this component</h3>
              {pcb.description && <p className="small muted">{pcb.description}</p>}
              {rects.length === 0 && <p className="muted small">None yet. Switch to Edit and draw a rectangle on the photo.</p>}
              <ul className="conn-list">
                {rects.map((r) => {
                  const t = types.find((x) => x.id === r.connectorTypeId);
                  return (
                    <li key={r.id}>
                      <button
                        className="btn-link"
                        onClick={() => {
                          setPanelId(r.id);
                          if (mode === 'edit') setSelectedId(r.id);
                        }}
                      >
                        <strong>{connectorDisplayName(r) || '?'}</strong> {t && <span className="muted">· {t.name}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {creatingTypeFor && (
        <ConnectorTypeForm
          onClose={() => setCreatingTypeFor(null)}
          onSaved={(t) => {
            const target = rectsRef.current.find((r) => r.id === creatingTypeFor);
            if (target) updateRect(target.id, { connectorTypeId: t.id, pins: resizePins(target.pins, t.pinCount) });
            setCreatingTypeFor(null);
            qc.invalidateQueries({ queryKey: ['connectorTypes'] });
          }}
        />
      )}
    </div>
  );
}

function ConnectorPanel({
  rect,
  types,
  onChange,
  onClose,
  onNewType,
  onRemove,
  onDuplicate,
}: {
  rect: PcbConnector;
  types: ConnectorType[];
  onChange: (patch: Partial<PcbConnector>) => void;
  onClose: () => void;
  onNewType: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const type = types.find((t) => t.id === rect.connectorTypeId) ?? null;
  const pinCount = type ? type.pinCount : rect.pins.length;
  const pins = resizePins(rect.pins, pinCount);

  function setPin(n: number, patch: { name?: string; color?: string }) {
    onChange({ pins: pins.map((p) => (p.n === n ? { ...p, ...patch } : p)) });
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Edit connector</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="form">
        <label>
          Label
          <input value={rect.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="e.g. J3 / FAN0" />
        </label>
        <label>
          Name on component
          <input
            value={rect.name ?? ''}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Power, Temperature sensor"
            list="connector-name-presets"
          />
          <datalist id="connector-name-presets">
            {NAME_PRESETS.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label>
          Connector type
          <span className="input-row">
            <select
              value={rect.connectorTypeId ?? ''}
              onChange={(e) => {
                const t = types.find((x) => x.id === e.target.value);
                onChange({ connectorTypeId: t?.id ?? null, pins: t ? resizePins(rect.pins, t.pinCount) : rect.pins });
              }}
            >
              <option value="">— none —</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.pinCount} pins)
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={onNewType}>
              + New
            </button>
          </span>
        </label>
        {type?.crimpName && <p className="small muted">Crimp: {type.crimpName}</p>}
        {!type && (
          <label>
            Number of pins
            <input
              type="number"
              min={0}
              max={500}
              value={pinCount}
              onChange={(e) => onChange({ pins: resizePins(rect.pins, Math.max(0, +e.target.value)) })}
            />
          </label>
        )}
      </div>
      {pins.length > 0 && (
        <table className="table pin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Pin name</th>
              <th>Cable color</th>
            </tr>
          </thead>
          <tbody>
            {pins.map((p) => (
              <tr key={p.n}>
                <td>{p.n}</td>
                <td>
                  <input value={p.name} onChange={(e) => setPin(p.n, { name: e.target.value })} placeholder="e.g. GND" />
                </td>
                <td>
                  <ColorPicker value={p.color} onChange={(v) => setPin(p.n, { color: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="btn-row panel-foot">
        <button className="btn btn-sm" onClick={onDuplicate}>
          Duplicate
        </button>
        <button className="btn btn-sm btn-danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <p className="small muted">Changes are saved automatically.</p>
    </div>
  );
}

function ConnectorInfo({ rect, types, onClose }: { rect: PcbConnector; types: ConnectorType[]; onClose: () => void }) {
  const type = types.find((t) => t.id === rect.connectorTypeId) ?? null;
  const pins = resizePins(rect.pins, type ? type.pinCount : rect.pins.length);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{connectorDisplayName(rect) || 'Connector'}</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {type ? (
        <p className="small">
          {type.name} · {type.pinCount} pins · {type.rowCount} row(s)
          {type.crimpName && <> · crimp {type.crimpName}</>}
        </p>
      ) : (
        <p className="small muted">No connector type set.</p>
      )}
      {type?.thumbPath && <img src={imgUrl(type.thumbPath)} alt="" className="info-img" />}
      {pins.length > 0 && (
        <table className="table pin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Pin name</th>
              <th>Color</th>
            </tr>
          </thead>
          <tbody>
            {pins.map((p) => (
              <tr key={p.n}>
                <td>{p.n}</td>
                <td>{p.name}</td>
                <td>
                  <span className="swatches">
                    <Swatch color={p.color} /> {colorLabel(p.color)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
