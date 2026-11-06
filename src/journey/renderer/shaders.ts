/**
 * GLSL for the stage. Two programs share one canvas:
 *
 *  - the scene pass draws the current picture (and the incoming one during a
 *    transition) through a simulated camera, and grades the result;
 *  - the particle pass adds stars, dust and embers on top, in perspective.
 *
 * Screen coordinates in the scene pass run 0–1 from the top-left, like the images.
 */

/** One triangle that covers the whole screen; needs no vertex buffers. */
export const screenVertex = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Each picture is drawn as a relief: a grid of vertices pushed towards the
 * camera by the picture's depth map, seen through a perspective camera that
 * flies forward. Near matter sweeps past the lens; distant light barely moves.
 */
export const meshVertex = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aGrid;   // 0…1 across the plane

uniform sampler2D uDepth;             // 1 = near, 0 = far
uniform vec3 uCamera;                 // world position; the camera looks down +z
uniform vec2 uProjection;             // (f / aspect, f), f = 1 / tan(fov / 2)
uniform float uPlaneZ;                // where the far plane of this picture sits
uniform vec2 uPlaneSize;              // picture size in world units (height = 1)
uniform float uRelief;                // how far near matter stands off the plane
uniform float uMargin;                // the plane extends this far past the picture (uv units)

out vec2 vUv;
out float vDepth;
out float vDist;

void main() {
  vec2 uv = mix(vec2(-uMargin), vec2(1.0 + uMargin), aGrid);
  float depth = texture(uDepth, uv).r;
  vec3 world = vec3((uv.x - 0.5) * uPlaneSize.x, (0.5 - uv.y) * uPlaneSize.y, uPlaneZ - depth * uRelief);
  vec3 view = world - uCamera;
  vUv = uv;
  vDepth = depth;
  vDist = view.z;
  // w = distance: perspective division, and anything behind the camera is clipped.
  gl_Position = vec4(view.x * uProjection.x, view.y * uProjection.y, 0.0, view.z);
}`;

export const meshFragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
in float vDepth;
in float vDist;
out vec4 fragColor;

uniform sampler2D uTex;
uniform float uFade;        // 0–1 while the picture is still loading in
uniform float uMargin;
uniform vec2 uFog;          // distances where the picture starts and finishes fading into the dark
uniform float uDissolve;    // 0–1: the picture gives way to the one behind it, far parts first
uniform float uTime;
uniform vec2 uResolution;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float clouds(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * valueNoise(p);
    p = p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return value / 0.9375;
}

void main() {
  vec3 color = texture(uTex, vUv).rgb * uFade;

  // Past the picture's edge the texture mirrors and softly fades out.
  vec2 e = smoothstep(vec2(-uMargin), vec2(0.0), vUv) * (1.0 - smoothstep(vec2(1.0), vec2(1.0 + uMargin), vUv));
  float edge = e.x * e.y;

  // Distant pictures sit in the dark until the camera comes closer.
  float fog = 1.0 - smoothstep(uFog.x, uFog.y, vDist);

  // Dissolve: the far sky goes first, the near rocks stay until they have swept past.
  float n = clouds(gl_FragCoord.xy / uResolution.y * 2.4 + uTime * 0.01);
  float arrival = vDepth * 0.72 + n * 0.28;
  float clock = mix(-0.3, 1.3, uDissolve);
  float keep = 1.0 - smoothstep(arrival - 0.3, arrival + 0.3, clock);

  fragColor = vec4(color * fog, edge * keep);
}`;

/**
 * The post pass reads the composed scene and adds everything that belongs to
 * the lens and the light: gravitational bending, the transition's refraction
 * front, motion blur with chromatic fringes, drifting gas, the procedural
 * nebula, the glow around the hole, and the grade.
 *
 * Screen coordinates run 0–1 from the top-left.
 */
export const postFragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uHaze;
uniform float uHazeAmount;
uniform float uHorizon;       // radius of the dark disc, in screen heights

