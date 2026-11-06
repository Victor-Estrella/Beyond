import { cameraDistance, TAN_HALF_FOV, viewWindow, type ViewWindow } from "../camera";
import { lowerTier, type Quality } from "../quality";
import { IMAGE_ASPECT, SCENE_COUNT, scenes, transitions, type Point } from "../scenes";
import { activePair, travelDistance, type Frame } from "../state";
import { cameraPlans } from "../timeline";
import { createProgram, getUniforms, type Uniforms } from "./gl";
import { createParticleBuffer, MAX_PARTICLES } from "./particles";
import {
  hazeFragment,
  meshFragment,
  meshVertex,
  particleFragment,
  particleVertex,
  postFragment,
  screenVertex,
} from "./shaders";
import { SceneTextures } from "./textures";
import type { Stage } from "./types";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** A frame slower than this (in seconds) counts against the current quality level. */
const SLOW_FRAME = 1 / 42;
/** Seconds of sustained slow frames before quality is lowered. */
const PATIENCE = 1.5;
/** Smallest fraction of the target resolution we are willing to render at. */
const MIN_RESOLUTION = 0.6;
/** The procedural gas is rendered at this fraction of the screen. */
const HAZE_SCALE = 0.25;

/** Relief grid: vertices across and down each picture. */
const GRID_COLUMNS = 160;
const GRID_ROWS = 90;
/** How far the nearest matter stands off a picture's far plane (picture height = 1). */
const RELIEF = 0.34;
/** How far the camera turns towards the pointer (radians at the edge of the screen). */
const TILT_YAW = 0.11;
const TILT_PITCH = 0.075;
/** How far the camera banks while crossing a portal (radians). */
const BANK = 0.06;
/** The plane extends this far past the picture on every side (mirrored, fading out). */
const MARGIN = 0.5;
/** Distances (from the camera) where a picture starts and finishes fading into the dark. */
const FOG_NEAR = 1.05;
const FOG_FAR = 1.75;

interface Resources {
  meshProgram: WebGLProgram;
  meshUniforms: Uniforms;
  meshVao: WebGLVertexArrayObject;
  meshBuffers: WebGLBuffer[];
  meshIndexCount: number;
  sceneFramebuffer: WebGLFramebuffer;
  sceneTexture: WebGLTexture;
  postProgram: WebGLProgram;
  postUniforms: Uniforms;
  hazeProgram: WebGLProgram;
  hazeUniforms: Uniforms;
  hazeFramebuffer: WebGLFramebuffer;
  hazeTexture: WebGLTexture;
  hazeWidth: number;
  hazeHeight: number;
  particleProgram: WebGLProgram;
  particleUniforms: Uniforms;
  screenVao: WebGLVertexArrayObject;
  particleVao: WebGLVertexArrayObject;
  particleBuffer: WebGLBuffer;
  textures: SceneTextures;
  depths: SceneTextures;
  maxPointSize: number;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** World → camera rotation for a camera that has turned by yaw, tilted by pitch and banked by roll. */
function cameraRotation(yaw: number, pitch: number, roll: number): Mat3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // Row-major; each is the inverse of the camera's own rotation about that axis.
  const unYaw: Mat3 = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const unPitch: Mat3 = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const unRoll: Mat3 = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
  return multiply(unRoll, multiply(unPitch, unYaw));
}

function rotate(m: Mat3, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function createRenderTexture(gl: WebGL2RenderingContext, wrap: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return texture;
}

function createFramebuffer(gl: WebGL2RenderingContext, texture: WebGLTexture): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return framebuffer;
}

/** A grid of GRID_COLUMNS × GRID_ROWS quads spanning 0–1, for the relief meshes. */
function createGrid(gl: WebGL2RenderingContext) {
  const columns = GRID_COLUMNS + 1;
  const rows = GRID_ROWS + 1;
  const positions = new Float32Array(columns * rows * 2);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const o = (y * columns + x) * 2;
      positions[o] = x / GRID_COLUMNS;
      positions[o + 1] = y / GRID_ROWS;
    }
  }
  const indices = new Uint32Array(GRID_COLUMNS * GRID_ROWS * 6);
  let i = 0;
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLUMNS; x++) {
      const a = y * columns + x;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = d;
    }
  }

  const vao = gl.createVertexArray()!;
  const positionBuffer = gl.createBuffer()!;
  const indexBuffer = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, buffers: [positionBuffer, indexBuffer], count: indices.length };
}

