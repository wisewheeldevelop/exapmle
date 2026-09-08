/*
 * RIDE AND BIKE — test ride.
 *
 * An interactive rider for the same product model the store sells, on a closed
 * circuit, with the vehicle's real published numbers driving the simulation:
 * a 48 V pack, a power-limited hub motor, mass, frontal area and a tyre grip
 * budget. Nothing here is a lookup table of poses — speed, lean, slide and
 * range all fall out of the forces, which is why the thing feels like a bike
 * and why the range readout means something.
 *
 * Model
 * -----
 *  Longitudinal   m·v̇ = F_motor − F_brake − ½ρCdA·v² − Crr·m·g − m·g·sinθ
 *  Lateral        single-track (bicycle) model, yaw rate ψ̇ = v·tan(δ)/L
 *  Lean           φ = atan(v·ψ̇ / g), the angle that balances the machine
 *  Grip           a friction circle: once √(a_lat² + a_lon²) exceeds μ·g the
 *                 tyres give up, the rear steps out and a drift angle grows
 *  Energy         P_elec = P_mech/η + P_idle, integrated against pack Wh
 */
import { createCircuitCurve, buildRoadRibbon, CIRCUIT_WIDTH } from './road-path.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = v => clamp(v, 0, 1);
const mix = (a, b, t) => a + (b - a) * t;
const KMH = 3.6;

/** Published specs, per product. These are the numbers the store quotes. */
const SPECS = {
  bike: {
    label: 'MASTER MAX',
    mass: 30 + 78,        // machine + rider, kg
    packWh: 48 * 17.5,    // 48 V · 17.5 Ah
    motorW: 900,          // 750 W rated, peak headroom on the controller
    peakTorque: 98,       // N·m at the wheel, low speed
    topSpeed: 45 / KMH,   // unrestricted test-track limit, m/s
    wheelRadius: 0.335,
    wheelbase: 1.33,
    CdA: 0.62,            // upright rider on a fat-tyre bike
    Crr: 0.012,
    mu: 0.95,             // dry test track
    brakeForce: 1450,     // hydraulic discs, both ends, N
    maxSteer: 0.52,
    leanLimit: 0.62
  },
  scooter: {
    label: 'ICON 11',
    mass: 24 + 78,
    packWh: 48 * 12.5,
    motorW: 720,
    peakTorque: 66,
    topSpeed: 40 / KMH,
    wheelRadius: 0.152,
    wheelbase: 1.12,
    CdA: 0.58,
    Crr: 0.014,
    mu: 0.86,             // smaller contact patch
    brakeForce: 1050,
    maxSteer: 0.46,
    leanLimit: 0.48
  }
};

const AIR_DENSITY = 1.225;
const GRAVITY = 9.81;
const DRIVETRAIN_EFFICIENCY = 0.82;
const IDLE_WATTS = 14;          // controller, lights, display
const REGEN_EFFICIENCY = 0.35;  // what braking actually puts back
const FIXED_DT = 1 / 120;

