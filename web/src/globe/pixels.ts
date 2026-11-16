/**
 * Cesium sizes points, lines, billboards and labels in CSS pixels at any
 * drawing-buffer density (labels are signed-distance-field glyphs, sharp at
 * any size). Billboard images are the exception: an image is drawn at its
 * own pixel size, so at 2× it's upscaled and soft. `svgIcon` rasterizes an
 * SVG at the buffer's density and says what size to draw it.
 */

/** A billboard image and the size (CSS pixels, at scale 1) to draw it: spread into `billboards.add`. */
export interface Icon {
  readonly image: string;
  readonly width: number;
  readonly height: number;
}

/** An SVG icon of `width` × `height` CSS pixels, rasterized at `ratio`. `viewBox` defaults to the CSS size. */
export const svgIcon = (
  ratio: number,
  width: number,
  height: number,
  body: string,
  viewBox = `0 0 ${width} ${height}`,
): Icon => ({
  image: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * ratio)}" height="${Math.round(height * ratio)}" viewBox="${viewBox}">${body}</svg>`,
  )}`,
  width,
  height,
});

/**
 * Drawing-buffer pixels per CSS pixel: the screen's own density, so the globe,
 * points, lines and text are sharp on high-DPI screens, within a budget of
 * pixels a GPU can fill every frame (a 5K screen draws at 1.5×).
 */
const PIXEL_BUDGET = 3840 * 2160;
const MAX_PIXEL_RATIO = 2;
export const choosePixelRatio = (devicePixelRatio: number, cssWidth: number, cssHeight: number): number =>
  Math.max(
    1,
    Math.min(devicePixelRatio, MAX_PIXEL_RATIO, Math.sqrt(PIXEL_BUDGET / Math.max(1, cssWidth * cssHeight))),
  );
