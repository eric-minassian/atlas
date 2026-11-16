import { assert, describe, it } from '@effect/vitest';
import { Cartesian3, Math as CesiumMath, Matrix3, Quaternion, Ray } from 'cesium';
import { hitSphere, pitchFor, rotationBetween } from '../web/src/globe/camera.ts';
import { choosePixelRatio } from '../web/src/globe/pixels.ts';
import { deviceOf, type WheelSample, WheelClassifier } from '../web/src/globe/wheel.ts';

// Wheel events as browsers report them. Chrome and Safari carry the legacy `wheelDelta*` (a mouse
// in multiples of 120 a notch, a trackpad exactly -3× its pixel delta); Firefox reports a mouse
// in lines and has no legacy delta.
const event = (sample: Partial<WheelSample>): WheelSample => ({
  deltaMode: 0,
  deltaX: 0,
  deltaY: 0,
  ctrlKey: false,
  timeStamp: 0,
  ...sample,
});
const chromeMouse = (notches: number, t = 0) =>
  event({ deltaY: 100 * notches, wheelDeltaY: -120 * notches, wheelDeltaX: 0, timeStamp: t });
const macMouse = (notches: number, t = 0) =>
  event({ deltaY: 4.000244140625 * notches, wheelDeltaY: -120 * notches, wheelDeltaX: 0, timeStamp: t });
const trackpad = (dx: number, dy: number, t = 0, ctrlKey = false) =>
  event({ deltaX: dx, deltaY: dy, wheelDeltaX: -3 * dx, wheelDeltaY: -3 * dy, timeStamp: t, ctrlKey });

describe('wheel input', () => {
  it('tells a mouse wheel from a trackpad by the numbers browsers report', () => {
    assert.strictEqual(deviceOf(chromeMouse(1)), 'mouse');
    assert.strictEqual(deviceOf(macMouse(3)), 'mouse');
    assert.strictEqual(deviceOf(event({ deltaMode: 1, deltaY: 3 })), 'mouse');
    assert.strictEqual(deviceOf(trackpad(0, 7)), 'trackpad');
    assert.strictEqual(deviceOf(trackpad(-4, 0)), 'trackpad');
    // Firefox in pixels, without the legacy delta: a trackpad.
    assert.strictEqual(deviceOf(event({ deltaY: 2.5 })), 'trackpad');
    // Windows precision touchpads: legacy deltas that aren't whole notches.
    assert.strictEqual(deviceOf(event({ deltaY: 12.5, wheelDeltaY: -15 })), 'trackpad');
  });

  it('zooms with a mouse wheel, by notches, scrolling up zooming in', () => {
    const classifier = new WheelClassifier();
    assert.deepStrictEqual(classifier.classify(chromeMouse(-1)), { kind: 'zoom', amount: 1 });
    assert.deepStrictEqual(classifier.classify(chromeMouse(2, 1000)), { kind: 'zoom', amount: -2 });
    // Firefox: three lines a notch.
    assert.deepStrictEqual(classifier.classify(event({ deltaMode: 1, deltaY: -3, timeStamp: 2000 })), {
      kind: 'zoom',
      amount: 1,
    });
    // A tilted wheel (or shift + wheel) pans sideways.
    assert.deepStrictEqual(
      classifier.classify(event({ deltaX: 100, wheelDeltaX: -120, wheelDeltaY: 0, timeStamp: 3000 })),
      { kind: 'scroll', dx: 100, dy: 0 },
    );
  });

  it("pans with a trackpad's two-finger scroll and zooms with its pinch", () => {
    const classifier = new WheelClassifier();
    assert.deepStrictEqual(classifier.classify(trackpad(3, -5)), { kind: 'scroll', dx: 3, dy: -5 });
    // A pinch arrives as ctrl + wheel: -100·ln(scale) pixels.
    const pinch = classifier.classify(trackpad(0, -100 * Math.log(1.5), 1000, true));
    assert.strictEqual(pinch?.kind, 'pinch');
    assert.closeTo(pinch?.kind === 'pinch' ? pinch.amount : 0, Math.log(1.5), 1e-9);
    // Ctrl + a mouse wheel zooms by notches, never the page.
    assert.deepStrictEqual(classifier.classify({ ...chromeMouse(-1, 2000), ctrlKey: true }), {
      kind: 'zoom',
      amount: 1,
    });
  });

  it('keeps a gesture on one device once it is known to be a trackpad', () => {
    const classifier = new WheelClassifier();
    assert.strictEqual(classifier.classify(trackpad(0, 12, 0))?.kind, 'scroll');
    // A momentum event that happens to look like a notch, mid-gesture, still pans.
    assert.strictEqual(classifier.classify(chromeMouse(1, 16))?.kind, 'scroll');
    // After a pause, a mouse is a mouse again.
    assert.strictEqual(classifier.classify(chromeMouse(1, 1000))?.kind, 'zoom');
    assert.strictEqual(classifier.classify(event({ deltaY: 0, timeStamp: 1100 })), undefined);
  });
});

