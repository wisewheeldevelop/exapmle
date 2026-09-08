/*
 * RIDE AND BIKE — shared hero road definition.
 *
 * The hero used to composite two WebGL2 layers: hero-road.embed.html built
 * the asphalt, the sea and the storm at runtime, and bike-scene.embed.html
 * drew the product on a transparent pane over it. The road layer is gone —
 * the background is a photograph now — but the spline below survives,
 * invisible, because ride-director.js and free-ride.js still need a surface
 * to drive the vehicle along.
 *
 * So the agreement is no longer between two renderers, it is between one
 * renderer and a photograph, and it still needs the same three things:
 *
 *   1. the road spline (world metres),
 *   2. the road surface formula (crown + banking),
 *   3. the camera — which is now the photographer's camera, measured off
 *      the pixels in HERO_PHOTO below.
 *
 * All three live here, and nowhere else. Never fork these numbers into a
 * scene file — a copy that drifts by a millimetre puts the bike in the sea.
 */

export const ROAD_WIDTH = 13.8;

/** Control points of the coastal road, in world metres. +Z is toward the camera. */
export const ROAD_CONTROL_POINTS = [
  [ 0.0, 0.00,   18],
  [ 0.0, 0.00,    6],
  [ 0.35, 0.00,  -7],
  [ 1.5,  0.05, -20],
  [ 4.4,  0.22, -36],
  [ 8.1,  0.50, -55],
  [12.4,  0.82, -79],
  [13.8,  1.05, -108],
  [10.5,  1.25, -145]
];

export function createRoadCurve(THREE){
  return new THREE.CatmullRomCurve3(
    ROAD_CONTROL_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  );
}

/**
 * Orthonormal road frame at arc-length ratio u.
 * `tangent` points away from the camera (increasing u), `right` is the
 * road's right-hand side as seen while driving away from the camera.
 * `out` must carry three THREE.Vector3 fields so this stays allocation free.
 */
export function roadFrameAt(curve, u, out){
  const t = Math.min(1, Math.max(0, u));
  curve.getPointAt(t, out.center);
  curve.getTangentAt(t, out.tangent).normalize();
  out.right.set(-out.tangent.z, 0, out.tangent.x).normalize();
  return out;
}

/**
 * Height of the driving surface `lane` metres right of the centreline.
 * Mirrors buildRoadRibbon()'s crown and bank below, so a wheel placed here
 * touches the same surface the test-ride circuit renders. Keep them in
 * lockstep.
 */
export function roadSurfaceHeight(frame, lane, width = ROAD_WIDTH){
  const crown = Math.max(0, 1 - Math.abs(2 * lane / width)) * 0.075;
  const bend = Math.min(0.035, Math.max(-0.035, -frame.tangent.x * 0.06));
  return frame.center.y + crown + bend * lane;
}

/** Slope of the surface across the road, used for wheel-contact banking. */
export function roadBankSlope(frame){
  return Math.min(0.035, Math.max(-0.035, -frame.tangent.x * 0.06));
}

/* ─────────────────────────────────────────────────────────────────────
   TEST-RIDE CIRCUIT
   The hero road is an open spline that ends. A test ride has to be
   endless, and endless-straight is boring: a closed circuit gives corners
   worth leaning into, a straight worth opening the throttle on, and it
   never needs to be recycled or teleported.
   ───────────────────────────────────────────────────────────────────── */
/* The circuit is the hero road. Riding a different track would throw away the
   spline, the width, the crown and the lane markings the hero already sells,
   and would give the visitor a second, unfamiliar place. So the test ride
   takes ROAD_CONTROL_POINTS verbatim as its main section and closes the loop
   with a return leg out over the flats — same asphalt, same lanes, endless. */
export const CIRCUIT_WIDTH = ROAD_WIDTH;
export const CIRCUIT_RETURN_POINTS = [
  [   2.0, 1.20, -172],   // sweeping left off the end of the coast road
  [ -32.0, 1.00, -190],
  [ -74.0, 0.80, -178],
  [ -98.0, 0.60, -142],
  [-104.0, 0.40,  -96],
  [ -92.0, 0.25,  -50],
  [ -66.0, 0.12,  -14],
  [ -38.0, 0.04,   14],
  [ -16.0, 0.00,   26]    // rejoins the coast road at the start line
];

export function createCircuitCurve(THREE){
  const points = [...ROAD_CONTROL_POINTS, ...CIRCUIT_RETURN_POINTS]
    .map(([x, y, z]) => new THREE.Vector3(x, y, z));
  return new THREE.CatmullRomCurve3(
    points,
    true,          // closed: laps come for free
    'centripetal', // no cusps or self-intersections at the tight corners
    0.5
  );
}

/**
 * Ribbon geometry for a road curve, with the same crown and banking the hero
 * road uses so both surfaces feel like the same material.
 */