uniform vec2 uResolution;
uniform float uTime;

// Transition front.
uniform float uMix;
uniform vec3 uMask;           // radial, noise, feather
uniform float uRefract;
uniform vec3 uFrontGlow;
uniform vec2 uOrigin;         // vanishing point on screen

// Motion.
uniform int uTaps;
uniform float uBlur;
uniform float uAberration;

// Gravity.
uniform vec2 uGravity;
uniform float uReach;
uniform float uLens;
uniform float uSwirl;
uniform float uSwirlPhase;
uniform float uGlow;
uniform float uFlow;

// Grade.
uniform float uExposure;
uniform float uWarmth;
uniform float uVignette;
uniform float uGrain;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float clouds(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * valueNoise(p);
    p = p * 2.03 + 17.1;
    amplitude *= 0.5;
  }
  return value / 0.9375;
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 readOnce(vec2 s) {
  return texture(uScene, vec2(s.x, 1.0 - s.y)).rgb;
}

// Reads the scene with optional radial motion blur. Samples are spread along
// the line to the vanishing point; weighting the colour channels differently
// along that line gives the blur a chromatic fringe.
vec3 readBlurred(vec2 s, float jitter) {
  float spread = uBlur + uAberration;
  if (uTaps <= 1 || spread < 0.0004) return readOnce(s);

  float chroma = 0.12 + 0.88 * clamp(uAberration / spread, 0.0, 1.0);
  vec3 total = vec3(0.0);
  vec3 weight = vec3(0.0);
  float count = float(uTaps);
  for (int i = 0; i < uTaps; i++) {
    float t = (float(i) + jitter) / count;
    vec2 sp = uOrigin + (s - uOrigin) * (1.0 - spread * (t - 0.5));
    vec3 w = mix(vec3(1.0), vec3(2.0 * (1.0 - t), 1.0, 2.0 * t), chroma);
    total += readOnce(sp) * w;
    weight += w;
  }
  return total / weight;
}

vec2 spin(vec2 s, float angle, vec2 aspect) {
  vec2 d = (s - uGravity) * aspect;
  float c = cos(angle);
  float n = sin(angle);
  return uGravity + vec2(c * d.x - n * d.y, n * d.x + c * d.y) / aspect;
}

// A slow, large-scale current for the gas to drift along.
vec2 current(vec2 s, vec2 aspect) {
  vec2 q = s * aspect * 1.7;
  return vec2(valueNoise(q + 3.1) - 0.5, valueNoise(q + vec2(7.7, 2.3)) - 0.5) * 2.0;
}

vec2 advect(vec2 s, float phase, float swirl, vec2 aspect) {
  vec2 moved = spin(s, swirl * phase, aspect);
  return moved + current(s, aspect) * uFlow * 0.02 * phase / aspect;
}

// Reads the scene while its gas drifts and the accretion disc turns. Two reads,
// half a cycle apart, are cross-faded so the motion never has to snap back (a
// flow map). The branch depends only on uniforms, which keeps texture gradients intact.
vec3 readScene(vec2 s, float jitter, float swirl, vec2 aspect) {
  if (uSwirl < 0.001 && uFlow < 0.001) return readBlurred(s, jitter);
  float phaseA = fract(uSwirlPhase);
  float phaseB = fract(uSwirlPhase + 0.5);
  vec3 a = readBlurred(advect(s, phaseA - 0.5, swirl, aspect), jitter);
  vec3 b = readBlurred(advect(s, phaseB - 0.5, swirl, aspect), jitter);
  return mix(a, b, abs(2.0 * phaseA - 1.0));
}