describe('camera geometry', () => {
  it('tilts toward the horizon only near the ground', () => {
    assert.strictEqual(pitchFor(20_000_000), -CesiumMath.PI_OVER_TWO);
    assert.strictEqual(pitchFor(12_000), -CesiumMath.PI_OVER_TWO);
    assert.closeTo(pitchFor(400), CesiumMath.toRadians(-28), 1e-9);
    assert.closeTo(pitchFor(10), CesiumMath.toRadians(-28), 1e-9);
    assert.isAbove(pitchFor(2_000), pitchFor(5_000));
  });

  it('meets a sphere on its near side from outside, and its far side from within', () => {
    const outside = new Ray(new Cartesian3(10, 0, 0), new Cartesian3(-1, 0, 0));
    assert.deepStrictEqual(hitSphere(outside, 2, new Cartesian3()), new Cartesian3(2, 0, 0));
    const inside = new Ray(new Cartesian3(0, 0, 0), new Cartesian3(0, 1, 0));
    assert.deepStrictEqual(hitSphere(inside, 2, new Cartesian3()), new Cartesian3(0, 2, 0));
    const away = new Ray(new Cartesian3(10, 0, 0), new Cartesian3(1, 0, 0));
    assert.isUndefined(hitSphere(away, 2, new Cartesian3()));
  });

  it('finds the rotation that carries one point onto another', () => {
    const from = Cartesian3.fromDegrees(10, 20);
    const to = Cartesian3.fromDegrees(12.5, 21);
    const rotation = rotationBetween(from, to, new Cartesian3());
    assert.isDefined(rotation);
    if (!rotation) return;
    const turned = Matrix3.multiplyByVector(
      Matrix3.fromQuaternion(Quaternion.fromAxisAngle(rotation.axis, rotation.angle)),
      from,
      new Cartesian3(),
    );
    // Onto its direction (points on the ellipsoid at different latitudes differ in radius).
    assert.closeTo(Cartesian3.angleBetween(turned, to), 0, 1e-12);
    assert.closeTo(Cartesian3.magnitude(turned), Cartesian3.magnitude(from), 1e-6);
    assert.isUndefined(rotationBetween(from, from, new Cartesian3()));
  });
});

describe('drawing resolution', () => {
  it("draws at the screen's density, within a pixel budget", () => {
    assert.strictEqual(choosePixelRatio(1, 1920, 1080), 1);
    assert.strictEqual(choosePixelRatio(2, 1512, 982), 2);
    assert.strictEqual(choosePixelRatio(3, 430, 932), 2);
    assert.strictEqual(choosePixelRatio(1.25, 1536, 864), 1.25);
    // A 5K display at 2×: about the pixels of a 4K screen.
    assert.closeTo(choosePixelRatio(2, 2560, 1440), 1.5, 1e-9);
    assert.strictEqual(choosePixelRatio(0.9, 1920, 1080), 1);
  });
});