export class WebGLStage implements Stage {
  readonly kind = "webgl" as const;

  private gl: WebGL2RenderingContext;
  private resources: Resources | null = null;
  private quality: Quality;

  private width = 0;
  private height = 0;
  private resolution = 1;
  private needsResize = true;

  private swirlPhase = 0;
  private orbitPhase = 0;
  private fading = false;
  private requested = new Set<number>();

  private frameTime = 1 / 60;
  private slowFor = 0;
  private warmup = 2;

  private view: ViewWindow = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  private viewB: ViewWindow = { cx: 0.5, cy: 0.5, w: 1, h: 1 };

  /** Returns a context if this browser can run the WebGL stage, otherwise null. */
  static context(canvas: HTMLCanvasElement, preserveDrawingBuffer = false): WebGL2RenderingContext | null {
    try {
      return canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer,
      });
    } catch {
      return null;
    }
  }

  constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    quality: Quality,
    /** Keeps the quality level fixed instead of adapting to frame times. */
    private fixedQuality = false,
  ) {
    this.gl = gl;
    this.quality = quality;
    this.setup();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private setup() {
    const gl = this.gl;
    const meshProgram = createProgram(gl, meshVertex, meshFragment);
    const postProgram = createProgram(gl, screenVertex, postFragment);
    const hazeProgram = createProgram(gl, screenVertex, hazeFragment);
    const particleProgram = createProgram(gl, particleVertex, particleFragment);
    const grid = createGrid(gl);
    const particles = createParticleBuffer(gl);
    const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;

    const sceneTexture = createRenderTexture(gl, gl.MIRRORED_REPEAT);
    const hazeTexture = createRenderTexture(gl, gl.CLAMP_TO_EDGE);

    this.resources = {
      meshProgram,
      meshUniforms: getUniforms(gl, meshProgram),
      meshVao: grid.vao,
      meshBuffers: grid.buffers,
      meshIndexCount: grid.count,
      sceneFramebuffer: createFramebuffer(gl, sceneTexture),
      sceneTexture,
      postProgram,
      postUniforms: getUniforms(gl, postProgram),
      hazeProgram,
      hazeUniforms: getUniforms(gl, hazeProgram),
      hazeFramebuffer: createFramebuffer(gl, hazeTexture),
      hazeTexture,
      hazeWidth: 0,
      hazeHeight: 0,
      particleProgram,
      particleUniforms: getUniforms(gl, particleProgram),
      screenVao: gl.createVertexArray()!,
      particleVao: particles.vao,
      particleBuffer: particles.buffer,
      textures: new SceneTextures(gl, SCENE_COUNT, (index) => scenes[index][this.quality.images].src),
      depths: new SceneTextures(gl, SCENE_COUNT, (index) => scenes[index].depth.src),
      maxPointSize: pointRange[1],
    };

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(meshProgram);
    gl.uniform1i(this.resources.meshUniforms.uTex, 0);
    gl.uniform1i(this.resources.meshUniforms.uDepth, 2);
    gl.useProgram(postProgram);
    gl.uniform1i(this.resources.postUniforms.uScene, 5);
    gl.uniform1i(this.resources.postUniforms.uHaze, 4);
    gl.useProgram(particleProgram);
    gl.uniform1i(this.resources.particleUniforms.uDepthA, 2);
    gl.uniform1i(this.resources.particleUniforms.uDepthB, 3);

    this.width = 0;
    this.height = 0;
    this.needsResize = true;
    for (const index of this.requested) void this.loadBoth(index);
  }

  private onContextLost = (event: Event) => {
    // Allows the browser to hand the context back; everything is rebuilt when it does.
    event.preventDefault();
    this.resources = null;
  };

  private onContextRestored = () => {
    this.setup();
  };

  load(index: number): Promise<void> {
    if (index < 0 || index >= SCENE_COUNT) return Promise.resolve();
    this.requested.add(index);
    return this.loadBoth(index);
  }

  private loadBoth(index: number): Promise<void> {
    const res = this.resources;
    if (!res) return Promise.resolve();
    return Promise.all([res.textures.load(index), res.depths.load(index)]).then(() => undefined);
  }

  resize() {
    this.needsResize = true;
  }

  /** Skips the fade-in of every loaded picture (offline rendering). */
  settle() {
    this.resources?.textures.settle();
    this.resources?.depths.settle();
  }

  isBusy() {
    return this.fading || this.needsResize;
  }

  private applySize() {
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    let ratio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    ratio = Math.min(ratio, Math.sqrt(this.quality.maxPixels / (cssWidth * cssHeight)));
    ratio *= this.resolution;

    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (width !== this.width || height !== this.height) {
      this.width = this.canvas.width = width;
      this.height = this.canvas.height = height;
      this.resizeTargets();
    }
    this.needsResize = false;
  }

  private resizeTargets() {
    const res = this.resources;
    if (!res) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, res.sceneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    res.hazeWidth = Math.max(1, Math.round(this.width * HAZE_SCALE));
    res.hazeHeight = Math.max(1, Math.round(this.height * HAZE_SCALE));
    gl.bindTexture(gl.TEXTURE_2D, res.hazeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, res.hazeWidth, res.hazeHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /** Lowers resolution first, then effects, when the device cannot keep up. */
  private watchPerformance(delta: number) {
    if (this.fixedQuality) return;
    if (delta <= 0 || delta > 0.1) return; // tab was in the background, or first frame
    if (this.warmup > 0) {
      this.warmup -= delta;
      return;
    }
    this.frameTime += (delta - this.frameTime) * 0.06;
    this.slowFor = this.frameTime > SLOW_FRAME ? this.slowFor + delta : Math.max(0, this.slowFor - delta);
    if (this.slowFor < PATIENCE) return;

    this.slowFor = 0;
    this.frameTime = 1 / 60;
    this.warmup = 1;

    if (this.resolution > MIN_RESOLUTION) {
      this.resolution = Math.max(MIN_RESOLUTION, this.resolution * 0.82);
      this.needsResize = true;
      return;
    }
    const lower = lowerTier(this.quality);
    if (lower) {
      this.quality = lower;
      this.resolution = 1;
      this.needsResize = true;
    }
  }

  /**
   * Where each picture's far plane sits along the flight path. Consecutive
   * scenes are spaced so that leaving one at its final zoom puts the camera
   * exactly where the next one's arrival zoom expects it: no jump at the handover.
   */
  private planeZ(index: number, coverHeight: number): number {
    let z = 0;
    for (let i = 0; i < index; i++) {
      z += cameraDistance(coverHeight / cameraPlans[i + 1].arrive) - cameraDistance(coverHeight / cameraPlans[i].leave);
    }
    return z;
  }

  render(frame: Frame) {
    const gl = this.gl;
    const res = this.resources;
    if (!res || gl.isContextLost()) return;

    this.watchPerformance(frame.delta);
    if (this.needsResize) this.applySize();
    if (this.width === 0 || this.height === 0) return;

    const { state, time, delta } = frame;
    const quality = this.quality;
    const aspect = this.width / this.height;
    const pair = activePair(state);
    const sceneA = scenes[pair.from];
    const sceneB = scenes[pair.to];
    const camera = state.cameras[pair.from];
    const mix = pair.mix;
    const blend = smooth(clamp01(mix));

    this.fading = res.textures.tick(delta) || res.depths.tick(delta);
    this.swirlPhase = (this.swirlPhase + delta * 0.11) % 1;
    this.orbitPhase += delta * state.orbit * 0.22;

    // The camera is never perfectly still: it drifts slowly and leans with the pointer.
    const sway = frame.calm ? 0 : 0.0045;
    const panX = Math.sin(time * 0.13) * sway + frame.pointerX * 0.012;
    const panY = Math.cos(time * 0.1) * sway + frame.pointerY * 0.012;

    // One camera flies through all the pictures. Its framing of the current
    // picture's far plane is exactly the 2D window the timeline describes.
    const view = viewWindow(camera, aspect, panX, panY, this.view);
    const cameraB = state.cameras[pair.to];
    const viewB = viewWindow(cameraB, aspect, panX, panY, this.viewB);
    const coverHeight = aspect < IMAGE_ASPECT ? 1 : IMAGE_ASPECT / aspect;
    const planeA = this.planeZ(pair.from, coverHeight);
    const planeB = this.planeZ(pair.to, coverHeight);
    // Sideways, the camera eases from framing the current picture to framing the next.
    const cameraX = lerp((view.cx - 0.5) * IMAGE_ASPECT, (viewB.cx - 0.5) * IMAGE_ASPECT, blend);
    const cameraY = lerp(0.5 - view.cy, 0.5 - viewB.cy, blend);
    const cameraZ = planeA - cameraDistance(view.h);
    const f = 1 / TAN_HALF_FOV;
    const projectionX = f / aspect;

    // The camera turns towards the pointer, drifts a little on its own, and
    // banks as it crosses a portal.
    const idleYaw = frame.calm ? 0 : Math.sin(time * 0.09) * 0.012;
    const idlePitch = frame.calm ? 0 : Math.cos(time * 0.07) * 0.008;
    const yaw = frame.pointerX * TILT_YAW + idleYaw;
    const pitch = -frame.pointerY * TILT_PITCH + idlePitch;
    const bank = frame.calm ? 0 : Math.sin(clamp01(mix) * Math.PI) * BANK * (pair.from % 2 === 0 ? 1 : -1);
    const rotation = cameraRotation(yaw, pitch, bank);
    // Column-major for WebGL.
    const rotationColumns = new Float32Array([
      rotation[0], rotation[3], rotation[6],
      rotation[1], rotation[4], rotation[7],
      rotation[2], rotation[5], rotation[8],
    ]);

    // Where a point of a picture's far plane lands on screen (0–1 from the top-left).
    const project = (point: Point, planeZ: number): [number, number] => {
      const [vx, vy, vz] = rotate(
        rotation,
        (point[0] - 0.5) * IMAGE_ASPECT - cameraX,
        0.5 - point[1] - cameraY,
        planeZ - cameraZ,
      );
      const d = Math.max(1e-3, vz);
      return [0.5 + (vx * projectionX) / d / 2, 0.5 - (vy * f) / d / 2];
    };

    // Everything streaks towards, and opens up from, the point the camera is heading to.
    const originA = project([camera.fx, camera.fy], planeA);
    const originB = project([cameraB.fx, cameraB.fy], planeB);
    const originBlend = smooth(clamp01(mix / 0.25));
    const originX = lerp(originA[0], originB[0], originBlend);
    const originY = lerp(originA[1], originB[1], originBlend);

    const gravityA = project(sceneA.gravity, planeA);
    const gravityB = project(sceneB.gravity, planeB);
    const gravityX = lerp(gravityA[0], gravityB[0], blend);
    const gravityY = lerp(gravityA[1], gravityB[1], blend);
    // Sizes on screen scale with the camera's distance to each plane.
    const screenScaleA = (cameraDistance(1) / Math.max(1e-3, planeA - cameraZ)) * (1 / coverHeight);
    const screenScaleB = (cameraDistance(1) / Math.max(1e-3, planeB - cameraZ)) * (1 / coverHeight);
    const reach = lerp(sceneA.reach * screenScaleA, sceneB.reach * screenScaleB, blend);
    const horizon = lerp(sceneA.horizon * screenScaleA, sceneB.horizon * screenScaleB, blend);

    // Scrolling fast adds a little streaking of its own.
    const speed = Math.abs(frame.velocity);
    const blur = state.blur + Math.min(0.05, speed * 0.14);
    const aberration = state.aberration + Math.min(0.006, speed * 0.02);
    const spread = blur + aberration;
    const taps = spread < 0.0004 ? 1 : blur < 0.004 ? 3 : quality.blurTaps;

    const travel = travelDistance(state);
    const hazeAmount = quality.fluid ? state.haze : state.haze * 0.6;

    gl.disable(gl.BLEND);
    gl.bindVertexArray(res.screenVao);

    // Pass 1: the procedural gas, at low resolution.
    if (hazeAmount > 0.001) {
      const h = res.hazeUniforms;
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.hazeFramebuffer);
      gl.viewport(0, 0, res.hazeWidth, res.hazeHeight);
      gl.useProgram(res.hazeProgram);
      gl.uniform2f(h.uResolution, res.hazeWidth, res.hazeHeight);
      gl.uniform1f(h.uTime, time);
      gl.uniform1f(h.uEmber, state.ember);
      gl.uniform2f(h.uGravity, gravityX, gravityY);
      gl.uniform1f(h.uReach, reach);
      gl.uniform1f(h.uTravel, travel);
      gl.uniform2f(h.uParallax, frame.pointerX * 0.03, frame.pointerY * 0.03);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Pass 2: the pictures as reliefs along the flight path, far one first.
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.sceneFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(res.meshProgram);
    gl.bindVertexArray(res.meshVao);
    const m = res.meshUniforms;
    gl.uniform3f(m.uCamera, cameraX, cameraY, cameraZ);
    gl.uniformMatrix3fv(m.uRotation, false, rotationColumns);
    gl.uniform2f(m.uProjection, projectionX, f);
    gl.uniform2f(m.uPlaneSize, IMAGE_ASPECT, 1);
    gl.uniform1f(m.uMargin, MARGIN);
    gl.uniform2f(m.uFog, FOG_NEAR, FOG_FAR);
    gl.uniform1f(m.uTime, time);
    gl.uniform2f(m.uResolution, this.width, this.height);
    const transition = transitions[Math.min(pair.from, transitions.length - 1)];
    gl.uniform1f(m.uMix, mix);
    if (frame.calm) {
      gl.uniform3f(m.uMask, 0, 0, 1);
    } else {
      gl.uniform3f(m.uMask, transition.radial, transition.noise, transition.feather);
    }
    gl.uniform2f(m.uOrigin, originX, originY);

    const drawPicture = (index: number, planeZ: number, portal: number) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, res.textures.texture(index));
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, res.depths.texture(index));
      gl.uniform1f(m.uFade, res.textures.fade(index));
      gl.uniform1f(m.uRelief, frame.calm ? 0 : RELIEF * scenes[index].relief);
      gl.uniform1f(m.uPlaneZ, planeZ);
      gl.uniform1f(m.uPortal, portal);
      gl.drawElements(gl.TRIANGLES, res.meshIndexCount, gl.UNSIGNED_INT, 0);
    };
    if (mix > 0 && pair.to !== pair.from) drawPicture(pair.to, planeB, 0);
    drawPicture(pair.from, planeA, 1);
    gl.disable(gl.BLEND);

    // Pass 3: lens and light, to the screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(res.postProgram);
    gl.bindVertexArray(res.screenVao);
    const u = res.postUniforms;

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, res.sceneTexture);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, res.hazeTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, res.depths.texture(pair.from));
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, res.depths.texture(pair.to));

    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uTime, time);

    gl.uniform1f(u.uMix, mix);
    if (frame.calm) {
      gl.uniform3f(u.uMask, 0, 0, 1);
      gl.uniform1f(u.uRefract, 0);
      gl.uniform3f(u.uFrontGlow, 0, 0, 0);
    } else {
      gl.uniform3f(u.uMask, transition.radial, transition.noise, transition.feather);
      gl.uniform1f(u.uRefract, transition.refract);
      gl.uniform3f(u.uFrontGlow, transition.glow[0], transition.glow[1], transition.glow[2]);
    }
    gl.uniform2f(u.uOrigin, originX, originY);

    gl.uniform1i(u.uTaps, taps);
    gl.uniform1f(u.uBlur, blur);
    gl.uniform1f(u.uAberration, aberration);

    gl.uniform2f(u.uGravity, gravityX, gravityY);
    gl.uniform1f(u.uReach, reach);
    gl.uniform1f(u.uLens, state.lens);
    gl.uniform2f(u.uPointer, (frame.pointerX + 1) / 2, (frame.pointerY + 1) / 2);
    gl.uniform1f(u.uPointerLens, frame.calm || !frame.pointerActive ? 0 : 1);
    gl.uniform1f(u.uSwirl, quality.fluid ? state.swirl : 0);
    gl.uniform1f(u.uSwirlPhase, this.swirlPhase);
    gl.uniform1f(u.uGlow, state.glow);
    // Gas drift costs a second read of the scene; it is invisible under heavy blur anyway.
    const flow = quality.fluid ? state.flow * (1 - smooth(clamp01((blur - 0.02) / 0.05))) : 0;
    gl.uniform1f(u.uFlow, flow);
    gl.uniform1f(u.uHazeAmount, hazeAmount);
    gl.uniform1f(u.uHorizon, horizon);

    gl.uniform1f(u.uExposure, state.exposure * frame.intro);
    gl.uniform1f(u.uWarmth, state.warmth);
    gl.uniform1f(u.uVignette, state.vignette);
    gl.uniform1f(u.uGrain, frame.calm ? 0.02 : 0.045);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 4: particles, light added on top.
    const scaleX = aspect >= 1 ? 1 : 1 / aspect;
    const scaleY = aspect >= 1 ? aspect : 1;
    const p = res.particleUniforms;
    gl.useProgram(res.particleProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.uniform2f(p.uScale, scaleX, scaleY);
    gl.uniform1f(p.uPixelScale, this.height / 900);
    gl.uniform1f(p.uMaxSize, Math.min(res.maxPointSize, (110 * this.height) / 900));
    gl.uniform1f(p.uTravel, travel * 0.85);
    gl.uniform1f(p.uTime, time);
    gl.uniform1f(p.uOrbitPhase, this.orbitPhase);
    gl.uniform1f(p.uEmber, state.ember);
    gl.uniform1f(p.uStars, state.stars);
    gl.uniform1f(p.uDensity, state.density);
    gl.uniform1f(p.uPull, state.pull);
    gl.uniform1f(p.uLens, state.lens);
    gl.uniform1f(p.uReach, (reach * 2) / scaleY);
    // Far particles hide behind the current picture's foreground (its window on the far plane).
    gl.uniform4f(p.uViewA, view.cx, view.cy, view.w, view.h);
    gl.uniform4f(p.uViewB, view.cx, view.cy, view.w, view.h);
    gl.uniform1f(p.uMix, 0);
    const depthReady = res.depths.isReady(pair.from);
    gl.uniform1f(p.uOcclude, quality.depth && depthReady && mix < 0.5 ? 0.85 : 0);
    gl.uniform1f(p.uIntensity, frame.intro * Math.min(1, 0.35 + state.exposure));
    gl.uniform2f(p.uPointer, frame.pointerX, -frame.pointerY);
    gl.uniform3f(p.uHole, (gravityX * 2 - 1) / scaleX, (1 - gravityY * 2) / scaleY, (horizon * 2) / scaleY);

    gl.bindVertexArray(res.particleVao);
    gl.drawArrays(gl.POINTS, 0, Math.min(quality.particles, MAX_PARTICLES));
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    const res = this.resources;
    if (!res) return;
    res.textures.dispose();
    res.depths.dispose();
    gl.deleteProgram(res.meshProgram);
    gl.deleteProgram(res.postProgram);
    gl.deleteProgram(res.hazeProgram);
    gl.deleteProgram(res.particleProgram);
    gl.deleteFramebuffer(res.sceneFramebuffer);
    gl.deleteFramebuffer(res.hazeFramebuffer);
    gl.deleteTexture(res.sceneTexture);
    gl.deleteTexture(res.hazeTexture);
    gl.deleteVertexArray(res.meshVao);
    for (const buffer of res.meshBuffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(res.screenVao);
    gl.deleteVertexArray(res.particleVao);
    gl.deleteBuffer(res.particleBuffer);
    this.resources = null;
  }
}