void main() {
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 screen = vec2(vUv.x, 1.0 - vUv.y);
  vec2 s = screen;

  // Gravity bends light: the view is magnified around the gravity point,
  // breathing slowly, with faint ripples travelling outwards.
  vec2 toGravity = (s - uGravity) * aspect;
  float gravityDist = length(toGravity);
  float g = gravityDist / uReach;
  float swirl = 0.0;
  if (uLens > 0.001) {
    vec2 dir = toGravity / max(gravityDist, 1e-4);
    float bend = g * exp(-3.0 * g * g) * 0.095 * uReach * (0.8 + 0.2 * sin(uTime * 0.55));
    float ripple = sin(g * 15.0 - uTime * 1.15) * 0.0022 * exp(-1.7 * g);
    s -= dir * (bend + ripple) * uLens / aspect;
  }
  if (uSwirl > 0.001) {
    swirl = uSwirl * 0.2 * smoothstep(1.1, 0.12, g);
  }

  // The advancing edge of a transition bends the view like a lens passing over it.
  float front = 0.0;
  if (uMix > 0.0 && uMix < 1.0 && uRefract + length(uFrontGlow) > 0.001) {
    vec2 fromOrigin = (screen - uOrigin) * aspect;
    float originDist = length(fromOrigin);
    float radial = originDist / length(max(uOrigin, 1.0 - uOrigin) * aspect);
    float noise = clouds(screen * aspect * 2.6 + vec2(uTime * 0.015, 0.0));
    float total = uMask.x + uMask.y + 1e-4;
    float feather = uMask.z;
    float clock = mix(-feather, 1.0 + feather, uMix);
    float arrival = (radial * uMask.x + noise * uMask.y) / total;
    front = exp(-pow((clock - arrival) / (0.6 * feather + 0.02), 2.0));
    s += (fromOrigin / max(originDist, 1e-4)) * front * uRefract * 0.035 / aspect;
  }

  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uTime * 3.7);
  vec3 color = readScene(s, jitter, swirl, aspect);

  // Light spills along the front, but only where there is light to carry it.
  color += uFrontGlow * front * 0.18 * (0.3 + luma(color));

  // Procedural gas, lensed like everything else since it is read at the bent
  // coordinate. It stays out of the event horizon.
  if (uHazeAmount > 0.001) {
    vec3 haze = texture(uHaze, vec2(s.x, 1.0 - s.y)).rgb;
    float outside = uHorizon > 0.0 ? smoothstep(uHorizon * 0.95, uHorizon * 1.5, gravityDist) : 1.0;
    color += haze * uHazeAmount * outside * (1.0 - 0.5 * luma(color));
  }

  // Light around the gravity point breathes. Multiplying keeps the black of the
  // event horizon black.
  if (uGlow > 0.001) {
    float pulse = 0.5 + 0.5 * sin(uTime * 0.8);
    color *= 1.0 + uGlow * (0.08 + 0.14 * pulse) * exp(-2.5 * g * g);
  }

  color *= uExposure;
  color *= mix(vec3(1.0), vec3(1.1, 0.97, 0.84), uWarmth);

  vec2 v = (screen - 0.5) * 2.0;
  color *= 1.0 - uVignette * smoothstep(0.15, 1.9, dot(v, v));

  // Film grain; also hides banding in the dark gradients.
  color += (hash12(gl_FragCoord.xy + fract(uTime) * 311.0) - 0.5) * uGrain;

  fragColor = vec4(max(color, 0.0), 1.0);
}`;

/**
 * Procedural nebula: layered, domain-warped noise that keeps evolving with time.
 * Rendered to a small texture (a quarter of the screen) — gas is soft, so the
 * resolution is not missed, and the cost stays low on any device.
 */
export const hazeFragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uEmber;       // 0 = blue and violet, 1 = embers
uniform vec2 uGravity;      // screen position of the gravity point (y down)
uniform float uReach;       // in screen heights
uniform float uTravel;      // distance travelled: the gas streams past
uniform vec2 uParallax;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 rotate = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    value += amplitude * valueNoise(p);
    p = rotate * p * 2.02 + 11.3;
    amplitude *= 0.5;
  }
  return value / 0.96875;
}

void main() {
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 screen = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = (screen - 0.5) * aspect * 1.5 + uParallax * 0.4;
  float t = uTime * 0.018;

  // Domain warping: the gas folds over itself as it drifts.
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - 0.7 * t));
  vec2 r = vec2(
    fbm(p + 3.2 * q + vec2(1.7, 9.2) + 0.5 * t + uTravel * 0.12),
    fbm(p + 3.2 * q + vec2(8.3, 2.8) - 0.4 * t)
  );
  float f = fbm(p + 2.6 * r);

  // Wisps, not a uniform fog.
  float density = smoothstep(0.38, 0.9, f) * (0.35 + 0.65 * smoothstep(0.2, 0.8, q.x));
  density *= 0.6 + 0.4 * sin(uTime * 0.12 + f * 7.0);

  vec3 deep = vec3(0.07, 0.12, 0.45);
  vec3 violet = vec3(0.34, 0.15, 0.62);
  vec3 magenta = vec3(0.72, 0.2, 0.52);
  vec3 cold = mix(deep, violet, smoothstep(0.3, 0.75, r.x));
  cold = mix(cold, magenta, 0.55 * smoothstep(0.55, 0.95, q.y));

  vec3 ember = mix(vec3(0.55, 0.18, 0.04), vec3(1.0, 0.58, 0.22), smoothstep(0.3, 0.8, r.y));
  float g = length((screen - uGravity) * aspect) / uReach;
  vec3 color = mix(cold, ember, uEmber * smoothstep(1.6, 0.2, g));

  fragColor = vec4(color * density, 1.0);
}`;