export function buildRoadRibbon(THREE, curve, {
  width = CIRCUIT_WIDTH, segments = 420, crossSegments = 6,
  yOffset = 0, bank = true, lateral = 0
} = {}){
  const positions = [], uvs = [], indices = [];
  const centre = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  for(let i = 0; i <= segments; i++){
    const t = i / segments;
    curve.getPointAt(t, centre);
    curve.getTangentAt(t, tangent).normalize();
    right.set(-tangent.z, 0, tangent.x).normalize();
    const bend = bank ? Math.min(0.035, Math.max(-0.035, -tangent.x * 0.06)) : 0;
    for(let j = 0; j <= crossSegments; j++){
      const f = j / crossSegments;
      const across = (f - 0.5) * width + lateral;
      const crown = bank ? Math.max(0, 1 - Math.abs((f - 0.5) * 2)) * 0.075 : 0;
      positions.push(
        centre.x + right.x * across,
        centre.y + yOffset + crown + bend * across,
        centre.z + right.z * across
      );
      uvs.push(f, t * segments * 0.06);
    }
  }
  for(let i = 0; i < segments; i++)for(let j = 0; j < crossSegments; j++){
    const row = crossSegments + 1;
    const a = i * row + j, b = a + 1, c = (i + 1) * row + j, d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The hero uses one viewport predicate. The road scene and the product scene
 * must switch framing on the same pixel or the layers separate mid-resize.
 */
export function isHeroMobile(width = innerWidth, height = innerHeight){
  return width < 700 || height > width * 1.35;
}

/* ─────────────────────────────────────────────────────────────────────
   HERO CAMERA — calibrated to the coastal road photograph

   The hero background is a photograph now, and the road spline above is
   invisible: it exists only so the vehicle has a surface to drive along.
   For the wheels to sit on the *painted* asphalt, this camera has to be
   the camera that took the photograph.

   Three numbers per photo pin that down, and all three were measured off
   the pixels rather than guessed:

     horizon  ndc-Y of the sea horizon ......... gives the pitch
     vanish   ndc-X of the road's near-field
              vanishing point .................. gives the yaw
     fov      vertical FOV at the photo's own
              aspect ratio ..................... gives the scale

   Measured on the source PNGs (ndc: 0 = frame centre, +1 = top/right):

     reka.png        1672x941   horizon y=441 -> +0.0627   vanish x=766 -> -0.0841
     rekamobile.png  941x1672   horizon y=774 -> +0.0742   vanish x=460 -> -0.0224

   `fov` is the one free-ish number: 52° vertical on the landscape plate is
   the framing the hero was always built around, and the portrait plate is
   the same lens turned on its side (52° across its short edge, 81.8° down
   its long one), which is why the two agree about how fast the road
   recedes.

   `eye` is genuinely free — a photograph carries no scale, so nothing in
   the pixels can tell us how high the tripod stood. It is therefore a
   composition knob, not a measurement: it slides the parked vehicle up
   and down the frame without changing its size. Raise it to push the
   vehicle toward the bottom edge, lower it to lift it toward the horizon.
   ───────────────────────────────────────────────────────────────────── */

export const HERO_PHOTO = {
  desktop:{
    aspect : 1672 / 941,   // reka.avif
    fov    : 52,
    horizon: +0.0627,
    vanish : -0.0841,
    eye    : 2.00,         // metres above the asphalt — composition knob
    z      : 11.4,         // where along the spline the camera stands
    lane   : 0             // metres right of the centreline
  },
  mobile:{
    aspect : 941 / 1672,   // rekamobile.avif
    fov    : 81.8,
    horizon: +0.0742,
    vanish : -0.0224,
    eye    : 2.30,
    z      : 12.7,
    lane   : 0
  }
};

export function heroCameraFor(width, height){
  return isHeroMobile(width, height) ? HERO_PHOTO.mobile : HERO_PHOTO.desktop;
}

/**
 * Drive any PerspectiveCamera onto the photograph's framing.
 *
 * Pitch and yaw describe where the photographer pointed the lens, so they
 * are properties of the camera and not of the frame — crop the photo any
 * way you like and they do not move. The field of view is the opposite:
 * the plate is painted with `object-fit:cover`, so a viewport that is not
 * the photo's aspect ratio only ever shows part of it. Reproducing that
 * crop in the projection is what nails the rendered horizon to the painted
 * one at every window size, and it only works while the CSS leaves
 * `object-position` centred.
 *
 * Returns the preset plus the `fov` and world-space `target` it resolved
 * to, which is the shape ride-director.js caches.
 */
export function applyHeroCamera(camera, width, height){
  const preset   = heroCameraFor(width, height);
  const viewport = width / height;
  const tanRef   = Math.tan(preset.fov * Math.PI / 360);

  // cover: wider than the plate keeps its full width and crops the height;
  // narrower than the plate keeps its full height and crops the width.
  const tanV = viewport >= preset.aspect
    ? tanRef * preset.aspect / viewport
    : tanRef;

  const pitch = Math.atan(preset.horizon * tanRef);                  // down +
  const yaw   = Math.atan(-preset.vanish * tanRef * preset.aspect);  // right +
  const cosP  = Math.cos(pitch);

  const target = [
    preset.lane + Math.sin(yaw) * cosP * 30,
    preset.eye  - Math.sin(pitch)       * 30,
    preset.z    - Math.cos(yaw) * cosP  * 30
  ];

  camera.fov    = 2 * Math.atan(tanV) * 180 / Math.PI;
  camera.near   = 0.1;
  camera.far    = 340;
  camera.aspect = viewport;
  camera.up.set(0, 1, 0);
  camera.position.set(preset.lane, preset.eye, preset.z);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  return {...preset, fov: camera.fov, target};
}
