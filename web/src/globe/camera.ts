/** Camera geometry for `Navigator`: no DOM, so it's testable on its own. */
import {
  BoundingSphere,
  type Camera,
  Cartesian3,
  Interval,
  IntersectionTests,
  Math as CesiumMath,
  Matrix3,
  Quaternion,
  Ray,
} from 'cesium';

/** Where the camera starts tilting toward the horizon, and how far it's tilted at street level. */
const TILT_FROM = 12_000;
const TILT_TO = 400;
const STREET_PITCH = CesiumMath.toRadians(-28);

/** The pitch that suits a camera height: straight down above `TILT_FROM`, tilted near the ground. */
export const pitchFor = (height: number): number => {
  if (height >= TILT_FROM) return -CesiumMath.PI_OVER_TWO;
  // Logarithmic in height: each halving of the distance tilts by about as much.
  const t = Math.min(1, Math.log(TILT_FROM / Math.max(TILT_TO, height)) / Math.log(TILT_FROM / TILT_TO));
  const eased = t * t * (3 - 2 * t);
  return -CesiumMath.PI_OVER_TWO + (STREET_PITCH + CesiumMath.PI_OVER_TWO) * eased;
};

const scratchQuaternion = new Quaternion();
const scratchRotation = new Matrix3();
const scratchSphere = new BoundingSphere();
const scratchInterval = new Interval();

/** Turns the camera rigidly about an axis through the Earth's center (right-handed, radians). */
export const rotateCamera = (camera: Camera, axis: Cartesian3, angle: number): void => {
  const rotation = Matrix3.fromQuaternion(
    Quaternion.fromAxisAngle(axis, angle, scratchQuaternion),
    scratchRotation,
  );
  Matrix3.multiplyByVector(rotation, camera.position, camera.position);
  Matrix3.multiplyByVector(rotation, camera.direction, camera.direction);
  Matrix3.multiplyByVector(rotation, camera.up, camera.up);
  Matrix3.multiplyByVector(rotation, camera.right, camera.right);
};

/** Where a ray meets the sphere of `radius` about the Earth's center: the near side, or the far one from inside. */
export const hitSphere = (ray: Ray, radius: number, result: Cartesian3): Cartesian3 | undefined => {
  scratchSphere.radius = radius;
  const hit = IntersectionTests.raySphere(ray, scratchSphere, scratchInterval);
  if (!hit) return undefined;
  const t = hit.start > 0 ? hit.start : hit.stop;
  return t > 0 ? Ray.getPoint(ray, t, result) : undefined;
};

/** The rotation about the Earth's center that carries `from` onto `to`'s direction, as axis and angle. */
export const rotationBetween = (
  from: Cartesian3,
  to: Cartesian3,
  axis: Cartesian3,
): { readonly axis: Cartesian3; readonly angle: number } | undefined => {
  Cartesian3.cross(from, to, axis);
  const length = Cartesian3.magnitude(axis);
  if (length < 1e-9 * Cartesian3.magnitude(from) * Cartesian3.magnitude(to)) return undefined;
  Cartesian3.divideByScalar(axis, length, axis);
  return { axis, angle: Math.atan2(length, Cartesian3.dot(from, to)) };
};
