/**
 * What a wheel event means for a map. Browsers report a mouse wheel, a
 * trackpad's two-finger scroll and a trackpad pinch all as `wheel` events;
 * they differ only in their numbers.
 *
 * - `zoom`: a mouse wheel's notches (`amount` in notches, positive zooms in).
 * - `pinch`: a trackpad pinch, which browsers send with `ctrlKey` set
 *   (`amount` is the log of the scale, positive zooms in).
 * - `scroll`: a trackpad's two-finger scroll (`dx`, `dy` in CSS pixels, the
 *   way the page would scroll: content moves by minus these).
 */
export type WheelIntent =
  | { readonly kind: 'zoom'; readonly amount: number }
  | { readonly kind: 'pinch'; readonly amount: number }
  | { readonly kind: 'scroll'; readonly dx: number; readonly dy: number };

/** The fields of a `WheelEvent` the classifier reads (`wheelDelta*` are non-standard, absent in Firefox). */
export interface WheelSample {
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
  readonly wheelDeltaX?: number | undefined;
  readonly wheelDeltaY?: number | undefined;
  /** Event time, ms. */
  readonly timeStamp: number;
}

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
/** Legacy wheel units per notch, in every browser that reports them. */
const NOTCH = 120;
/** Pixels a notch is worth when a browser reports lines (Firefox: 3 lines a notch) or pages. */
const PIXELS_PER_LINE = 100 / 3;
const PIXELS_PER_PAGE = 800;
/** A pinch's pixels per e-fold of scale: Chrome and Firefox send about -100·ln(scale). */
const PINCH_PIXELS = 100;
/** Events closer together than this belong to one gesture. */
const GESTURE_GAP_MS = 240;

/**
 * Classifies wheel events, remembering the device across a gesture: a
 * trackpad's momentum tail can produce an event that looks like a mouse's,
 * and a gesture shouldn't switch from panning to zooming halfway.
 */
export class WheelClassifier {
  private device: 'mouse' | 'trackpad' | undefined;
  private last = Number.NEGATIVE_INFINITY;

  classify(event: WheelSample): WheelIntent | undefined {
    // Read deltaMode before the deltas: Firefox reports lines only to pages that ask for the mode first.
    const mode = event.deltaMode;
    const scale = mode === DOM_DELTA_PIXEL ? 1 : mode === DOM_DELTA_LINE ? PIXELS_PER_LINE : PIXELS_PER_PAGE;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    if (dx === 0 && dy === 0) return undefined;

    const continuing = event.timeStamp - this.last < GESTURE_GAP_MS;
    this.last = event.timeStamp;
    const looks = deviceOf(event);
    if (!continuing || this.device === undefined) this.device = looks;
    // Once a gesture is known to come from a trackpad, it stays one; a mouse can still turn out to be
    // a trackpad (its first event was ambiguous).
    else if (looks === 'trackpad') this.device = 'trackpad';

    if (event.ctrlKey) {
      // A pinch, or ctrl + a mouse wheel (zoom either way: never the browser's page zoom).
      if (this.device === 'mouse') return { kind: 'zoom', amount: -notches(event, dy) };
      return { kind: 'pinch', amount: -dy / PINCH_PIXELS };
    }
    if (this.device === 'trackpad') return { kind: 'scroll', dx, dy };
    // A mouse's horizontal wheel (or shift + wheel) pans sideways; its vertical wheel zooms.
    if (dy === 0) return { kind: 'scroll', dx, dy: 0 };
    return { kind: 'zoom', amount: -notches(event, dy) };
  }
}

/** Mouse-wheel notches in a vertical delta (fractional for high-resolution wheels). */
const notches = (event: WheelSample, dy: number): number => {
  const legacy = event.wheelDeltaY;
  if (legacy !== undefined && legacy !== 0) return -legacy / NOTCH;
  return dy / 100;
};

/**
 * Which device an event most likely came from, on its own:
 * - Lines or pages: a mouse (Firefox reports a mouse wheel in lines).
 * - Chrome and Safari give a trackpad's legacy delta as exactly -3× its pixel
 *   delta; a mouse's comes in multiples of 120 a notch.
 * - Without the legacy delta (Firefox), pixel deltas mean a trackpad.
 */
export const deviceOf = (event: WheelSample): 'mouse' | 'trackpad' => {
  if (event.deltaMode !== DOM_DELTA_PIXEL) return 'mouse';
  const legacyY = event.wheelDeltaY;
  const legacyX = event.wheelDeltaX;
  if (legacyY === undefined && legacyX === undefined) return 'trackpad';
  const vertical = event.deltaY !== 0;
  const pixel = vertical ? event.deltaY : event.deltaX;
  const legacy = (vertical ? legacyY : legacyX) ?? 0;
  if (legacy === 0) return 'trackpad';
  if (Math.abs(legacy + 3 * pixel) < 1) return 'trackpad';
  // Both axes moving at once is a trackpad (a mouse wheel moves one).
  if (event.deltaX !== 0 && event.deltaY !== 0) return 'trackpad';
  return legacy % NOTCH === 0 ? 'mouse' : 'trackpad';
};
