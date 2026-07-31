/*
 * RIDE AND BIKE — shared hero road definition.
 *
 * The hero composites two independent WebGL2 layers: hero-road.embed.html
 * paints the coastal storm road, bike-scene.embed.html paints the product
 * with a transparent clear colour on top of it. Two renderers can only agree
 * on where "the road" is if they agree on three things exactly:
 *
 *   1. the road spline (world metres),
 *   2. the road surface formula (crown + banking),
 *   3. the camera (fov, position, target, aspect).
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
 * Mirrors ribbonGeometry()'s crown and bank in hero-road.embed.html exactly,
 * so a wheel placed here touches the rendered asphalt and not the air above
 * it. Keep the two in lockstep.
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

export const HERO_CAMERA = {
  desktop:{ fov:52, near:0.1, far:340, position:[0.15, 2.22, 11.4], target:[2.3, 0.48, -29] },
  mobile: { fov:61, near:0.1, far:340, position:[0.25, 2.55, 12.7], target:[1.0, 0.55, -23] }
};

export function heroCameraFor(width, height){
  return isHeroMobile(width, height) ? HERO_CAMERA.mobile : HERO_CAMERA.desktop;
}

/** Drive any PerspectiveCamera onto the shared hero framing. */
export function applyHeroCamera(camera, width, height){
  const preset = heroCameraFor(width, height);
  camera.fov = preset.fov;
  camera.near = preset.near;
  camera.far = preset.far;
  camera.aspect = width / height;
  camera.up.set(0, 1, 0);
  camera.position.set(preset.position[0], preset.position[1], preset.position[2]);
  camera.lookAt(preset.target[0], preset.target[1], preset.target[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return preset;
}