/**
 * Particles are stateless: each one's position is computed from fixed random
 * seeds, the distance travelled and the clock, so scrolling back moves them
 * back exactly while the ambient drift keeps going.
 *
 * Three layers: distant stars (thousands, almost still, a few slowly crossing
 * the view), dust streaming past, and a little out-of-focus bokeh up close.
 */
export const particleVertex = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec4 aSeed;    // x, y (−1…1), depth (0…1), random
layout(location = 1) in vec4 aTraits;  // layer (0 star, 1 dust, 2 bokeh), size, speed, drift

uniform vec2 uScale;        // fits the particle field to the screen's shape
uniform float uPixelScale;  // canvas height ÷ 900
uniform float uMaxSize;
uniform float uTravel;
uniform float uTime;
uniform float uOrbitPhase;
uniform float uEmber;
uniform float uStars;
uniform float uDensity;
uniform float uPull;        // how strongly matter falls towards the hole
uniform float uLens;
uniform float uReach;       // in field units
uniform float uIntensity;
uniform vec2 uPointer;
uniform vec3 uHole;         // xy = position in field units, z = radius (0 = none)

// For hiding far particles behind the picture's foreground.
uniform sampler2D uDepthA;
uniform sampler2D uDepthB;
uniform vec4 uViewA;
uniform vec4 uViewB;
uniform float uMix;
uniform float uOcclude;

out vec4 vColor;
out float vLayer;

