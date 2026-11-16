/**
 * Touch support. Phones and tablets have no hover, and after a tap the browser fires made-up mouse
 * events (mouseenter, mousedown, click) that must not be taken for a real mouse. Pointer events tell
 * which kind of pointer was used last; the made-up mouse events come without pointer events.
 */

/** A phone or tablet: no hover, finger as the main pointer. */
export const isTouchDevice =
  typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;

let lastPointerType = isTouchDevice ? 'touch' : 'mouse';

if (typeof window !== 'undefined') {
  const track = (e: PointerEvent) => {
    lastPointerType = e.pointerType || 'mouse';
  };
  window.addEventListener('pointerdown', track, { capture: true, passive: true });
  window.addEventListener('pointermove', track, { capture: true, passive: true });
}

/** True when the last pointer used was a finger or pen, so mouse events now come from a tap. */
export const usingTouch = () => lastPointerType !== 'mouse';