export function createFreeRide(options){
  const { THREE, scene, camera, renderer, composer, grade, bloom,
          products, applySteering, rig, onProduct } = options;

  /* ── circuit ──────────────────────────────────────────────────────── */
  const curve = createCircuitCurve(THREE);
  const circuitLength = curve.getLength();
  const track = new THREE.Group();
  track.name = 'testRideCircuit';
  scene.add(track);

  const disposables = [];
  const keep = resource => { disposables.push(resource); return resource; };

  function surfaceTexture(){
    const size = 512;
    const surface = document.createElement('canvas');
    surface.width = surface.height = size;
    const ctx = surface.getContext('2d');
    ctx.fillStyle = '#8e9296';
    ctx.fillRect(0, 0, size, size);
    for(let i = 0; i < 26000; i++){
      const tone = 118 + Math.random() * 60;
      ctx.fillStyle = `rgba(${tone},${tone + 2},${tone + 3},${0.05 + Math.random() * 0.22})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    /* Repair seams, not scratches. Long random polylines tile into what looks
       like brushed concrete; a handful of short, mostly-straight cracks with
       low contrast is what asphalt actually shows at this scale. */
    for(let i = 0; i < 11; i++){
      ctx.strokeStyle = `rgba(58,60,64,${0.07 + Math.random() * 0.10})`;
      ctx.lineWidth = 0.7 + Math.random() * 1.3;
      ctx.lineCap = 'round';
      let x = Math.random() * size;
      let y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for(let j = 0; j < 4; j++){
        x += (Math.random() - 0.5) * 26;
        y += 18 + Math.random() * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Broad patch mottling keeps the surface from reading as flat paint.
    for(let i = 0; i < 26; i++){
      const r = 26 + Math.random() * 80;
      const g = ctx.createRadialGradient(
        Math.random() * size, Math.random() * size, 0,
        Math.random() * size, Math.random() * size, r);
      const tone = Math.random() > 0.5 ? '255,255,255' : '30,32,36';
      g.addColorStop(0, `rgba(${tone},${0.02 + Math.random() * 0.045})`);
      g.addColorStop(1, `rgba(${tone},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(surface);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3.2, 6.5);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return keep(texture);
  }

  /* The product scene ships a bright studio IBL and a three-light rig so a
     black bike reads against a white sweep. Out here that same rig floods an
     entire landscape to putty. Dimming it would flatten the product too, so
     the studio is confined to its own render layer: the machine keeps its
     key, fill and kick, while the circuit is lit only by the sun and sky. */
  const STUDIO_LAYER = 1;
  const studioIntensity = scene.environmentIntensity;
  scene.environmentIntensity = 1.15;
  /* Layers isolate the analytic rig, but scene.environment is global — and a
     white studio probe is exactly what turned near-black tarmac into putty.
     Every surface out here therefore opts out of the probe explicitly and is
     lit only by the sun and the sky. */
  const TRACK_MATERIAL = { envMapIntensity: 0 };
  camera.layers.enable(STUDIO_LAYER);
  if(rig) rig.traverse(node => { if(node.isLight) node.layers.set(STUDIO_LAYER); });
  for(const product of [products.bike, products.scooter]){
    product.traverse(node => node.layers.enable(STUDIO_LAYER));
  }

  // Daylight asphalt: mid grey, not the near-black the night hero needs.
  const asphalt = new THREE.MeshStandardMaterial({
    color: 0x6d7176, map: surfaceTexture(), roughness: 0.9, metalness: 0.02, ...TRACK_MATERIAL
  });
  keep(asphalt);
  const roadGeometry = keep(buildRoadRibbon(THREE, curve, {
    width: CIRCUIT_WIDTH, segments: 520, crossSegments: 6
  }));
  const road = new THREE.Mesh(roadGeometry, asphalt);
  road.receiveShadow = true;
  track.add(road);

  const apron = new THREE.Mesh(
    keep(buildRoadRibbon(THREE, curve, {
      width: CIRCUIT_WIDTH + 26, segments: 300, crossSegments: 3, yOffset: -0.09, bank: false
    })),
    keep(new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 1, metalness: 0, ...TRACK_MATERIAL }))
  );
  apron.receiveShadow = true;
  track.add(apron);

  // Painted edges and a dashed centreline, so speed and line are readable.
  function marking(offset, width, colour, dashed){
    const geometry = keep(buildRoadRibbon(THREE, curve, {
      width, segments: 520, crossSegments: 1, yOffset: 0.012, bank: false, lateral: offset
    }));
    const material = keep(new THREE.MeshStandardMaterial({
      color: colour, roughness: 0.55, metalness: 0.02, ...TRACK_MATERIAL,
      emissive: new THREE.Color(colour), emissiveIntensity: 0.14
    }));
    if(dashed){
      const uv = geometry.attributes.uv;
      const alpha = new Float32Array(uv.count);
      for(let i = 0; i < uv.count; i++) alpha[i] = (Math.floor(uv.getY(i) * 2.2) % 2) ? 1 : 0;
      geometry.setAttribute('aDash', new THREE.BufferAttribute(alpha, 1));
      material.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aDash;\nvarying float vDash;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDash=aDash;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vDash;')
          .replace('#include <dithering_fragment>',
            '#include <dithering_fragment>\nif(vDash<0.5)discard;');
      };
      material.customProgramCacheKey = () => 'freeride-dash';
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    track.add(mesh);
  }
  /* Exactly the hero road's lane scheme: a worn double-yellow centre and
     white edge lines at the same offsets, so this reads as the same road. */
  marking(-CIRCUIT_WIDTH * 0.5 + 0.48, 0.10, 0xf1eee6, false);
  marking(CIRCUIT_WIDTH * 0.5 - 0.48, 0.10, 0xf1eee6, false);
  marking(-0.16, 0.12, 0xd8a41f, false);
  marking(0.16, 0.12, 0xd8a41f, false);

  /* Kerbs, markers and a start line: without landmarks a circuit gives the
     rider no sense of speed and no way to judge a corner. */
  const railMaterial = keep(new THREE.MeshStandardMaterial({
    color: 0xb9bdc2, roughness: 0.42, metalness: 0.72, ...TRACK_MATERIAL
  }));
  const postGeometry = keep(new THREE.CylinderGeometry(0.05, 0.07, 0.74, 6));
  const postMaterial = keep(new THREE.MeshStandardMaterial({ color: 0x1a1e22, roughness: 0.6, metalness: 0.4, ...TRACK_MATERIAL }));
  const reflectorGeometry = keep(new THREE.BoxGeometry(0.12, 0.075, 0.04));
  const reflectorMaterial = keep(new THREE.MeshStandardMaterial({
    color: 0xffcb45, emissive: 0xff9a12, emissiveIntensity: 1.1, roughness: 0.3, ...TRACK_MATERIAL
  }));
  const frame = { centre: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3() };
  function frameAt(t){
    curve.getPointAt(((t % 1) + 1) % 1, frame.centre);
    curve.getTangentAt(((t % 1) + 1) % 1, frame.tangent).normalize();
    frame.right.set(-frame.tangent.z, 0, frame.tangent.x).normalize();
    return frame;
  }
  for(let i = 0; i < 260; i++){
    const t = i / 260;
    const f = frameAt(t);
    const side = 1;
    void side;
    if(i % 4 === 0){
      for(const s of [-1, 1]){
        const post = new THREE.Mesh(postGeometry, postMaterial);
        const pp = f.centre.clone().addScaledVector(f.right, s * (CIRCUIT_WIDTH * 0.5 + 0.75));
        post.position.set(pp.x, pp.y + 0.36, pp.z);
        track.add(post);
        const reflector = new THREE.Mesh(reflectorGeometry, reflectorMaterial);
        reflector.position.set(pp.x, pp.y + 0.66, pp.z);
        reflector.rotation.y = Math.atan2(f.tangent.x, f.tangent.z);
        track.add(reflector);
      }
    }
  }
  /* Armco, built as one continuous tube per side. Discrete slabs read as
     scattered debris at speed; a real rail is a single unbroken line, and
     that line is most of what tells a rider where the corner goes. */
  function guardrail(offset, height){
    const points = [];
    for(let i = 0; i <= 300; i++){
      const f = frameAt(i / 300);
      points.push(f.centre.clone().addScaledVector(f.right, offset)
        .add(new THREE.Vector3(0, height, 0)));
    }
    const rail = new THREE.Mesh(
      keep(new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.5), 460, 0.075, 6, true)),
      railMaterial
    );
    rail.castShadow = true;
    track.add(rail);
  }
  for(const side of [-1, 1]){
    guardrail(side * (CIRCUIT_WIDTH * 0.5 + 0.75), 0.72);
    guardrail(side * (CIRCUIT_WIDTH * 0.5 + 0.75), 0.46);
  }

  {
    const f = frameAt(0);
    const line = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(CIRCUIT_WIDTH, 0.9)),
      keep(new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.5, ...TRACK_MATERIAL }))
    );
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -Math.atan2(f.tangent.x, f.tangent.z);
    line.position.set(f.centre.x, f.centre.y + 0.014, f.centre.z);
    track.add(line);
  }

  /* Terrain beyond the apron. A lit ground plane this large picks up every
     light in the scene and washes out to putty, and nothing on it is ever
     close enough to be worth shading — so it is unlit and tinted to the fog,
     which lets it disappear into the horizon instead of fighting the track. */
  const ground = new THREE.Mesh(
    keep(new THREE.CircleGeometry(700, 48)),
    keep(new THREE.MeshBasicMaterial({ color: 0x39442f, fog: true }))
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.16;
  track.add(ground);

  scene.fog = new THREE.FogExp2(0xa8c2d8, 0.0026);
  const skyTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0.00, '#2f6ea8');
    gradient.addColorStop(0.34, '#5b9ac8');
    gradient.addColorStop(0.58, '#9dc4dd');
    gradient.addColorStop(0.72, '#cfdfe8');
    gradient.addColorStop(0.78, '#e7e3d4');
    gradient.addColorStop(0.86, '#5d6a52');
    gradient.addColorStop(1.00, '#39442f');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 4, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return keep(texture);
  })();
  const sky = new THREE.Mesh(
    keep(new THREE.SphereGeometry(620, 32, 24)),
    keep(new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false }))
  );
  track.add(sky);

  const sun = new THREE.DirectionalLight(0xfff3dd, 2.6);
  sun.position.set(-70, 145, 95);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
  sun.shadow.bias = -0.0012;
  track.add(sun, sun.target);
  track.add(new THREE.HemisphereLight(0xbcd8ee, 0x3b4433, 1.45));

  /* ── vehicle state ────────────────────────────────────────────────── */
  const state = {
    product: 'bike',
    spec: SPECS.bike,
    position: new THREE.Vector3(),
    heading: 0,
    speed: 0,
    yawRate: 0,
    steer: 0,
    lean: 0,
    leanVelocity: 0,
    pitch: 0,
    drift: 0,
    slip: 0,
    wheelAngle: 0,
    frontWheelAngle: 0,
    rearLocked: false,
    energyWh: 0,
    distance: 0,
    lapDistance: 0,
    laps: 0,
    bestLap: 0,
    lapClock: 0,
    motorW: 0,
    accumulator: 0,
    running: false,
    lateralG: 0,
    longitudinalG: 0,
    airborneDust: 0
  };

  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, reset: false };

  function resetVehicle(){
    const f = frameAt(0.002);
    state.position.copy(f.centre).addScaledVector(f.right, -2.4);
    state.heading = Math.atan2(-f.tangent.z, f.tangent.x);
    state.speed = 0;
    state.yawRate = 0;
    state.steer = 0;
    state.lean = state.leanVelocity = 0;
    state.pitch = 0;
    state.drift = 0;
    state.slip = 0;
    state.rearLocked = false;
    state.energyWh = 0;
    state.distance = 0;
    state.lapDistance = 0;
    state.laps = 0;
    state.lapClock = 0;
    state.motorW = 0;
    state.accumulator = 0;
  }

  function setProduct(which){
    state.product = which === 'scooter' ? 'scooter' : 'bike';
    state.spec = SPECS[state.product];
    products.bike.visible = state.product === 'bike';
    products.scooter.visible = state.product === 'scooter';
    products.bike.rotation.order = 'YXZ';
    products.scooter.rotation.order = 'YXZ';
    resetVehicle();
    onProduct?.(state.product);
  }

  /* ── forces ───────────────────────────────────────────────────────── */
  function motorForce(spec, speed, throttle, boost){
    if(throttle <= 0) return 0;
    // Torque-limited off the line, power-limited once rolling: the same
    // shape every hub motor has, and the reason acceleration tails off.
    const wheelSpeed = Math.max(speed, 0.6);
    const powerLimited = (spec.motorW * (boost ? 1.35 : 1)) * DRIVETRAIN_EFFICIENCY / wheelSpeed;
    const torqueLimited = spec.peakTorque / spec.wheelRadius;
    // Controller tapers to nothing at the speed limiter.
    const limiter = clamp01((spec.topSpeed - speed) / 2.4);
    return Math.min(powerLimited, torqueLimited) * throttle * limiter;
  }

  function step(dt){
    const spec = state.spec;
    const previousSpeed = state.speed;

    /* Steering: the faster you go, the less lock the rider uses. Without this
       a keyboard would snap the bars to full lock at 40 km/h and spit the
       bike straight into a highside. */
    const authority = mix(1, 0.24, clamp01(state.speed / spec.topSpeed));
    const steerTarget = input.steer * spec.maxSteer * authority;
    state.steer += (steerTarget - state.steer) * (1 - Math.exp(-dt * 9));

    const throttle = clamp01(input.throttle);
    const brake = clamp01(input.brake);
    const drive = motorForce(spec, state.speed, throttle, input.boost);
    const drag = 0.5 * AIR_DENSITY * spec.CdA * state.speed * state.speed;
    const rolling = state.speed > 0.05 ? spec.Crr * spec.mass * GRAVITY : 0;
    /* The handbrake locks the rear wheel — it does not add a second set of
       discs. A locked tyre can only transmit sliding friction across the
       rear's share of the weight, which is why a skid scrubs off speed
       slowly and stays controllable instead of stopping the bike dead. */
    const rearLoad = 0.45 * spec.mass * GRAVITY;
    const lockedRear = input.handbrake ? spec.mu * 0.62 * rearLoad : 0;
    const braking = (brake * spec.brakeForce + lockedRear) * (state.speed > 0.15 ? 1 : 0);

    const longitudinal = (drive - drag - rolling - braking) / spec.mass;
    state.speed = Math.max(0, state.speed + longitudinal * dt);
    if(state.speed > spec.topSpeed) state.speed = spec.topSpeed;

    /* Lateral: single-track kinematics give the yaw the geometry allows; the
       friction circle decides how much of it the tyres will actually deliver. */
    const kinematicYaw = state.speed / spec.wheelbase * Math.tan(state.steer);
    const demandedLateral = kinematicYaw * state.speed;
    const longitudinalUse = Math.abs(longitudinal) / (spec.mu * GRAVITY);
    const lateralBudget = spec.mu * GRAVITY *
      Math.sqrt(Math.max(0, 1 - Math.min(1, longitudinalUse * longitudinalUse)));
    const overload = Math.abs(demandedLateral) / Math.max(lateralBudget, 0.001);

    // Past the circle the rear lets go; the slide is what is left over.
    const gripped = overload > 1 ? 1 / overload : 1;
    state.yawRate = kinematicYaw * gripped;
    // A locked rear only steps out while there is speed to step out with.
    const handbrakeSlide = input.handbrake ? 0.75 * clamp01((state.speed - 1.4) / 4.5) : 0;
    const slipTarget = clamp(Math.max(overload - 1, 0) * 0.5 + handbrakeSlide, 0, 1.25);
    state.slip += (slipTarget - state.slip) * (1 - Math.exp(-dt * 6.5));
    state.rearLocked = input.handbrake || (brake > 0.75 && state.speed > 3) || state.slip > 0.22;

    // A sliding rear rotates the machine further than the front is pointing.
    const driftTarget = -Math.sign(state.steer || 1) * state.slip * 0.62;
    state.drift += (driftTarget - state.drift) * (1 - Math.exp(-dt * 5.0));

    state.heading += (state.yawRate + state.slip * state.yawRate * 0.35) * dt;

    // Travel along the *body* direction minus the drift: that is what makes a
    // slide actually push the vehicle wide instead of just rotating it.
    const travel = state.heading - state.drift;
    state.position.x += Math.cos(travel) * state.speed * dt;
    state.position.z -= Math.sin(travel) * state.speed * dt;

    /* Lean is the angle that balances centripetal force against gravity —
       the same equation that decides whether a rider stays up. */
    const leanTarget = clamp(
      Math.atan(state.speed * state.yawRate / GRAVITY),
      -spec.leanLimit, spec.leanLimit
    );
    const omega = Math.PI * 2 * 1.9;
    state.leanVelocity += ((leanTarget - state.lean) * omega * omega
      - 2 * 0.95 * omega * state.leanVelocity) * dt;
    state.lean += state.leanVelocity * dt;

    // Squat under power, dive under brakes.
    const pitchTarget = clamp(-longitudinal * 0.016, -0.09, 0.07);
    state.pitch += (pitchTarget - state.pitch) * (1 - Math.exp(-dt * 7));

    // Wheels: the rear stops turning the instant it is locked.
    const rollOmega = state.speed / spec.wheelRadius;
    state.frontWheelAngle += rollOmega * dt;
    state.wheelAngle += (state.rearLocked ? 0 : rollOmega * (1 + throttle * state.slip * 0.6)) * dt;

    /* Energy. Mechanical output plus losses, minus what regen recovers, all
       integrated against the pack — which is what makes the range figure on
       the HUD an honest number rather than a countdown. */
    const mechanicalW = Math.max(0, drive * state.speed);
    const regenW = brake > 0 && state.speed > 1
      ? brake * spec.brakeForce * state.speed * REGEN_EFFICIENCY * 0.25
      : 0;
    state.motorW = mechanicalW;
    const netW = mechanicalW / DRIVETRAIN_EFFICIENCY + IDLE_WATTS - regenW;
    state.energyWh = clamp(state.energyWh + netW * dt / 3600, 0, spec.packWh);

    const advanced = state.speed * dt;
    state.distance += advanced;
    state.lapDistance += advanced;
    state.lapClock += dt;
    if(state.lapDistance >= circuitLength){
      state.lapDistance -= circuitLength;
      state.laps++;
      if(!state.bestLap || state.lapClock < state.bestLap) state.bestLap = state.lapClock;
      state.lapClock = 0;
    }

    state.lateralG = Math.abs(state.speed * state.yawRate) / GRAVITY;
    state.longitudinalG = longitudinal / GRAVITY;
    void previousSpeed;
  }

  /* ── presentation ─────────────────────────────────────────────────── */
  const chase = {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    desired: new THREE.Vector3(),
    desiredTarget: new THREE.Vector3()
  };
  let chaseReady = false;

  function applyVisual(dt){
    const object = products[state.product];
    const spec = state.spec;
    object.rotation.set(state.lean, state.heading, state.pitch, 'YXZ');
    object.position.set(state.position.x, spec.wheelRadius, state.position.z);
    // Place by the rear contact patch so lean and pitch pivot where the tyre is.
    const offset = new THREE.Vector3(-spec.wheelbase * 0.5, spec.wheelRadius, 0)
      .applyEuler(object.rotation);
    object.position.sub(offset);
    object.position.y += spec.wheelRadius;

    applySteering(object, state.steer * 0.85, 0, 0);
    for(const [index, wheel] of (object.userData.wheels || []).entries()){
      const angle = index === 0 ? state.wheelAngle : state.frontWheelAngle;
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
    if(rig) rig.position.set(object.position.x, 0, object.position.z);

    /* Chase camera. It sits behind the *travel* direction, not the body
       direction, so a slide shows the machine sideways across the screen —
       which is the whole point of being allowed to slide. */
    const travel = state.heading - state.drift * 0.55;
    const back = mix(4.3, 6.0, clamp01(state.speed / spec.topSpeed));
    const height = mix(2.05, 2.55, clamp01(state.speed / spec.topSpeed));
    chase.desired.set(
      state.position.x - Math.cos(travel) * back,
      height,
      state.position.z + Math.sin(travel) * back
    );
    const lead = 4.2 + state.speed * 0.5;
    chase.desiredTarget.set(
      state.position.x + Math.cos(travel) * lead,
      0.85,
      state.position.z - Math.sin(travel) * lead
    );
    if(!chaseReady){
      chase.position.copy(chase.desired);
      chase.target.copy(chase.desiredTarget);
      chaseReady = true;
    }
    springVector(chase.position, chase.velocity, chase.desired, 2.1, 1, dt);
    springVector(chase.target, chase.targetVelocity, chase.desiredTarget, 3.4, 1, dt);
    camera.position.copy(chase.position);
    camera.lookAt(chase.target);
    // Speed sells itself through the lens, not the numbers.
    const targetFov = mix(46, 63, clamp01(state.speed / spec.topSpeed)) + state.slip * 4;
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 3.2));
    camera.near = 0.1;
    camera.far = 900;
    camera.updateProjectionMatrix();

    grade.uniforms.uCA.value = 0.0004 + clamp01(state.speed / spec.topSpeed) * 0.0022;
    grade.uniforms.uVig.value = 0.18 + clamp01(state.speed / spec.topSpeed) * 0.26;
    grade.uniforms.uGrain.value = 0.012;
    bloom.strength = 0.10 + clamp01(state.speed / spec.topSpeed) * 0.10;
    updateSmoke(dt);
  }

  function springVector(value, velocity, target, frequency, damping, dt){
    const omega = Math.PI * 2 * frequency;
    const k = omega * omega;
    const c = 2 * damping * omega;
    velocity.x += ((target.x - value.x) * k - velocity.x * c) * dt;
    velocity.y += ((target.y - value.y) * k - velocity.y * c) * dt;
    velocity.z += ((target.z - value.z) * k - velocity.z * c) * dt;
    value.addScaledVector(velocity, dt);
  }

  /* Tyre smoke. Only the locked or sliding rear makes it, so it doubles as
     feedback: if you can see smoke you are past the grip limit. */
  const SMOKE = 64;
  const smokeGeometry = keep(new THREE.PlaneGeometry(1, 1));
  /* Soft-edged puffs. Hard quads at this opacity stack into a grey sheet in
     front of a close chase camera — which is exactly what a plume must not do. */
  const smokeTexture = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0.00, 'rgba(246,248,250,0.9)');
    gradient.addColorStop(0.45, 'rgba(190,200,210,0.30)');
    gradient.addColorStop(1.00, 'rgba(170,182,194,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return keep(texture);
  })();
  const smokeMaterial = keep(new THREE.MeshBasicMaterial({
    map: smokeTexture, color: 0xf0f2f4, transparent: true, opacity: 0.16,
    depthWrite: false, fog: true
  }));
  const smoke = new THREE.InstancedMesh(smokeGeometry, smokeMaterial, SMOKE);
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smoke.frustumCulled = false;
  track.add(smoke);
  const puffs = Array.from({ length: SMOKE }, () => ({ life: 0, age: 0, x: 0, y: -50, z: 0, size: 1 }));
  let puffCursor = 0;
  let puffCarry = 0;
  const dummy = new THREE.Object3D();

  function updateSmoke(dt){
    const spec = state.spec;
    const intensity = state.rearLocked && state.speed > 1.5
      ? clamp01(state.slip + 0.35) * clamp01(state.speed / 8)
      : 0;
    puffCarry += intensity * dt * 30;
    while(puffCarry >= 1){
      puffCarry -= 1;
      const puff = puffs[puffCursor++ % SMOKE];
      const back = state.heading - state.drift;
      // Laid down behind the contact patch, not around the camera.
      const trail = spec.wheelbase * 0.5 + 0.5 + Math.random() * 0.6;
      puff.x = state.position.x - Math.cos(back) * trail;
      puff.z = state.position.z + Math.sin(back) * trail;
      puff.y = 0.10;
      puff.life = 0.5 + Math.random() * 0.35;
      puff.age = 0;
      puff.size = 0.55 + Math.random() * 0.4;
    }
    for(let i = 0; i < SMOKE; i++){
      const puff = puffs[i];
      if(puff.age < puff.life){
        puff.age += dt;
        puff.y += dt * 0.30;
        const k = puff.age / puff.life;
        // Bloom then collapse: the shrink is the only fade a shared material
        // allows, and it keeps the plume from ever becoming a flat sheet.
        const fade = 1 - clamp01((k - 0.45) / 0.55);
        dummy.position.set(puff.x, puff.y, puff.z);
        dummy.quaternion.copy(camera.quaternion);
        dummy.scale.setScalar(puff.size * (0.45 + k * 1.7) * fade * fade);
      }else{
        dummy.position.set(0, -50, 0);
        dummy.scale.setScalar(0.01);
      }
      dummy.updateMatrix();
      smoke.setMatrixAt(i, dummy.matrix);
    }
    smoke.instanceMatrix.needsUpdate = true;
  }

  /* ── input ────────────────────────────────────────────────────────── */
  const held = new Set();
  const KEY_MAP = {
    ArrowUp: 'throttle', KeyW: 'throttle',
    ArrowDown: 'brake', KeyS: 'brake',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'handbrake', ShiftLeft: 'boost', ShiftRight: 'boost',
    KeyR: 'reset'
  };
  function onKey(event, down){
    const action = KEY_MAP[event.code];
    if(!action) return;
    event.preventDefault();
    if(down) held.add(action); else held.delete(action);
    if(action === 'reset' && down) resetVehicle();
  }
  const keyDown = e => onKey(e, true);
  const keyUp = e => onKey(e, false);
  addEventListener('keydown', keyDown, { passive: false });
  addEventListener('keyup', keyUp, { passive: false });

  const touch = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  function readInput(dt){
    // Left is a positive steering angle in this frame (heading grows to the
    // left), so both input sources resolve to the same sign before ramping.
    const keyboard = (held.has('left') ? 1 : 0) - (held.has('right') ? 1 : 0);
    const target = keyboard !== 0 ? keyboard : -touch.steer;
    // Ramp rather than snap: a button is a switch, a rider is not.
    input.steer += (target - input.steer) * (1 - Math.exp(-dt * 7.5));
    if(Math.abs(input.steer) < 0.002) input.steer = 0;
    input.throttle = Math.max(held.has('throttle') ? 1 : 0, touch.throttle);
    input.brake = Math.max(held.has('brake') ? 1 : 0, touch.brake);
    input.handbrake = held.has('handbrake') || touch.handbrake;
    input.boost = held.has('boost');
  }

  /* ── HUD ──────────────────────────────────────────────────────────── */
  const hudStyle = document.createElement('style');
  hudStyle.textContent = `
    #freeRideHud{position:fixed;inset:0;z-index:70;pointer-events:none;
      font-family:"Heebo","Segoe UI",sans-serif;direction:rtl;color:#fff;
      -webkit-user-select:none;user-select:none}
    #freeRideHud .fr-cluster{position:absolute;left:clamp(14px,3vw,34px);bottom:clamp(14px,3vw,34px);
      display:flex;align-items:flex-end;gap:16px;padding:16px 20px;border-radius:22px;
      border:1px solid rgba(245,197,24,.22);background:rgba(6,8,11,.62);
      backdrop-filter:blur(16px) saturate(130%);box-shadow:0 22px 60px rgba(0,0,0,.45)}
    #freeRideHud .fr-speed{display:flex;align-items:baseline;gap:7px;direction:ltr}
    #freeRideHud .fr-speed strong{font:900 clamp(40px,6vw,64px)/0.85 "Rubik",sans-serif;
      color:#fff;font-variant-numeric:tabular-nums;min-width:2.4ch;text-align:right}
    #freeRideHud .fr-speed span{font:800 11px/1 "Rubik",sans-serif;letter-spacing:.14em;
      color:rgba(255,255,255,.5)}
    #freeRideHud .fr-bars{min-width:190px}
    #freeRideHud .fr-bar{height:6px;border-radius:99px;background:rgba(255,255,255,.12);
      overflow:hidden;margin-bottom:9px}
    #freeRideHud .fr-bar i{display:block;height:100%;width:100%;border-radius:99px;
      background:linear-gradient(90deg,#f5c518,#ffe14d);transition:width .2s linear}
    #freeRideHud .fr-row{display:flex;justify-content:space-between;gap:14px;
      font-size:12px;line-height:1.85;color:rgba(255,255,255,.55)}
    #freeRideHud .fr-row b{color:#fff;font-weight:800;font-variant-numeric:tabular-nums}
    #freeRideHud .fr-side{position:absolute;right:clamp(14px,3vw,34px);bottom:clamp(14px,3vw,34px);
      min-width:190px;padding:14px 18px;border-radius:20px;
      border:1px solid rgba(255,255,255,.10);background:rgba(6,8,11,.55);
      backdrop-filter:blur(14px);box-shadow:0 18px 46px rgba(0,0,0,.4)}
    #freeRideHud .fr-slide{margin-top:10px;padding:7px 0;border-radius:99px;text-align:center;
      font:800 11px/1 "Rubik",sans-serif;letter-spacing:.16em;
      border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.5);transition:.18s}
    #freeRideHud .fr-slide.on{border-color:rgba(255,110,60,.65);background:rgba(255,90,40,.16);
      color:#ffb08a}
    #freeRideHud .fr-touch{display:none}
    /* Touch layout: two thumb clusters at the bottom corners, sized to the
       reach of a thumb rather than to a keyboard's idea of a control strip.
       Steering left, drive right — the way every rider already expects. */
    @media (pointer:coarse),(max-width:900px){
      #freeRideHud .fr-touch{position:absolute;inset:auto 0
        calc(14px + env(safe-area-inset-bottom,0px)) 0;
        display:flex;align-items:flex-end;justify-content:space-between;
        padding:0 calc(14px + env(safe-area-inset-left,0px)) 0
                calc(14px + env(safe-area-inset-right,0px));
        pointer-events:none}
      #freeRideHud .fr-pad{display:flex;gap:10px;pointer-events:auto}
      #freeRideHud .fr-pad-drive{flex-direction:column-reverse;align-items:flex-end;gap:9px}
      #freeRideHud .fr-touch button{
        display:grid;place-items:center;border-radius:22px;
        border:1px solid rgba(255,255,255,.18);background:rgba(8,10,13,.55);
        backdrop-filter:blur(14px);color:#fff;font:800 15px/1 "Heebo",sans-serif;
        touch-action:none;-webkit-user-select:none;user-select:none;
        transition:background .12s linear,transform .12s ease;
        box-shadow:0 10px 26px rgba(0,0,0,.35)}
      #freeRideHud .fr-touch button.on{background:rgba(245,197,24,.88);color:#1a1400;
        border-color:transparent;transform:scale(.95)}
      #freeRideHud .fr-touch button.fr-steer{width:76px;height:76px;font-size:30px;line-height:1}
      #freeRideHud .fr-touch button.fr-steer span{transform:translateY(-3px)}
      #freeRideHud .fr-touch button.fr-gas{width:104px;height:104px;border-radius:50%;font-size:17px;
        background:rgba(245,197,24,.22);border-color:rgba(245,197,24,.55);color:#ffe14d}
      #freeRideHud .fr-touch button.fr-gas.on{background:rgba(245,197,24,.94);color:#1a1400}
      #freeRideHud .fr-touch button.fr-brake{width:104px;height:56px;font-size:14px}
      #freeRideHud .fr-touch button.fr-skid{width:104px;height:48px;font-size:13px;
        border-color:rgba(255,120,60,.45);color:#ffb08a}
      #freeRideHud .fr-touch button.fr-skid.on{background:rgba(255,110,50,.88);color:#2a0e04}
      /* Readouts go to the top on touch. The bottom third belongs to thumbs,
         and anything parked there is either covered or in the way. */
      #freeRideHud .fr-cluster{left:calc(12px + env(safe-area-inset-left,0px));
        right:auto;bottom:auto;top:calc(78px + env(safe-area-inset-top,0px));
        padding:10px 13px;gap:11px;border-radius:18px}
      #freeRideHud .fr-speed strong{font-size:clamp(32px,10vw,44px)}
      #freeRideHud .fr-bars{min-width:112px}
      #freeRideHud .fr-bars .fr-row:nth-child(n+4){display:none}
      #freeRideHud .fr-side{right:calc(12px + env(safe-area-inset-right,0px));
        bottom:auto;top:calc(78px + env(safe-area-inset-top,0px));
        min-width:0;padding:10px 12px;border-radius:18px}
      #freeRideHud .fr-side .fr-row:nth-child(n+3){display:none}
      #freeRideHud .fr-slide{margin-top:7px;padding:6px 10px;font-size:10px}
    }
    /* Landscape phones: shrink the pads, keep the readouts clear of the nav. */
    @media (pointer:coarse) and (max-height:520px){
      #freeRideHud .fr-cluster,#freeRideHud .fr-side{top:60px;padding:8px 11px}
      #freeRideHud .fr-speed strong{font-size:30px}
      #freeRideHud .fr-touch button.fr-gas{width:82px;height:82px}
      #freeRideHud .fr-touch button.fr-brake{width:82px;height:46px}
      #freeRideHud .fr-touch button.fr-skid{width:82px;height:40px}
      #freeRideHud .fr-touch button.fr-steer{width:64px;height:64px}
    }
  `;
  document.head.appendChild(hudStyle);
  const hud = document.createElement('div');
  hud.id = 'freeRideHud';
  hud.innerHTML = `
    <div class="fr-cluster">
      <div class="fr-speed"><strong data-fr="speed">0</strong><span>קמ״ש</span></div>
      <div class="fr-bars">
        <div class="fr-bar"><i data-fr="battery-bar"></i></div>
        <div class="fr-row"><span>סוללה</span><b data-fr="battery">100%</b></div>
        <div class="fr-row"><span>טווח משוער</span><b data-fr="range">—</b></div>
        <div class="fr-row"><span>הספק</span><b data-fr="power">0 W</b></div>
      </div>
    </div>
    <div class="fr-side">
      <div class="fr-row"><span>מרחק</span><b data-fr="distance">0.00 ק״מ</b></div>
      <div class="fr-row"><span>הקפות</span><b data-fr="laps">0</b></div>
      <div class="fr-row"><span>הקפה מהירה</span><b data-fr="best">—</b></div>
      <div class="fr-row"><span>הטיה</span><b data-fr="lean">0°</b></div>
      <div class="fr-row"><span>עומס צד</span><b data-fr="glat">0.00 g</b></div>
      <div class="fr-slide" data-fr="slide">אחיזה</div>
    </div>
    <div class="fr-touch" data-fr="touch">
      <div class="fr-pad fr-pad-steer">
        <button type="button" data-fr-key="left" class="fr-steer" aria-label="פנייה שמאלה"><span>‹</span></button>
        <button type="button" data-fr-key="right" class="fr-steer" aria-label="פנייה ימינה"><span>›</span></button>
      </div>
      <div class="fr-pad fr-pad-drive">
        <button type="button" data-fr-key="handbrake" class="fr-skid" aria-label="בלם יד וחריקה">חריקה</button>
        <button type="button" data-fr-key="brake" class="fr-brake" aria-label="בלימה">בלם</button>
        <button type="button" data-fr-key="throttle" class="fr-gas" aria-label="גז">גז</button>
      </div>
    </div>`;
  document.body.appendChild(hud);
  const el = name => hud.querySelector(`[data-fr="${name}"]`);
  const hudRefs = {
    speed: el('speed'), battery: el('battery'), batteryBar: el('battery-bar'),
    range: el('range'), power: el('power'), distance: el('distance'),
    laps: el('laps'), best: el('best'), lean: el('lean'), glat: el('glat'),
    slide: el('slide')
  };

  /* Pointer capture per button is what makes multitouch work: throttle and
     steering are pressed by different thumbs at the same time, and a thumb
     that slides off its button must keep its input until it is lifted. */
  const steerHeld = new Set();
  hud.querySelectorAll('[data-fr-key]').forEach(button => {
    const action = button.dataset.frKey;
    const set = on => {
      if(action === 'throttle') touch.throttle = on ? 1 : 0;
      else if(action === 'brake') touch.brake = on ? 1 : 0;
      else if(action === 'handbrake') touch.handbrake = on;
      else {
        if(on) steerHeld.add(action); else steerHeld.delete(action);
        touch.steer = (steerHeld.has('right') ? 1 : 0) - (steerHeld.has('left') ? 1 : 0);
      }
      button.classList.toggle('on', on);
    };
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      try{ button.setPointerCapture(event.pointerId); }catch{ /* capture is best effort */ }
      set(true);
      if(window.parent !== window){
        window.parent.postMessage({type:'free-ride-input'},
          location.origin === 'null' ? '*' : location.origin);
      }
    });
    for(const type of ['pointerup', 'pointercancel', 'lostpointercapture']){
      button.addEventListener(type, () => set(false));
    }
    button.addEventListener('contextmenu', event => event.preventDefault());
  });
  // A backgrounded tab must not leave the throttle pinned open.
  const releaseAll = () => {
    hud.querySelectorAll('[data-fr-key].on').forEach(b => b.classList.remove('on'));
    steerHeld.clear();
    touch.throttle = touch.brake = touch.steer = 0;
    touch.handbrake = false;
    held.clear();
  };
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if(document.hidden) releaseAll(); });

  const formatTime = seconds => {
    if(!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };

  let hudClock = 0;
  function updateHud(dt){
    hudClock += dt;
    if(hudClock < 1 / 15) return;
    hudClock = 0;
    const spec = state.spec;
    const remaining = clamp01(1 - state.energyWh / spec.packWh);
    hudRefs.speed.textContent = Math.round(state.speed * KMH);
    hudRefs.battery.textContent = `${Math.round(remaining * 100)}%`;
    hudRefs.batteryBar.style.width = `${remaining * 100}%`;
    hudRefs.batteryBar.style.background = remaining < 0.15
      ? 'linear-gradient(90deg,#ff6a3d,#ff9a3d)'
      : 'linear-gradient(90deg,#f5c518,#ffe14d)';
    // Range from the energy actually spent so far, not from a brochure figure.
    const whPerKm = state.distance > 60 ? state.energyWh / (state.distance / 1000) : 0;
    hudRefs.range.textContent = whPerKm > 1
      ? `${((spec.packWh - state.energyWh) / whPerKm).toFixed(1)} ק״מ`
      : '—';
    hudRefs.power.textContent = `${Math.round(state.motorW)} W`;
    hudRefs.distance.textContent = `${(state.distance / 1000).toFixed(2)} ק״מ`;
    hudRefs.laps.textContent = String(state.laps);
    hudRefs.best.textContent = formatTime(state.bestLap);
    hudRefs.lean.textContent = `${Math.round(Math.abs(state.lean) * 57.2958)}°`;
    hudRefs.glat.textContent = `${state.lateralG.toFixed(2)} g`;
    const sliding = state.slip > 0.14;
    hudRefs.slide.textContent = sliding ? 'החלקה' : 'אחיזה';
    hudRefs.slide.classList.toggle('on', sliding);
  }

  /* ── loop ─────────────────────────────────────────────────────────── */
  function update(dt){
    readInput(dt);
    state.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while(state.accumulator >= FIXED_DT && steps < 12){
      step(FIXED_DT);
      state.accumulator -= FIXED_DT;
      steps++;
    }
    if(steps === 12) state.accumulator = 0;
    applyVisual(dt);
    updateHud(dt);
    sun.position.set(state.position.x - 70, 145, state.position.z + 95);
    sun.target.position.set(state.position.x, 0, state.position.z);
    sun.target.updateMatrixWorld();
    sky.position.set(state.position.x, 0, state.position.z);
    ground.position.set(state.position.x, -0.16, state.position.z);
  }

  function telemetry(){
    return {
      product: state.product,
      speedKmh: +(state.speed * KMH).toFixed(2),
      leanDeg: +(state.lean * 57.2958).toFixed(2),
      lateralG: +state.lateralG.toFixed(3),
      longitudinalG: +state.longitudinalG.toFixed(3),
      slip: +state.slip.toFixed(3),
      batteryPercent: +(100 * (1 - state.energyWh / state.spec.packWh)).toFixed(2),
      distanceM: +state.distance.toFixed(2),
      laps: state.laps,
      circuitLength: +circuitLength.toFixed(2),
      onTrack: distanceFromCentre() <= CIRCUIT_WIDTH * 0.5 + 1.6
    };
  }

  /** How far the machine is from the racing surface, for QA and for penalties. */
  function distanceFromCentre(){
    let best = Infinity;
    for(let i = 0; i <= 260; i++){
      const f = frameAt(i / 260);
      const dx = f.centre.x - state.position.x;
      const dz = f.centre.z - state.position.z;
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  setProduct(options.product || 'bike');

  // The host shows a loader until the circuit exists; announce, do not assume
  // the iframe's load event still has a listener attached by then.
  if(window.parent !== window){
    window.parent.postMessage(
      {type:'free-ride-ready', circuitLength:+circuitLength.toFixed(1)},
      location.origin === 'null' ? '*' : location.origin
    );
  }

  return {
    state, spec: () => state.spec, update, telemetry, setProduct,
    reset: resetVehicle,
    setInput: partial => Object.assign(touch, partial),
    dispose(){
      removeEventListener('keydown', keyDown);
      removeEventListener('keyup', keyUp);
      removeEventListener('blur', releaseAll);
      hud.remove();
      hudStyle.remove();
      scene.environmentIntensity = studioIntensity;
      camera.layers.disable(STUDIO_LAYER);
      if(rig) rig.traverse(node => { if(node.isLight) node.layers.set(0); });
      for(const product of [products.bike, products.scooter]){
        product.traverse(node => node.layers.disable(STUDIO_LAYER));
      }
      scene.remove(track);
      for(const resource of disposables) resource.dispose?.();
    }
  };
}