void main() {
  float layer = aTraits.x;
  float speed = aTraits.z;
  float drift = aTraits.w;
  float random = aSeed.w;

  // Depth cycles from far (1) to near (0) as the camera moves forward; a
  // gentle ambient drift keeps it going when the scroll stops.
  float z = fract(aSeed.z - uTravel * speed - uTime * 0.0045 * speed);
  float depth = mix(0.22, 2.6, z);

  // A few stars slowly cross the field of view.
  float angle = random * 6.2832;
  vec2 xy = aSeed.xy + vec2(cos(angle), sin(angle)) * drift * uTime;
  xy = fract(xy * 0.5 + 0.5) * 2.0 - 1.0;

  vec2 p = xy * 2.4 / depth;
  p -= uPointer * 0.05 / depth;

  // Gravity: matter orbits the hole, and the closer it gets the faster it falls in.
  vec2 fromHole = p - uHole.xy;
  float holeDist = length(fromHole);
  float orbit = uOrbitPhase * speed / (0.35 + 1.5 * holeDist);
  float c = cos(orbit);
  float n = sin(orbit);
  fromHole = vec2(c * fromHole.x - n * fromHole.y, n * fromHole.x + c * fromHole.y);

  float fall = fract(uTime * 0.05 * (0.5 + speed) + random * 9.0);
  float pull = uPull * smoothstep(2.4, 0.2, holeDist) * (0.4 + 0.6 * speed);
  fromHole *= 1.0 - pull * fall * 0.9;
  holeDist = length(fromHole);
  p = uHole.xy + fromHole;

  // Gravitational lensing: light passing near the hole is bent outwards.
  float g = holeDist / max(uReach, 1e-3);
  float bend = g * exp(-3.0 * g * g) * 0.095 * uReach * uLens;
  p += fromHole / max(holeDist, 1e-4) * bend;

  gl_Position = vec4(p * uScale, 0.0, 1.0);

  float size = aTraits.y * uPixelScale / depth;
  gl_PointSize = clamp(size, 1.0, uMaxSize);

  float alpha = smoothstep(0.0, 0.14, z) * smoothstep(1.0, 0.8, z);
  alpha *= min(1.0, size);
  // Infalling matter fades just before it would reappear at its starting radius.
  alpha *= 1.0 - pull * smoothstep(0.8, 1.0, fall);
  // Nothing escapes.
  if (uHole.z > 0.0) alpha *= smoothstep(0.75 * uHole.z, 1.2 * uHole.z, holeDist);
  // Light is magnified around the ring.
  alpha *= 1.0 + 0.8 * uLens * exp(-pow((g - 0.45) / 0.25, 2.0));

  // Density grows along the journey: particles join in order of their random key.
  float density = layer < 0.5 ? mix(0.3, 1.0, uDensity) : uDensity;
  alpha *= smoothstep(density, density - 0.12, random);

  // Far particles sit inside the picture: the foreground hides them.
  if (uOcclude > 0.0) {
    vec2 clip = p * uScale;
    vec2 screen = vec2(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
    float near = mix(
      texture(uDepthA, uViewA.xy + (screen - 0.5) * uViewA.zw).r,
      texture(uDepthB, uViewB.xy + (screen - 0.5) * uViewB.zw).r,
      uMix
    );
    alpha *= 1.0 - uOcclude * smoothstep(0.3, 0.75, near) * z;
  }

  vec3 cold = mix(vec3(0.42, 0.55, 1.0), vec3(0.74, 0.5, 1.0), random);
  vec3 warm = mix(vec3(1.0, 0.5, 0.18), vec3(1.0, 0.8, 0.45), random);
  vec3 color = mix(cold, warm, uEmber);

  if (layer < 0.5) {
    float twinkle = 0.82 + 0.18 * sin(uTime * (0.5 + 1.6 * random) + random * 40.0);
    // Mostly white, a touch of colour temperature per star.
    color = mix(vec3(0.86, 0.9, 1.0), color, 0.3 + 0.3 * fract(random * 7.0));
    alpha *= (0.55 + 0.45 * fract(random * 13.0)) * twinkle * uStars;
  } else if (layer < 1.5) {
    alpha *= 0.45;
  } else {
    alpha *= 0.1;
  }

  vColor = vec4(color, alpha * uIntensity);
  vLayer = layer;
}`;

export const particleFragment = /* glsl */ `#version 300 es
precision mediump float;

in vec4 vColor;
in float vLayer;
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  // Bokeh is a soft-edged disc; stars and dust have a bright core.
  float shape = vLayer > 1.5 ? smoothstep(1.0, 0.45, d) : pow(1.0 - d, 2.4);
  fragColor = vec4(vColor.rgb * vColor.a * shape, 1.0);
}`;
