/*
 * RIDE AND BIKE cinematic ride director.
 *
 * One fixed-step source of truth owns world motion, wheel rotation, steering,
 * lean, suspension, the wheelie, the braking skid, the crash and the parent
 * events.
 *
 * Geometry contract
 * -----------------
 * The product renders in its own transparent WebGL2 layer stacked over the
 * road layer. The only way two renderers can share a world is to share the
 * road spline and the camera, so both come from ./road-path.js and neither is
 * touched here. The vehicle is placed by arc length along that spline, which
 * makes "on the asphalt" a structural property rather than something that has
 * to be nudged back into place with screen-space offsets.
 */
import {
  ROAD_WIDTH,
  createRoadCurve,
  roadFrameAt,
  roadSurfaceHeight,
  applyHeroCamera,
  isHeroMobile
} from './road-path.js';

export function createRideDirector(options){
  const {
    THREE, scene, camera, controls, renderer, composer, grade, bloom,
    products, dimensions, applySteering, query, onProductChanged, rig
  } = options;

  const FIXED_DT = 1 / 120;
  const GRAVITY = 9.81;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = v => clamp(v, 0, 1);
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth5 = v => {
    v = clamp01(v);
    return v * v * v * (v * (v * 6 - 15) + 10);
  };

  const seedValue = Number.parseInt(query.get('seed') || '1234', 10) || 1234;
  const seedA = seedValue * 0.017453292519943295;
  const forceReduced = query.get('reducedMotion') === '1';
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reducedMotion = forceReduced || prefersReduced;
  const quality = ['low', 'medium', 'high', 'ultra'].includes(query.get('quality'))
    ? query.get('quality')
    : (innerWidth < 600 ? 'medium' : 'high');

  /* ── the shared road ───────────────────────────────────────────── */
  const roadCurve = createRoadCurve(THREE);
  const roadLength = roadCurve.getLength();
  const frameScratch = {
    center:new THREE.Vector3(),
    tangent:new THREE.Vector3(),
    right:new THREE.Vector3()
  };
  const frameScratchB = {
    center:new THREE.Vector3(),
    tangent:new THREE.Vector3(),
    right:new THREE.Vector3()
  };

  /* ── staging ───────────────────────────────────────────────────────
     Every distance below is metres of arc length measured from the start
     of the spline (z = +18, behind the camera). The vehicle travels toward
     the camera, so arc length decreases over the shot.                    */
  function layout(){
    const mobile = isHeroMobile(innerWidth, innerHeight);
    return mobile
      /* entryS sits at the far end of the visible asphalt. It used to start
         further back still, but between ~80 m and ~120 m the vehicle moves
         barely sixteen screen pixels — all that extra distance bought was a
         far approach so fast it had to be hidden, and no room left for the
         wheelie to happen where anyone could see it. */
      ? {mobile:true,  entryS:76, restS:13.4,  farLane:-3.0, restLane:0.30,  slideLane:-0.31, drift:1.46,
         ctaArc:13.50, ctaLane:-0.20, ctaDrift:1.28}
      : {mobile:false, entryS:84, restS:12.45, farLane:-3.2, restLane:-1.15, slideLane:-1.72, drift:1.55,
         /* Where the shot finishes: rolled forward out of the skid and parked
            across the copy column, which is the only place on this road that
            is both close enough to read the product and clear of the headline. */
         ctaArc:11.45, ctaLane:1.55, ctaDrift:1.30};
  }
  let stage = layout();

  // Named windows of the 12 s shot. Kept as data so the state machine, the
  // emitted events and the QA seek() all read the identical staging.
  function buildStates(mode){
    if(reducedMotion){
      return [
        {name:'IDLE',        start:0.00, end:0.20, phase:'initialization'},
        {name:'APPROACH_MID',start:0.20, end:1.30, phase:'approach'},
        {name:'FINAL_POSE',  start:1.30, end:1.80, phase:'final'}
      ];
    }
    const wheelie = mode === 'wheelie';
    // The wheelie is the centrepiece: a hard snap-up, then a two-second
    // high hold with live balance corrections, then the front slams down
    // straight into a long locked-rear skid.
    return [
      {name:'IDLE',              start:0.00, end:0.35,  phase:'initialization'},
      {name:'APPROACH_FAR',      start:0.35, end:2.40,  phase:'approach'},
      {name:'APPROACH_MID',      start:2.40, end:3.20,  phase:'approach'},
      {name:wheelie?'WHEELIE_LIFT':'ACCELERATE', start:3.20, end:3.85, phase:wheelie?'wheelie':'accelerate'},
      {name:wheelie?'WHEELIE_HOLD':'CARVE',      start:3.85, end:5.65, phase:wheelie?'wheelie':'carve'},
      {name:'FRONT_LANDING',     start:5.65, end:6.20,  phase:'landing'},
      {name:'BRAKE_SKID',        start:6.20, end:8.20,  phase:'skid'},
      {name:'CRASH_IMPACT',      start:8.20, end:8.60,  phase:'impact'},
      {name:'SUSPENSION_SETTLE', start:8.60, end:9.20,  phase:'settle'},
      /* The stop is a beat, not the ending. Having pulled up broadside the
         bike is already pointing across the frame, so rolling on to the copy
         column is simply riding forward — and it leaves the product parked
         where the buying decision is made instead of out in the scenery. */
      {name:'ROLL_TO_CTA',       start:9.20, end:11.00, phase:'approach-cta'},
      {name:'FINAL_POSE',        start:11.00,end:11.40, phase:'final'}
    ];
  }

  function buildRoute(){
    const {entryS, restS} = stage;
    if(reducedMotion){
      return monotoneSpline([
        {t:0.00, s:entryS * 0.30},
        {t:0.60, s:entryS * 0.20},
        {t:1.30, s:restS + 6},
        {t:1.80, s:restS}
      ]);
    }
    // Arc-length keyframes. Monotone cubic interpolation gives a continuous,
    // never-overshooting speed curve, so acceleration, wheel spin and lean
    // all fall out of the staging instead of being animated separately.
    //
    // The profile is deliberately front-loaded: beyond ~45 m the vehicle is
    // barely a dozen pixels tall, so the shot burns the far half of the road
    // fast and spends its screen time where the product is legible.
    const span = entryS - restS;
    const at = f => restS + span * f;
    const ctaArc = stage.ctaArc;
    return monotoneSpline([
      {t:0.00,  s:entryS},
      {t:0.35,  s:at(0.9230)},  // already at speed as it clears the far bend
      {t:1.70,  s:at(0.6226)},
      {t:3.20,  s:at(0.3012)},  // front comes up at ~11 m/s
      {t:3.85,  s:at(0.1964)},
      /* The hold deliberately bleeds speed: a slow high wheelie is both the
         showier read and the only way it fits in the metres left before the
         camera. It ends around 16 m out, where the bike is finally large
         enough on screen for the pose to land. */
      {t:5.65,  s:at(0.0496)},
      {t:6.20,  s:at(0.0300)},  // front down, brakes on
      {t:8.20,  s:at(0.0024)},  // locked rear, broadside, impact
      {t:8.60,  s:at(0.0007)},
      {t:9.20,  s:restS},       // dead stop, one beat
      {t:10.10, s:mix(restS,ctaArc,0.55)},
      {t:11.00, s:ctaArc},      // parked across the copy
      {t:11.40, s:ctaArc}
    ]);
  }

  /* Fritsch–Carlson monotone cubic Hermite: position and its exact
     derivative, so speed never has to be differenced numerically. */
  function monotoneSpline(points){
    const n = points.length;
    const dt = new Array(n - 1);
    const slope = new Array(n - 1);
    for(let i = 0; i < n - 1; i++){
      dt[i] = points[i + 1].t - points[i].t;
      slope[i] = (points[i + 1].s - points[i].s) / dt[i];
    }
    const m = new Array(n);
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];
    for(let i = 1; i < n - 1; i++){
      if(slope[i - 1] * slope[i] <= 0){
        m[i] = 0;
      }else{
        const w1 = 2 * dt[i] + dt[i - 1];
        const w2 = dt[i] + 2 * dt[i - 1];
        m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
      }
    }
    return {points, m, dt, duration:points[n - 1].t};
  }

  function evalRoute(route, time){
    const p = route.points;
    const n = p.length;
    if(time <= p[0].t) return {s:p[0].s, speed:Math.max(0, -route.m[0])};
    if(time >= p[n - 1].t) return {s:p[n - 1].s, speed:0};
    let i = 0;
    while(i < n - 2 && time > p[i + 1].t) i++;
    const h = route.dt[i];
    const x = (time - p[i].t) / h;
    const x2 = x * x;
    const x3 = x2 * x;
    const s =
      (2 * x3 - 3 * x2 + 1) * p[i].s +
      (x3 - 2 * x2 + x) * h * route.m[i] +
      (-2 * x3 + 3 * x2) * p[i + 1].s +
      (x3 - x2) * h * route.m[i + 1];
    const ds =
      (6 * x2 - 6 * x) * p[i].s / h +
      (3 * x2 - 4 * x + 1) * route.m[i] +
      (-6 * x2 + 6 * x) * p[i + 1].s / h +
      (3 * x2 - 2 * x) * route.m[i + 1];
    return {s, speed:Math.max(0, -ds)};
  }

  /** Lateral offset from the centreline. The rider tucks toward the crown as
      the shot closes in, which also supplies the gentle natural yaw. */
  function laneAt(s){
    const t = smooth5(clamp01((s - stage.restS) / 44));
    return mix(stage.restLane, stage.farLane, t);
  }

  /** World pose of the rear contact patch at arc length s. */
  function samplePath(s, out){
    const u = clamp01(s / roadLength);
    roadFrameAt(roadCurve, u, frameScratch);
    const lane = laneAt(s);
    out.copy(frameScratch.center).addScaledVector(frameScratch.right, lane);
    out.y = roadSurfaceHeight(frameScratch, lane);
    return out;
  }

  /** World pose at arc length s, on an explicitly chosen lane. */
  function samplePathLane(s, lane, out){
    const u = clamp01(s / roadLength);
    roadFrameAt(roadCurve, u, frameScratch);
    out.copy(frameScratch.center).addScaledVector(frameScratch.right, lane);
    out.y = roadSurfaceHeight(frameScratch, lane);
    return out;
  }

  function pathHeadingAt(s){
    samplePath(s, scratch.pathA);
    samplePath(Math.max(0, s - 0.75), scratch.pathB);
    scratch.direction.copy(scratch.pathB).sub(scratch.pathA);
    if(scratch.direction.lengthSq() < 1e-9) return -Math.PI / 2;
    return Math.atan2(-scratch.direction.z, scratch.direction.x);
  }

  const STATE_TABLE_CACHE = new Map();
  function statesFor(mode){
    const key = `${mode}|${reducedMotion}`;
    if(!STATE_TABLE_CACHE.has(key)) STATE_TABLE_CACHE.set(key, buildStates(mode));
    return STATE_TABLE_CACHE.get(key);
  }

  const state = {
    sessionId: null,
    product: query.get('iso') === 'scooter' ? 'scooter' : 'bike',
    mode: query.get('ride') || '',
    running: false,
    active: true,
    pendingStartEpoch: 0,
    started: false,
    complete: false,
    suppressEvents: false,
    accumulator: 0,
    simTime: 0,
    renderProgress: 0,
    duration: 12,
    stateName: 'IDLE',
    stateProgress: 0,
    previousStateName: '',
    arc: 0,
    previousArc: 0,
    rearAxle: new THREE.Vector3(),
    previousRearAxle: new THREE.Vector3(),
    surfaceY: 0,
    speed: 0,
    previousSpeed: 0,
    acceleration: 0,
    heading: -Math.PI / 2,
    previousHeading: -Math.PI / 2,
    pathHeading: -Math.PI / 2,
    drift: 0,
    yawRate: 0,
    steering: 0,
    previousSteering: 0,
    steeringVelocity: 0,
    lean: 0,
    previousLean: 0,
    leanVelocity: 0,
    pitch: 0,
    previousPitch: 0,
    pitchVelocity: 0,
    frontCompression: 0,
    previousFrontCompression: 0,
    frontCompressionVelocity: 0,
    rearCompression: 0,
    previousRearCompression: 0,
    rearCompressionVelocity: 0,
    frontWheelAngle: 0,
    previousFrontWheelAngle: 0,
    rearWheelAngle: 0,
    previousRearWheelAngle: 0,
    frontOmega: 0,
    rearOmega: 0,
    frontAirborne: false,
    rearLocked: false,
    ctaBlend: 0,
    idleTime: 0,
    idleRev: 0,
    encoreTime: 0,
    encorePhase: '',
    encoreParked: true,
    landingImpulse: 0,
    crashImpulse: 0,
    torqueEnvelope: 0,
    roadRoughness: 0,
    lastPhaseMessage: -1,
    eventFlags: new Set(),
    cameraPosition: new THREE.Vector3(),
    cameraTarget: new THREE.Vector3(),
    cameraFov: 52,
    fps: 60,
    averageFps: 60,
    minimumFps: 60,
    frameCount: 0,
    fpsTotal: 0
  };

  const scratch = {
    pathA:new THREE.Vector3(),
    pathB:new THREE.Vector3(),
    laneRight:new THREE.Vector3(1, 0, 0),
    direction:new THREE.Vector3(),
    rearOffset:new THREE.Vector3(),
    matrixDummy:new THREE.Object3D(),
    euler:new THREE.Euler(0, 0, 0, 'YXZ')
  };

  let route = buildRoute();

  // Motorcycle rotation order: yaw about world up, then roll about the
  // vehicle's own forward axis, then pitch about its lateral axis. The
  // default XYZ order rolls about world X and folds the bike sideways as
  // soon as the heading leaves zero.
  products.bike.rotation.order = 'YXZ';
  products.scooter.rotation.order = 'YXZ';

  const sprayCount = quality === 'low' ? 26 : quality === 'medium' ? 44 : 72;
  const sprayGeometry = new THREE.IcosahedronGeometry(0.011, 0);
  const sprayMaterial = new THREE.MeshBasicMaterial({
    color:0xdce8ee, transparent:true, opacity:0.30, depthWrite:false
  });
  const spray = new THREE.InstancedMesh(sprayGeometry, sprayMaterial, sprayCount);
  spray.name = 'seededWheelSpray';
  spray.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  spray.frustumCulled = false;
  scene.add(spray);
  const droplets = Array.from({length:sprayCount}, () => ({
    life:0, age:0, x:0, y:-100, z:0, vx:0, vy:0, vz:0, scale:1
  }));
  let sprayCursor = 0;
  let spawnCarry = 0;

  /* ── approach glow ──────────────────────────────────────────────────
     At the far bend the vehicle covers seven pixels and sits behind half a
     kilometre of storm haze. A real headlight is the only thing that would
     read at that range, so the director carries one: an additive sprite on
     the vehicle's lamp, held at a near-constant angular size so it stays a
     visible point of light, then folded away as the product itself becomes
     legible.                                                                */
  const glowTexture = (() => {
    const size = 128;
    const surface = document.createElement('canvas');
    surface.width = surface.height = size;
    const ctx = surface.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0.00, 'rgba(255,252,232,1)');
    gradient.addColorStop(0.14, 'rgba(255,240,180,.72)');
    gradient.addColorStop(0.38, 'rgba(255,206,96,.24)');
    gradient.addColorStop(1.00, 'rgba(255,180,40,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(surface);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  })();
  const headlightGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map:glowTexture, color:0xffe9a8, transparent:true, opacity:0,
    blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false,
    fog:false
  }));
  headlightGlow.name = 'rideApproachGlow';
  headlightGlow.frustumCulled = false;
  headlightGlow.renderOrder = 6;
  scene.add(headlightGlow);
  const glowAnchor = new THREE.Vector3();

  function updateApproachGlow(){
    const object = products[state.product];
    const local = object.userData.headlightLocal || object.userData.rideContactLocal;
    if(!local || state.mode === 'showcase'){
      headlightGlow.visible = false;
      return;
    }
    object.updateMatrixWorld(true);
    glowAnchor.copy(local).applyMatrix4(object.matrixWorld);
    const distance = glowAnchor.distanceTo(camera.position);
    // Constant-ish angular size far away, physical size once it is close.
    const span = clamp(distance * 0.019, 0.30, 2.30);
    headlightGlow.position.copy(glowAnchor);
    headlightGlow.scale.set(span, span, 1);
    // Punch through the haze at range, then hand over to the product itself.
    const reach = clamp01((distance - 7) / 26);
    headlightGlow.material.opacity = mix(0.20, 0.95, reach) * (reducedMotion ? .5 : 1);
    headlightGlow.visible = true;
  }

  const debugPanel = document.createElement('pre');
  debugPanel.id = 'rideDebugTelemetry';
  debugPanel.style.cssText = 'position:fixed;z-index:80;left:12px;top:12px;margin:0;padding:10px 12px;border:1px solid rgba(245,197,24,.45);border-radius:10px;background:rgba(0,0,0,.78);color:#ffe14d;font:11px/1.45 ui-monospace,monospace;pointer-events:none;display:none;white-space:pre';
  document.body.appendChild(debugPanel);

  function emit(type, payload={}){
    if(state.suppressEvents || window.parent === window) return;
    window.parent.postMessage({
      type,
      rideSessionId: state.sessionId,
      product: state.product,
      ...payload
    }, location.origin === 'null' ? '*' : location.origin);
  }

  function emitEvent(name, payload={}){
    if(state.eventFlags.has(name)) return;
    state.eventFlags.add(name);
    emit('ride-event', {event:name, ...payload});
  }

  function currentConfig(time=state.simTime){
    const table = statesFor(state.mode);
    for(let i = 0; i < table.length; i++){
      if(time < table[i].end) return table[i];
    }
    return table[table.length - 1];
  }

  function springScalar(valueKey, velocityKey, target, frequency, damping, dt){
    const x = state[valueKey];
    let velocity = state[velocityKey];
    const omega = Math.PI * 2 * frequency;
    const force = (target - x) * omega * omega - 2 * damping * omega * velocity;
    velocity += force * dt;
    state[valueKey] = x + velocity * dt;
    state[velocityKey] = velocity;
  }

  function setAbsoluteWheelAngles(object, rearAngle, frontAngle){
    const wheels = object.userData.wheels || [];
    for(let wheelIndex = 0; wheelIndex < wheels.length; wheelIndex++){
      const wheel = wheels[wheelIndex];
      const angle = wheelIndex === 0 ? rearAngle : frontAngle;
      for(const part of wheel.userData.spin || []){
        if(part.userData.rideBaseZ === undefined) part.userData.rideBaseZ = part.rotation.z;
        part.rotation.z = part.userData.rideBaseZ - angle;
      }
      if(wheel.userData.rotor){
        const rotor = wheel.userData.rotor;
        if(rotor.userData.rideBaseZ === undefined) rotor.userData.rideBaseZ = rotor.rotation.z;
        rotor.rotation.z = rotor.userData.rideBaseZ - angle;
      }
    }
  }

  function updateStateTransition(config){
    state.stateName = config.name;
    state.stateProgress = clamp01((state.simTime - config.start) / Math.max(.001, config.end - config.start));
    if(config.name === state.previousStateName) return;
    state.previousStateName = config.name;
    emit('ride-phase', {
      phase:config.phase,
      state:config.name,
      progress:clamp01(state.simTime / state.duration)
    });
    if(config.name === 'WHEELIE_LIFT') emitEvent('wheelie-start');
    if(config.name === 'BRAKE_SKID') emitEvent('skid-start');
    if(config.name === 'FINAL_POSE') emitEvent('final-pose');
  }

  /** Micro relief of the asphalt, for suspension chatter only. */
  function surfaceChatter(s){
    return Math.sin(s * 2.31 + seedA) * 0.0038 +
           Math.sin(s * 5.77 + seedA * 1.7) * 0.0021 +
           Math.sin(s * 13.1 + seedA * 0.41) * 0.0009;
  }

  function fixedStep(dt){
    state.previousArc = state.arc;
    state.previousRearAxle.copy(state.rearAxle);
    state.previousSpeed = state.speed;
    state.previousHeading = state.heading;
    state.previousSteering = state.steering;
    state.previousLean = state.lean;
    state.previousPitch = state.pitch;
    state.previousFrontCompression = state.frontCompression;
    state.previousRearCompression = state.rearCompression;
    state.previousFrontWheelAngle = state.frontWheelAngle;
    state.previousRearWheelAngle = state.rearWheelAngle;

    const config = currentConfig();
    updateStateTransition(config);
    const local = state.stateProgress;
    const objectDimensions = dimensions[state.product];
    const wheelbase = objectDimensions.wheelbase;
    const wheelRadius = objectDimensions.wheelRadius;

    /* ── where on the road, and how fast ── */
    const sampled = evalRoute(route, state.simTime);
    state.arc = sampled.s;

    samplePath(state.arc, state.rearAxle);
    // pathHeadingAt() re-uses frameScratch, so keep this frame's lateral axis.
    scratch.laneRight.copy(frameScratch.right);
    state.surfaceY = state.rearAxle.y;
    const chatter = reducedMotion ? 0 : surfaceChatter(state.arc);
    state.roadRoughness = Math.abs(chatter) * 26;

    const previousPathHeading = state.pathHeading;
    state.pathHeading = pathHeadingAt(state.arc);
    const pathYawRate = Math.atan2(
      Math.sin(state.pathHeading - previousPathHeading),
      Math.cos(state.pathHeading - previousPathHeading)
    ) / Math.max(dt, 1e-5);

    /* ── the crash: the rear steps out, the bike swings broadside ── */
    let driftTarget = 0;
    let slideLane = 0;
    let brakeBias = 0;
    if(reducedMotion){
      // Same final composition, reached by a slow turn instead of a skid.
      const turn = smooth5(clamp01((state.simTime - 0.25) / 1.1));
      driftTarget = stage.drift * turn;
      slideLane = (stage.slideLane - stage.restLane) * turn;
    }else{
      if(config.name === 'BRAKE_SKID'){
        // The rear breaks away early and keeps rotating all the way to
        // broadside, with a touch of over-rotation caught at the end.
        const e = smooth5(clamp01(local * 1.12));
        driftTarget = stage.drift * e * (1 + 0.07 * Math.sin(local * Math.PI));
        // The tail swings wide before the bike settles back onto its line —
        // a skid that tracks straight to its rest lane reads as a slow stop.
        slideLane = (stage.slideLane - stage.restLane) * smooth5(clamp01(local * 1.25))
          - 0.62 * Math.sin(local * Math.PI);
        brakeBias = smooth5(clamp01(local * 2.1));
      }else if(config.name === 'CRASH_IMPACT' || config.name === 'SUSPENSION_SETTLE'){
        driftTarget = stage.drift;
        slideLane = stage.slideLane - stage.restLane;
        brakeBias = 1;
      }else if(config.name === 'ROLL_TO_CTA' || config.name === 'FINAL_POSE'){
        /* Stopped broadside, the bike is already pointing across the frame,
           so "roll on to the copy" is simply riding forward. Brakes release
           as it goes, which is what lets the wheels turn again. */
        const roll = config.name === 'FINAL_POSE' ? 1 : smooth5(local);
        driftTarget = mix(stage.drift, stage.ctaDrift, roll);
        slideLane = mix(stage.slideLane, stage.ctaLane, roll) - laneAt(state.arc);
        brakeBias = (1 - roll) * 0.85;
        state.ctaBlend = roll;
      }
    }
    // The lateral wash-out rides on top of the lane curve so the vehicle is
    // still standing on the road when it stops sliding.
    state.drift += (driftTarget - state.drift) * (1 - Math.exp(-dt * 14));
    if(Math.abs(slideLane) > 1e-4){
      state.rearAxle.addScaledVector(scratch.laneRight, slideLane);
      roadFrameAt(roadCurve, clamp01(state.arc / roadLength), frameScratchB);
      state.rearAxle.y = roadSurfaceHeight(frameScratchB, laneAt(state.arc) + slideLane);
      state.surfaceY = state.rearAxle.y;
    }
    state.rearAxle.y += wheelRadius + chatter;

    /* True speed over the ground. Once the bike starts moving sideways —
       through the skid and again as it rolls across to the copy — arc-length
       speed stops describing how fast the wheels are actually turning. */
    const travelled = Math.hypot(
      state.rearAxle.x - state.previousRearAxle.x,
      state.rearAxle.z - state.previousRearAxle.z
    );
    const worldSpeed = travelled / Math.max(dt, 1e-5);
    state.acceleration = clamp((worldSpeed - state.previousSpeed) / Math.max(dt, 1e-5), -40, 40);
    state.speed = worldSpeed;

    state.heading = state.pathHeading + state.drift;
    state.yawRate = Math.atan2(
      Math.sin(state.heading - state.previousHeading),
      Math.cos(state.heading - state.previousHeading)
    ) / Math.max(dt, 1e-5);

    /* ── balance, steering and lean ──────────────────────────────────
       A high wheelie is held with the bars, not with the frame: the rider
       twitches the front wheel left and right the whole way. Those twitches
       plus the matching roll are the whole difference between "the front is
       up" and "someone is showing off".                                  */
    const showboat = !reducedMotion && (config.name === 'WHEELIE_LIFT' || config.name === 'WHEELIE_HOLD');
    const holdPhase = config.name === 'WHEELIE_HOLD' ? local : 0;
    const balanceWobble = showboat
      ? Math.sin(state.simTime * 7.4 + seedA) * .085 +
        Math.sin(state.simTime * 3.1 + seedA * 1.7) * .055
      : 0;

    // Counter-steer into the slide, and leave the bar cocked once it stops:
    // a bike that skidded to a halt never rests with the wheel dead straight.
    const skidCounterSteer = brakeBias > 0 ? -.34 * brakeBias : 0;
    const steeringTarget = clamp(
      Math.atan(wheelbase * pathYawRate / Math.max(state.speed, 1.1)) +
      skidCounterSteer + balanceWobble,
      -.46, .46
    );
    springScalar('steering', 'steeringVelocity', steeringTarget, 2.75, 1, dt);

    const turnRadius = Math.abs(pathYawRate) > .001 ? Math.abs(state.speed / pathYawRate) : 10000;
    let leanTarget = Math.atan((state.speed * state.speed) / (GRAVITY * turnRadius));
    leanTarget *= -Math.sign(pathYawRate || 1);
    leanTarget = clamp(leanTarget, -.235, .235);
    if(showboat){
      // The bike rocks side to side on the rear contact patch as the rider
      // catches it, exaggerated once the hold settles in.
      leanTarget += balanceWobble * .85 * (0.45 + 0.55 * smooth5(holdPhase));
    }
    if(!reducedMotion && brakeBias > 0){
      // Weight on the outside peg through the slide, then a small resting tilt.
      const settle = config.name === 'BRAKE_SKID' ? brakeBias : 1;
      leanTarget = mix(leanTarget, config.name === 'BRAKE_SKID' ? -.30 : -.155, settle);
    }
    if(!reducedMotion && (config.name === 'ROLL_TO_CTA' || config.name === 'FINAL_POSE')){
      // Comes upright to ride, then settles onto a small resting tilt.
      leanTarget = mix(leanTarget, -.075, state.ctaBlend);
    }
    springScalar('lean', 'leanVelocity', leanTarget, 2.0, 1, dt);

    /* ── the wheelie, the landing, and the shunt at impact ────────────
       Snap up past the balance point, catch it, then ride the hold high
       and climbing. The overshoot on the way up is what makes the lift
       read as torque rather than as an animation curve.                  */
    const WHEELIE_PEAK = .84;
    let pitchTarget = 0;
    state.torqueEnvelope = 0;
    if(!reducedMotion){
      if(config.name === 'WHEELIE_LIFT'){
        state.torqueEnvelope = smooth5(local);
        const snap = smooth5(clamp01(local * 1.25));
        // A few degrees past the target, then pulled back — the catch.
        pitchTarget = WHEELIE_PEAK * snap * (1 + .16 * Math.sin(local * Math.PI));
      }else if(config.name === 'WHEELIE_HOLD'){
        state.torqueEnvelope = 1 - .10 * smooth5(local);
        // Held high, drifting a little higher as the rider pushes it, with
        // the small pitch corrections a real balance point demands.
        pitchTarget = mix(WHEELIE_PEAK, WHEELIE_PEAK + .07, smooth5(local))
          + Math.sin(state.simTime * 5.2 + seedA * .6) * .028
          + Math.sin(state.simTime * 2.3) * .018;
      }else if(config.name === 'FRONT_LANDING'){
        state.torqueEnvelope = Math.max(0, 1 - smooth5(local * 1.35));
        // Comes down fast and hard from a much higher angle than before.
        pitchTarget = local < .55 ? mix(WHEELIE_PEAK + .07, .06, smooth5(local / .55)) : 0;
      }else if(config.name === 'BRAKE_SKID'){
        // Nose dive under braking.
        pitchTarget = -.070 * smooth5(clamp01(local * 1.5));
      }else if(config.name === 'CRASH_IMPACT'){
        pitchTarget = -.095 * Math.exp(-local * 5.5);
      }
    }
    const pitchFrequency = config.name === 'FRONT_LANDING' ? 2.85 : 2.35;
    springScalar('pitch', 'pitchVelocity', pitchTarget, pitchFrequency, .94, dt);
    state.pitch = clamp(state.pitch, -.16, 1.02);

    /* ── suspension ── */
    const wasAirborne = state.frontAirborne;
    state.frontAirborne = state.product === 'bike' && state.pitch > .045;
    if(config.name === 'FRONT_LANDING' && wasAirborne && !state.frontAirborne){
      state.landingImpulse = clamp(Math.abs(state.pitchVelocity) * .055 + state.speed * .006, .025, .075);
      emitEvent('landing-impact', {impulse:+state.landingImpulse.toFixed(4)});
    }
    if(config.name === 'CRASH_IMPACT' && !state.eventFlags.has('crash-impact')){
      state.crashImpulse = .085;
      emitEvent('crash-impact', {
        impulse:+state.crashImpulse.toFixed(4),
        speed:+state.speed.toFixed(3)
      });
    }
    state.landingImpulse *= Math.exp(-dt * 5.3);
    state.crashImpulse *= Math.exp(-dt * 4.1);

    const frontTarget = clamp(
      state.landingImpulse + state.crashImpulse +
      Math.max(0, -state.acceleration) * .0026 + Math.abs(chatter) * .9,
      0, objectDimensions.frontTravel
    );
    const rearTarget = clamp(
      state.torqueEnvelope * .018 + Math.max(0, state.acceleration) * .003 +
      state.crashImpulse * .35 + Math.abs(chatter) * .6,
      0, objectDimensions.rearTravel
    );
    springScalar('frontCompression', 'frontCompressionVelocity', frontTarget, 4.8, .82, dt);
    springScalar('rearCompression', 'rearCompressionVelocity', rearTarget, 3.9, .88, dt);
    state.rearAxle.y -= state.rearCompression * .16;

    /* ── wheels: wheelspin lifts the front, a locked rear draws the skid ── */
    const groundOmega = state.speed / wheelRadius;
    // Torque that lifts a front wheel also breaks the rear loose on wet
    // asphalt, so it turns faster than the road underneath it.
    const wheelspin = config.name === 'WHEELIE_LIFT'
      ? 1 + .42 * smooth5(local)
      : (config.name === 'WHEELIE_HOLD' ? 1.30 - .16 * smooth5(local) : 1);
    state.rearLocked = !reducedMotion && brakeBias > .18 && state.speed > .15 &&
      (config.name === 'BRAKE_SKID' || config.name === 'CRASH_IMPACT');
    const rearTargetOmega = state.rearLocked ? 0 : groundOmega * wheelspin;
    state.rearOmega += (rearTargetOmega - state.rearOmega) * (1 - Math.exp(-dt * (state.rearLocked ? 26 : 18)));
    const frontOmegaTarget = state.frontAirborne ? state.frontOmega * .996 : groundOmega;
    const frontResponse = state.frontAirborne ? 1.4 : (state.landingImpulse > .01 ? 24 : 15);
    state.frontOmega += (frontOmegaTarget - state.frontOmega) * (1 - Math.exp(-dt * frontResponse));
    state.rearWheelAngle += state.rearOmega * dt;
    state.frontWheelAngle += state.frontOmega * dt;

    state.simTime = Math.min(state.duration, state.simTime + dt);
    state.renderProgress = clamp01(state.simTime / state.duration);
  }

  function applyVisual(alpha=1){
    const object = products[state.product];
    const dims = dimensions[state.product];
    const x = mix(state.previousRearAxle.x, state.rearAxle.x, alpha);
    const y = mix(state.previousRearAxle.y, state.rearAxle.y, alpha);
    const z = mix(state.previousRearAxle.z, state.rearAxle.z, alpha);
    const headingDelta = Math.atan2(
      Math.sin(state.heading - state.previousHeading),
      Math.cos(state.heading - state.previousHeading)
    );
    const heading = state.previousHeading + headingDelta * alpha;
    const steering = mix(state.previousSteering, state.steering, alpha);
    const lean = mix(state.previousLean, state.lean, alpha);
    const pitch = mix(state.previousPitch, state.pitch, alpha);
    const frontCompression = mix(state.previousFrontCompression, state.frontCompression, alpha);

    object.rotation.set(lean, heading, pitch, 'YXZ');
    scratch.rearOffset.set(-dims.wheelbase * .5, dims.wheelRadius, 0).applyEuler(object.rotation);
    object.position.set(x, y, z).sub(scratch.rearOffset);
    applySteering(object, steering, state.roadRoughness * state.speed * .0009, frontCompression);
    setAbsoluteWheelAngles(
      object,
      mix(state.previousRearWheelAngle, state.rearWheelAngle, alpha),
      mix(state.previousFrontWheelAngle, state.frontWheelAngle, alpha)
    );

    if(state.complete && !reducedMotion && state.mode !== 'showcase' && state.encoreParked){
      applyIdleLife(object);
    }

    // The studio lighting rig and the shadow catcher travel with the product,
    // otherwise everything past a few metres from the origin falls out of the
    // key light's shadow frustum and off the contact shadow.
    if(rig) rig.position.set(x, state.surfaceY, z);

    grade.uniforms.uCA.value = reducedMotion ? 0 : mix(.00035, .00105, clamp01(state.speed / 11));
    grade.uniforms.uGrain.value = quality === 'low' ? .010 : .018;
    grade.uniforms.uVig.value = 0;
    bloom.strength = .22 + clamp01(state.speed / 12) * .08;
    updateApproachGlow();
    updateSpray(alpha);
  }

  /* == the encore =====================================================
     A parked product is a photograph. Once the arrival has played, the
     machine keeps performing: it holds the pose long enough to be read,
     then carves a full lap across the near asphalt and comes back on the
     rear wheel. The show line is a closed curve in (arc, lane) that passes
     exactly through the parked pose, so every cycle rejoins seamlessly.  */
  const ENCORE = {hold:3.0, lap:5.2, wheelie:1.9, settle:0.9};
  ENCORE.cycle = ENCORE.hold + ENCORE.lap + ENCORE.wheelie + ENCORE.settle;

  function encoreRadius(){
    return stage.mobile ? {arc:2.30, lane:1.85} : {arc:3.10, lane:2.55};
  }

  /** Closed show line. u = 0 is the parked pose; u = 1 returns to it.
      The circle is biased entirely away from the camera: a symmetric loop
      swings its near side to about two metres from the lens, where the
      machine is several screens wide and mostly outside the frame. */
  function encorePoint(u, out){
    const r = encoreRadius();
    const angle = u * Math.PI * 2;
    const arc = stage.ctaArc + r.arc * (1 - Math.cos(angle));
    const lane = stage.ctaLane - r.lane * Math.sin(angle);
    samplePathLane(arc, lane, out);
    return {arc, lane};
  }

  function encorePhase(time){
    const t = time % ENCORE.cycle;
    if(t < ENCORE.hold) return {name:'SHOW_HOLD', local:t / ENCORE.hold, u:0};
    const afterHold = t - ENCORE.hold;
    if(afterHold < ENCORE.lap){
      const k = afterHold / ENCORE.lap;
      // Ease out of the pose, commit through the middle, ease back in.
      return {name:'SHOW_LAP', local:k, u:smooth5(k) * 0.78};
    }
    const afterLap = afterHold - ENCORE.lap;
    if(afterLap < ENCORE.wheelie){
      const k = afterLap / ENCORE.wheelie;
      return {name:'SHOW_WHEELIE', local:k, u:0.78 + smooth5(k) * 0.22};
    }
    return {name:'SHOW_SETTLE', local:(afterLap - ENCORE.wheelie) / ENCORE.settle, u:1};
  }

  function encoreStep(dt){
    state.previousRearAxle.copy(state.rearAxle);
    state.previousSpeed = state.speed;
    state.previousHeading = state.heading;
    state.previousSteering = state.steering;
    state.previousLean = state.lean;
    state.previousPitch = state.pitch;
    state.previousFrontCompression = state.frontCompression;
    state.previousRearCompression = state.rearCompression;
    state.previousFrontWheelAngle = state.frontWheelAngle;
    state.previousRearWheelAngle = state.rearWheelAngle;

    state.encoreTime += dt;
    const phase = encorePhase(state.encoreTime);
    if(phase.name !== state.encorePhase){
      state.encorePhase = phase.name;
      emit('ride-phase', {phase:'show', state:phase.name, progress:1});
      emit('ride-event', {event:phase.name === 'SHOW_HOLD' ? 'show-parked' : 'show-moving'});
    }

    const dims = dimensions[state.product];
    const parked = phase.name === 'SHOW_HOLD';
    const placement = encorePoint(phase.u, state.rearAxle);
    state.arc = placement.arc;
    state.surfaceY = state.rearAxle.y;
    state.rearAxle.y += dims.wheelRadius;

    /* Heading follows the show line while moving and the presentation angle
       while parked. Springing between the two is what makes them one
       continuous motion instead of a snap at the top of every lap. */
    let targetHeading;
    if(parked){
      targetHeading = pathHeadingAt(stage.ctaArc) + stage.ctaDrift;
    }else{
      encorePoint(phase.u + 0.012, scratch.pathA);
      scratch.direction.copy(scratch.pathA).sub(state.rearAxle);
      scratch.direction.y = 0;
      targetHeading = scratch.direction.lengthSq() > 1e-8
        ? Math.atan2(-scratch.direction.z, scratch.direction.x)
        : state.heading;
    }
    const turn = Math.atan2(
      Math.sin(targetHeading - state.heading),
      Math.cos(targetHeading - state.heading)
    );
    state.heading += turn * (1 - Math.exp(-dt * (parked ? 3.2 : 7.5)));
    state.yawRate = turn / Math.max(dt, 1e-5);

    const travelled = Math.hypot(
      state.rearAxle.x - state.previousRearAxle.x,
      state.rearAxle.z - state.previousRearAxle.z
    );
    state.speed = travelled / Math.max(dt, 1e-5);
    state.acceleration = clamp((state.speed - state.previousSpeed) / Math.max(dt, 1e-5), -40, 40);

    // Lean into the turn, from the same balance equation the arrival uses.
    const leanTarget = clamp(Math.atan(state.speed * state.yawRate / GRAVITY), -0.42, 0.42)
      + (parked ? -0.075 : 0);
    springScalar('lean', 'leanVelocity', leanTarget, 2.1, 1, dt);

    let pitchTarget = 0;
    if(phase.name === 'SHOW_WHEELIE'){
      // Comes back to the pose on the rear wheel, then sets it down clean.
      /* Peak is set by the frame, not by bravado: at the parked distance a
         higher lift swings the machine straight out of the bottom edge. */
      const lift = Math.sin(clamp01(phase.local) * Math.PI);
      pitchTarget = 0.58 * lift + Math.sin(state.encoreTime * 5.1) * 0.02 * lift;
    }else if(phase.name === 'SHOW_SETTLE'){
      pitchTarget = -0.05 * Math.exp(-phase.local * 5);
    }
    springScalar('pitch', 'pitchVelocity', pitchTarget, 2.4, 0.95, dt);
    state.pitch = clamp(state.pitch, -0.16, 1.02);

    springScalar('steering', 'steeringVelocity', clamp(
      Math.atan(dims.wheelbase * state.yawRate / Math.max(state.speed, 1.1)), -0.42, 0.42
    ), 2.9, 1, dt);

    /* A show lap on a wet road is never clean: the rear steps out through the
       far side of the loop, which is where the spray comes from. */
    const slide = phase.name === 'SHOW_LAP'
      ? clamp01(Math.sin(phase.local * Math.PI) * 1.35 - 0.35)
      : 0;
    state.rearLocked = slide > 0.2;
    springScalar('frontCompression', 'frontCompressionVelocity',
      clamp(Math.max(0, -state.acceleration) * 0.0025, 0, dims.frontTravel), 4.8, 0.82, dt);
    springScalar('rearCompression', 'rearCompressionVelocity',
      clamp(Math.max(0, state.acceleration) * 0.003 + slide * 0.012, 0, dims.rearTravel),
      3.9, 0.88, dt);
    state.rearAxle.y -= state.rearCompression * 0.16;

    const rollOmega = state.speed / dims.wheelRadius;
    state.rearOmega += ((state.rearLocked ? rollOmega * 0.35 : rollOmega) - state.rearOmega)
      * (1 - Math.exp(-dt * 16));
    state.frontOmega += (rollOmega - state.frontOmega) * (1 - Math.exp(-dt * 14));
    state.rearWheelAngle += state.rearOmega * dt;
    state.frontWheelAngle += state.frontOmega * dt;
    state.drift = 0;
    state.roadRoughness = 0;
    state.encoreParked = parked;
  }

  /** Small, continuous life on the parked pose. Amplitudes are deliberately
      tiny: this has to read as a machine settling, never as an animation. */
  function applyIdleLife(object){
    const t = state.idleTime;
    const rev = state.idleRev;
    object.position.y += Math.sin(t * 1.15) * 0.0055 + Math.sin(t * 0.47) * 0.0032 - rev * 0.007;
    object.rotation.z += Math.sin(t * 0.83) * 0.007 + rev * 0.012;
    object.rotation.x += Math.sin(t * 0.61 + 1.2) * 0.011;
    const sweep = Math.sin(t * 0.52) * 0.075 + Math.sin(t * 0.21) * 0.032;
    applySteering(
      object,
      state.steering + sweep,
      rev * 0.005,
      state.frontCompression + rev * 0.005
    );
    setAbsoluteWheelAngles(object, state.rearWheelAngle, state.frontWheelAngle);
  }

  function updateSpray(alpha){
    const visible = !reducedMotion && state.mode !== 'showcase' &&
      (state.speed > 3.2 || state.rearLocked);
    spray.visible = visible;
    if(!visible) return;
    const dt = Math.min(1 / 30, FIXED_DT + state.accumulator);
    // A locked tyre on standing water throws a rooster tail, and it keeps
    // throwing it after the bike has almost stopped — so the rate cannot be
    // driven by speed alone.
    const skid = state.rearLocked ? 5.2 : 1;
    const base = state.rearLocked ? Math.max(state.speed, 3.4) : state.speed;
    spawnCarry += (base * dt) * (quality === 'low' ? 1.4 : 2.6) * skid;
    while(spawnCarry >= 1){
      spawnCarry -= 1;
      const drop = droplets[sprayCursor++ % droplets.length];
      const phase = (sprayCursor * 0.61803398875 + seedValue * .001) % 1;
      drop.life = .34 + phase * (state.rearLocked ? .78 : .28);
      drop.age = 0;
      drop.scale = state.rearLocked ? 3.4 + phase * 3.0 : 1;
      drop.x = state.rearAxle.x - Math.cos(state.heading) * .12;
      drop.y = state.surfaceY + .03;
      drop.z = state.rearAxle.z + Math.sin(state.heading) * .12;
      const back = state.rearLocked ? .9 : (.35 + phase * .45);
      drop.vx = -Math.cos(state.heading) * back + Math.sin(state.heading) * (phase - .5) * .6;
      drop.vy = (state.rearLocked ? .34 : .18) + phase * .32;
      drop.vz = Math.sin(state.heading) * back + Math.cos(state.heading) * (phase - .5) * .6;
    }
    const dummy = scratch.matrixDummy;
    for(let i = 0; i < droplets.length; i++){
      const drop = droplets[i];
      if(drop.age < drop.life){
        drop.age += dt;
        drop.vy -= 1.7 * dt;
        drop.x += drop.vx * dt;
        drop.y += drop.vy * dt;
        drop.z += drop.vz * dt;
        const fade = Math.max(.05, 1 - drop.age / drop.life);
        dummy.position.set(drop.x, drop.y, drop.z);
        dummy.scale.setScalar(fade * drop.scale);
      }else{
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(.01);
      }
      dummy.updateMatrix();
      spray.setMatrixAt(i, dummy.matrix);
    }
    sprayMaterial.opacity = state.rearLocked ? .22 : .30;
    spray.instanceMatrix.needsUpdate = true;
    void alpha;
  }

  function configureQuality(){
    const caps = {low:1, medium:1.35, high:1.75, ultra:2.15};
    const requested = Number.parseFloat(query.get('dpr'));
    const dpr = Number.isFinite(requested)
      ? clamp(requested, .75, 2.25)
      : Math.min(devicePixelRatio, caps[quality]);
    renderer.setPixelRatio(dpr);
    composer.setPixelRatio(dpr);
    return dpr;
  }

  /** Install the shared hero camera. Never animated: the road layer's camera
      is static, and any divergence here slides the product off the asphalt. */
  function installHeroCamera(){
    const preset = applyHeroCamera(camera, innerWidth, innerHeight);
    state.cameraPosition.copy(camera.position);
    state.cameraTarget.set(preset.target[0], preset.target[1], preset.target[2]);
    state.cameraFov = preset.fov;
    return preset;
  }

  function reset(product=state.product, mode=state.mode, sessionId=state.sessionId, announce=true){
    state.product = product === 'scooter' ? 'scooter' : 'bike';
    state.mode = mode || (state.product === 'bike' ? 'wheelie' : 'cruise');
    state.sessionId = sessionId ?? state.sessionId;
    stage = layout();
    route = buildRoute();
    state.duration = state.mode === 'showcase' ? 8.8 : route.duration;
    state.running = false;
    state.pendingStartEpoch = 0;
    state.started = false;
    state.complete = false;
    state.accumulator = 0;
    state.simTime = 0;
    state.renderProgress = 0;
    state.stateName = 'IDLE';
    state.stateProgress = 0;
    state.previousStateName = '';
    state.eventFlags.clear();
    state.lastPhaseMessage = -1;

    state.arc = state.previousArc = route.points[0].s;
    state.pathHeading = pathHeadingAt(state.arc);
    state.heading = state.previousHeading = state.pathHeading;
    state.drift = 0;
    state.yawRate = 0;
    samplePath(state.arc, state.rearAxle);
    state.surfaceY = state.rearAxle.y;
    state.rearAxle.y += dimensions[state.product].wheelRadius;
    state.previousRearAxle.copy(state.rearAxle);
    state.speed = state.previousSpeed = evalRoute(route, 0).speed;
    state.acceleration = 0;
    state.steering = state.previousSteering = state.steeringVelocity = 0;
    state.lean = state.previousLean = state.leanVelocity = 0;
    state.pitch = state.previousPitch = state.pitchVelocity = 0;
    state.frontCompression = state.previousFrontCompression = state.frontCompressionVelocity = 0;
    state.rearCompression = state.previousRearCompression = state.rearCompressionVelocity = 0;
    state.frontWheelAngle = state.previousFrontWheelAngle = 0;
    state.rearWheelAngle = state.previousRearWheelAngle = 0;
    state.frontOmega = state.rearOmega = 0;
    state.frontAirborne = false;
    state.rearLocked = false;
    state.ctaBlend = 0;
    state.idleTime = 0;
    state.idleRev = 0;
    state.encoreTime = 0;
    state.encorePhase = '';
    state.encoreParked = true;
    state.landingImpulse = 0;
    state.crashImpulse = 0;
    state.torqueEnvelope = 0;

    products.bike.visible = state.product === 'bike';
    products.scooter.visible = state.product === 'scooter';
    products.bike.position.set(0, 0, 0);
    products.scooter.position.set(0, 0, 0);
    products.bike.rotation.set(0, 0, 0);
    products.scooter.rotation.set(0, 0, 0);
    applySteering(products.bike, 0, 0, 0);
    applySteering(products.scooter, 0, 0, 0);

    controls.enabled = state.mode === 'showcase';
    controls.autoRotate = false;
    spray.visible = false;
    headlightGlow.visible = false;
    onProductChanged?.(state.product, state.mode);

    if(state.mode === 'showcase'){
      const object = products[state.product];
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, 0);
      if(rig) rig.position.set(0, 0, 0);
      camera.near = .05;
      camera.far = 90;
      camera.fov = 34;
      camera.aspect = innerWidth / innerHeight;
      camera.position.set(.05, .72, innerWidth / innerHeight < 1 ? 4.8 : 3.7);
      camera.updateProjectionMatrix();
      controls.target.set(0, .52, 0);
      controls.enabled = true;
      /* Showcase heroes let visitors turn the product themselves, but only
         turn it: zoom and pan would let them lose the model off-frame, and
         on touch they would fight the page scroll. */
      controls.enableZoom = false;
      controls.enablePan = false;
      controls.rotateSpeed = .65;
      controls.minPolarAngle = Math.PI * .16;
      controls.maxPolarAngle = Math.PI * .50;
      controls.update();
      setAbsoluteWheelAngles(object, 0, 0);
    }else{
      installHeroCamera();
      applyVisual(1);
    }
    if(announce) emit('ride-ready', {
      mode:state.mode,
      reducedMotion,
      duration:state.duration,
      webgl2:renderer.capabilities.isWebGL2
    });
  }

  function start(startAtEpochMs=Date.now(), sessionId=state.sessionId){
    if(sessionId !== undefined && sessionId !== null) state.sessionId = sessionId;
    state.pendingStartEpoch = Number.isFinite(startAtEpochMs) ? startAtEpochMs : Date.now();
    state.running = true;
    state.started = false;
    state.complete = false;
  }

  function stop(){
    state.running = false;
    state.pendingStartEpoch = 0;
  }

  function update(dt){
    if(!state.active) return;
    if(state.mode === 'showcase'){
      controls.enabled = true;
      if(state.running){
        const object = products[state.product];
        /* Sweep instead of spin. A full turntable spends a third of its cycle
           showing the product's back; an oscillation between side profile and
           front three-quarter keeps it presentable at every instant. */
        state.idleTime += dt;
        object.rotation.y = -.38 + Math.sin(state.idleTime * .26) * .55;
        object.position.y = Math.sin(state.idleTime * .8) * .004;
        state.rearWheelAngle += dt * .55;
        state.frontWheelAngle += dt * .55;
        setAbsoluteWheelAngles(object, state.rearWheelAngle, state.frontWheelAngle);
      }
      return;
    }
    controls.enabled = false;
    if(state.running && Date.now() >= state.pendingStartEpoch){
      if(!state.started){
        state.started = true;
        emit('ride-started', {mode:state.mode, duration:state.duration});
      }
      state.accumulator += Math.min(dt, .05);
      let steps = 0;
      while(state.accumulator >= FIXED_DT && steps < 8 && state.simTime < state.duration){
        fixedStep(FIXED_DT);
        state.accumulator -= FIXED_DT;
        steps++;
      }
      if(steps === 8 && state.accumulator >= FIXED_DT) state.accumulator = 0;
      const phaseBucket = Math.floor(state.renderProgress * 40);
      if(phaseBucket !== state.lastPhaseMessage){
        state.lastPhaseMessage = phaseBucket;
        emit('ride-phase', {
          phase:currentConfig().phase,
          state:state.stateName,
          progress:state.renderProgress
        });
      }
      if(state.simTime >= state.duration && !state.complete){
        state.complete = true;
        state.running = false;
        // Hand over to the encore on the exact pose the arrival ended on.
        state.accumulator = FIXED_DT;
        state.renderProgress = 1;
        state.encoreTime = 0;
        state.encorePhase = '';
        state.encoreParked = true;
        state.speed = state.previousSpeed = 0;
        state.acceleration = 0;
        state.frontOmega = 0;
        state.rearOmega = 0;
        emit('ride-complete', {progress:1});
      }
    }
    if(state.complete && !reducedMotion){
      /* Iron rule: the machine is never still. Once the arrival has played it
         runs the encore forever — hold the pose, carve a lap, come back on the
         rear wheel — with the idle breathing layered on only while parked. */
      state.accumulator += Math.min(dt, 0.05);
      let encoreSteps = 0;
      while(state.accumulator >= FIXED_DT && encoreSteps < 8){
        encoreStep(FIXED_DT);
        state.accumulator -= FIXED_DT;
        encoreSteps++;
      }
      if(encoreSteps === 8) state.accumulator = 0;
      if(state.encoreParked){
        state.idleTime += dt;
        const revCycle = (state.idleTime % 7.4) / 7.4;
        state.idleRev = revCycle < 0.11 ? Math.sin(revCycle / 0.11 * Math.PI) : 0;
        state.rearWheelAngle += state.idleRev * 26 * dt;
        state.previousRearWheelAngle = state.rearWheelAngle;
      }else{
        state.idleRev = 0;
      }
    }
    applyVisual(clamp01(state.accumulator / FIXED_DT));
    if(debugPanel.style.display !== 'none' && state.frameCount % 6 === 0){
      const data = telemetry();
      debugPanel.textContent = [
        `${data.currentRideState}  ${(data.normalizedProgress * 100).toFixed(0)}%`,
        `arc    ${data.arcLength.toFixed(2)} m`,
        `speed  ${data.linearSpeed.toFixed(2)} m/s`,
        `wheel  ${data.frontWheelRPM.toFixed(0)} / ${data.rearWheelRPM.toFixed(0)} rpm`,
        `slip   ${data.frontSlipRatio.toFixed(3)} / ${data.slipRatio.toFixed(3)}`,
        `steer  ${(data.steeringAngle * 57.2958).toFixed(2)}°`,
        `lean   ${(data.leanAngle * 57.2958).toFixed(2)}°`,
        `drift  ${(data.driftAngle * 57.2958).toFixed(1)}°`,
        `contact ${(data.rearContactError * 1000).toFixed(1)} mm`
      ].join('\n');
    }
  }

  function seek(progress){
    const requested = clamp01(Number(progress) || 0);
    const oldSuppress = state.suppressEvents;
    state.suppressEvents = true;
    reset(state.product, state.mode, state.sessionId, false);
    const target = state.duration * requested;
    while(state.simTime + FIXED_DT <= target) fixedStep(FIXED_DT);
    if(state.simTime < target) fixedStep(target - state.simTime);
    state.accumulator = 0;
    state.running = false;
    applyVisual(1);
    state.suppressEvents = oldSuppress;
  }

  /** Nearest point on the road spline, for QA contact checks. */
  function sampleRoadHeightAndNormal(worldX, worldZ){
    let bestU = 0;
    let bestDistance = Infinity;
    for(let i = 0; i <= 240; i++){
      const u = i / 240;
      roadFrameAt(roadCurve, u, frameScratchB);
      const dx = frameScratchB.center.x - worldX;
      const dz = frameScratchB.center.z - worldZ;
      const d = dx * dx + dz * dz;
      if(d < bestDistance){ bestDistance = d; bestU = u; }
    }
    roadFrameAt(roadCurve, bestU, frameScratchB);
    const lane =
      (worldX - frameScratchB.center.x) * frameScratchB.right.x +
      (worldZ - frameScratchB.center.z) * frameScratchB.right.z;
    const height = roadSurfaceHeight(frameScratchB, clamp(lane, -ROAD_WIDTH / 2, ROAD_WIDTH / 2));
    return {
      height,
      normal:{x:0, y:1, z:0},
      roughness:Math.abs(surfaceChatter(bestU * roadLength)) * 26,
      u:bestU,
      lane
    };
  }

  function telemetry(){
    const radius = dimensions[state.product].wheelRadius;
    const expectedOmega = state.speed / radius;
    const rearSlip = expectedOmega > .01 ? (state.rearOmega - expectedOmega) / expectedOmega : 0;
    const frontSlip = expectedOmega > .01 ? (state.frontOmega - expectedOmega) / expectedOmega : 0;
    return {
      linearSpeed:+state.speed.toFixed(4),
      acceleration:+state.acceleration.toFixed(4),
      frontWheelRPM:+(state.frontOmega * 60 / (Math.PI * 2)).toFixed(2),
      rearWheelRPM:+(state.rearOmega * 60 / (Math.PI * 2)).toFixed(2),
      slipRatio:+rearSlip.toFixed(4),
      frontSlipRatio:+frontSlip.toFixed(4),
      rearContactError:+(state.rearAxle.y - radius - state.surfaceY).toFixed(5),
      arcLength:+state.arc.toFixed(4),
      steeringAngle:+state.steering.toFixed(5),
      leanAngle:+state.lean.toFixed(5),
      pitchAngle:+state.pitch.toFixed(5),
      driftAngle:+state.drift.toFixed(5),
      frontSuspensionTravel:+state.frontCompression.toFixed(5),
      rearSuspensionTravel:+state.rearCompression.toFixed(5),
      currentRideState:state.stateName,
      normalizedProgress:+state.renderProgress.toFixed(5),
      frontAirborne:state.frontAirborne,
      rearLocked:state.rearLocked
    };
  }

  function captureState(){
    const object = products[state.product];
    return {
      rideSessionId:state.sessionId,
      rideState:state.stateName,
      normalizedProgress:+state.renderProgress.toFixed(6),
      arcLength:+state.arc.toFixed(5),
      worldPosition:{
        x:+object.position.x.toFixed(5),
        y:+object.position.y.toFixed(5),
        z:+object.position.z.toFixed(5)
      },
      rearAxlePosition:{
        x:+state.rearAxle.x.toFixed(5),
        y:+state.rearAxle.y.toFixed(5),
        z:+state.rearAxle.z.toFixed(5)
      },
      velocity:+state.speed.toFixed(5),
      acceleration:+state.acceleration.toFixed(5),
      pitch:+state.pitch.toFixed(5),
      yaw:+state.heading.toFixed(5),
      roll:+state.lean.toFixed(5),
      drift:+state.drift.toFixed(5),
      steering:+state.steering.toFixed(5),
      suspensionCompression:{
        front:+state.frontCompression.toFixed(5),
        rear:+state.rearCompression.toFixed(5)
      },
      wheelRotations:{
        front:+state.frontWheelAngle.toFixed(5),
        rear:+state.rearWheelAngle.toFixed(5)
      },
      wheelRPM:{
        front:+(state.frontOmega * 60 / (Math.PI * 2)).toFixed(2),
        rear:+(state.rearOmega * 60 / (Math.PI * 2)).toFixed(2)
      },
      cameraPosition:{
        x:+camera.position.x.toFixed(5),
        y:+camera.position.y.toFixed(5),
        z:+camera.position.z.toFixed(5)
      },
      cameraTarget:{
        x:+state.cameraTarget.x.toFixed(5),
        y:+state.cameraTarget.y.toFixed(5),
        z:+state.cameraTarget.z.toFixed(5)
      },
      currentFPS:+state.fps.toFixed(2),
      currentDPR:+renderer.getPixelRatio().toFixed(2)
    };
  }

  function reportFrame(dt){
    const fps = 1 / Math.max(dt, 1e-4);
    state.fps += (fps - state.fps) * .08;
    state.minimumFps = Math.min(state.minimumFps, fps);
    state.frameCount++;
    state.fpsTotal += fps;
    state.averageFps = state.fpsTotal / state.frameCount;
  }

  function performanceMetrics(){
    return {
      fps:+state.fps.toFixed(2),
      averageFps:+state.averageFps.toFixed(2),
      minimumFps:+state.minimumFps.toFixed(2),
      dpr:+renderer.getPixelRatio().toFixed(2),
      quality,
      fixedTimestep:FIXED_DT,
      frameCount:state.frameCount,
      drawCalls:renderer.info.render.calls,
      triangles:renderer.info.render.triangles,
      geometries:renderer.info.memory.geometries,
      textures:renderer.info.memory.textures,
      webgl2:renderer.capabilities.isWebGL2
    };
  }

  function resize(width, height){
    const dpr = configureQuality();
    const previousMobile = stage.mobile;
    stage = layout();
    if(state.mode === 'showcase'){
      camera.aspect = width / height;
      camera.fov = 34;
      camera.position.set(.05, .72, width / height < 1 ? 4.8 : 3.7);
      controls.target.set(0, .52, 0);
      camera.updateProjectionMatrix();
    }else{
      installHeroCamera();
      if(previousMobile !== stage.mobile){
        // The staging is framed per breakpoint; re-derive it and hold the
        // same point in the shot instead of snapping back to the start.
        const held = state.renderProgress;
        const wasRunning = state.running;
        const resumeAt = state.pendingStartEpoch;
        route = buildRoute();
        seek(held);
        if(wasRunning){
          state.running = true;
          state.pendingStartEpoch = resumeAt;
          state.started = true;
        }
      }else{
        applyVisual(clamp01(state.accumulator / FIXED_DT));
      }
    }
    renderer.setSize(width, height);
    composer.setSize(width, height);
    return dpr;
  }

  function handleMessage(event){
    if(event.source !== window.parent) return;
    if(event.origin !== location.origin && event.origin !== 'null') return;
    const data = event.data || {};
    if(data.type === 'ride-product'){
      reset(data.product, data.ride, data.rideSessionId, true);
    }else if(data.type === 'ride-start'){
      if(data.rideSessionId !== state.sessionId) return;
      start(data.startAtEpochMs, data.rideSessionId);
    }else if(data.type === 'ride-stop'){
      if(data.rideSessionId && data.rideSessionId !== state.sessionId) return;
      stop();
    }else if(data.type === 'ride-reset'){
      if(data.rideSessionId && data.rideSessionId !== state.sessionId) return;
      reset(state.product, state.mode, state.sessionId, true);
    }else if(data.type === 'ride-scene-active'){
      state.active = Boolean(data.active);
    }
  }
  addEventListener('message', handleMessage);

  const api = {
    state,
    roadCurve,
    roadLength,
    getStaging:()=>({...stage, roadLength, routePoints:route.points.map(p=>({...p}))}),
    sampleRoadHeightAndNormal,
    reset,
    start,
    stop,
    update,
    seek,
    resize,
    reportFrame,
    telemetry,
    performanceMetrics,
    captureState,
    setActive:active=>{ state.active = Boolean(active); },
    setDebugMode:enabled=>{
      const active = Boolean(enabled);
      document.documentElement.classList.toggle('ride-debug', active);
      debugPanel.style.display = active ? 'block' : 'none';
    },
    dispose(){
      removeEventListener('message', handleMessage);
      sprayGeometry.dispose();
      sprayMaterial.dispose();
      glowTexture.dispose();
      headlightGlow.material.dispose();
      scene.remove(spray, headlightGlow);
      debugPanel.remove();
    }
  };

  configureQuality();
  reset(state.product, state.mode, state.sessionId, false);
  if(query.has('ridePhase')) seek(Number.parseFloat(query.get('ridePhase')));
  // autoplay lets a page embed a self-running showcase without any wiring.
  else if(query.get('ride') && (window.parent === window || query.get('autoplay') === '1')){
    start(Date.now());
  }
  queueMicrotask(()=>emit('ride-ready', {
    mode:state.mode,
    reducedMotion,
    duration:state.duration,
    webgl2:renderer.capabilities.isWebGL2
  }));
  if(query.get('debugRide') === '1') api.setDebugMode(true);
  return api;
}
