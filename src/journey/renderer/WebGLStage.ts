import { toScreen, viewWindow, type ViewWindow } from "../camera";
import { lowerTier, type Quality } from "../quality";
import { SCENE_COUNT, scenes, transitions } from "../scenes";
import { activePair, BASE_ZOOM, travelDistance, type Frame } from "../state";
import { createProgram, getUniforms, type Uniforms } from "./gl";
import { createParticleBuffer, MAX_PARTICLES } from "./particles";
import { hazeFragment, particleFragment, particleVertex, sceneFragment, screenVertex } from "./shaders";
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

interface Resources {
  sceneProgram: WebGLProgram;
  sceneUniforms: Uniforms;
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

  private viewA: ViewWindow = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
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
    const sceneProgram = createProgram(gl, screenVertex, sceneFragment);
    const hazeProgram = createProgram(gl, screenVertex, hazeFragment);
    const particleProgram = createProgram(gl, particleVertex, particleFragment);
    const particles = createParticleBuffer(gl);
    const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;

    const hazeTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, hazeTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const hazeFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, hazeFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hazeTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.resources = {
      sceneProgram,
      sceneUniforms: getUniforms(gl, sceneProgram),
      hazeProgram,
      hazeUniforms: getUniforms(gl, hazeProgram),
      hazeFramebuffer,
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
    gl.useProgram(sceneProgram);
    gl.uniform1i(this.resources.sceneUniforms.uSceneA, 0);
    gl.uniform1i(this.resources.sceneUniforms.uSceneB, 1);
    gl.uniform1i(this.resources.sceneUniforms.uDepthA, 2);
    gl.uniform1i(this.resources.sceneUniforms.uDepthB, 3);
    gl.uniform1i(this.resources.sceneUniforms.uHaze, 4);
    gl.useProgram(particleProgram);
    gl.uniform1i(this.resources.particleUniforms.uDepthA, 2);
    gl.uniform1i(this.resources.particleUniforms.uDepthB, 3);

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
    if (this.quality.depth) void res.depths.load(index);
    return res.textures.load(index);
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
      this.resizeHaze();
    }
    this.needsResize = false;
  }

  private resizeHaze() {
    const res = this.resources;
    if (!res) return;
    const gl = this.gl;
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
    const cameraA = state.cameras[pair.from];
    const cameraB = state.cameras[pair.to];
    const mix = pair.mix;
    const blend = smooth(clamp01(mix));

    this.fading = res.textures.tick(delta);
    res.depths.tick(delta);
    this.swirlPhase = (this.swirlPhase + delta * 0.11) % 1;
    this.orbitPhase += delta * state.orbit * 0.22;

    // The camera is never perfectly still: it drifts slowly and leans with the pointer.
    const sway = frame.calm ? 0 : 0.0045;
    const panX = Math.sin(time * 0.13) * sway + frame.pointerX * 0.012;
    const panY = Math.cos(time * 0.1) * sway + frame.pointerY * 0.012;
    const viewA = viewWindow(cameraA, aspect, panX, panY, this.viewA);
    const viewB = viewWindow(cameraB, aspect, panX, panY, this.viewB);

    // Everything streaks towards, and opens up from, the point the camera is heading to.
    const originA = toScreen([cameraA.fx, cameraA.fy], viewA);
    const originB = toScreen([cameraB.fx, cameraB.fy], viewB);
    const originBlend = smooth(clamp01(mix / 0.25));
    const originX = lerp(originA[0], originB[0], originBlend);
    const originY = lerp(originA[1], originB[1], originBlend);

    const gravityA = toScreen(sceneA.gravity, viewA);
    const gravityB = toScreen(sceneB.gravity, viewB);
    const gravityX = lerp(gravityA[0], gravityB[0], blend);
    const gravityY = lerp(gravityA[1], gravityB[1], blend);
    const reach = lerp(sceneA.reach / viewA.h, sceneB.reach / viewB.h, blend);
    const horizon = lerp(sceneA.horizon / viewA.h, sceneB.horizon / viewB.h, blend);

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
      if (res.hazeWidth === 0) this.resizeHaze();
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Pass 2: the pictures through the camera.
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(res.sceneProgram);
    const u = res.sceneUniforms;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.textures.texture(pair.from));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, res.textures.texture(pair.to));
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, res.depths.texture(pair.from));
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, res.depths.texture(pair.to));
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, res.hazeTexture);

    gl.uniform4f(u.uViewA, viewA.cx, viewA.cy, viewA.w, viewA.h);
    gl.uniform4f(u.uViewB, viewB.cx, viewB.cy, viewB.w, viewB.h);
    gl.uniform1f(u.uFadeA, res.textures.fade(pair.from));
    gl.uniform1f(u.uFadeB, res.textures.fade(pair.to));
    gl.uniform2f(u.uResolution, this.width, this.height);
    gl.uniform1f(u.uTime, time);

    const transition = transitions[Math.min(pair.from, transitions.length - 1)];
    gl.uniform1f(u.uMix, mix);
    if (frame.calm) {
      // A very wide feather with no pattern is an even cross-fade.
      gl.uniform4f(u.uMask, 0, 0, 0, 8);
      gl.uniform1f(u.uRefract, 0);
      gl.uniform3f(u.uFrontGlow, 0, 0, 0);
    } else {
      gl.uniform4f(u.uMask, transition.radial, transition.noise, transition.luma, transition.feather);
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
    gl.uniform1f(u.uSwirl, quality.fluid ? state.swirl : 0);
    gl.uniform1f(u.uSwirlPhase, this.swirlPhase);
    gl.uniform1f(u.uGlow, state.glow);

    // Gas drift costs a second read of each picture; it is invisible under heavy blur anyway.
    const flow = quality.fluid ? state.flow * (1 - smooth(clamp01((blur - 0.02) / 0.05))) : 0;
    gl.uniform1f(u.uFlow, flow);
    gl.uniform1f(u.uHazeAmount, hazeAmount);
    gl.uniform1f(u.uHorizon, horizon);
    // Depth-aware motion: the pointer, a slow sway, and the push forward all move
    // near matter more than far. Only applied once a scene's depth map has arrived.
    const depthReady = res.depths.isReady(pair.from) && (mix <= 0 || res.depths.isReady(pair.to));
    const drift = frame.calm ? 0 : 0.006;
    gl.uniform1f(u.uDepth, quality.depth && depthReady ? 1 : 0);
    gl.uniform2f(
      u.uParallax,
      frame.pointerX * 0.014 + Math.sin(time * 0.17) * drift,
      frame.pointerY * 0.014 + Math.cos(time * 0.13) * drift,
    );
    gl.uniform2f(
      u.uDolly,
      Math.min(0.09, 0.11 * Math.log(cameraA.zoom / BASE_ZOOM)),
      Math.min(0.09, 0.11 * Math.log(cameraB.zoom / BASE_ZOOM)),
    );

    gl.uniform1f(u.uExposure, state.exposure * frame.intro);
    gl.uniform1f(u.uWarmth, state.warmth);
    gl.uniform1f(u.uVignette, state.vignette);
    gl.uniform1f(u.uGrain, frame.calm ? 0.02 : 0.045);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: particles, light added on top of the picture.
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
    gl.uniform4f(p.uViewA, viewA.cx, viewA.cy, viewA.w, viewA.h);
    gl.uniform4f(p.uViewB, viewB.cx, viewB.cy, viewB.w, viewB.h);
    gl.uniform1f(p.uMix, blend);
    gl.uniform1f(p.uOcclude, quality.depth && depthReady ? 0.85 : 0);
    gl.uniform1f(p.uIntensity, frame.intro * Math.min(1, 0.35 + state.exposure));
    gl.uniform2f(p.uPointer, frame.pointerX, -frame.pointerY);
    gl.uniform3f(
      p.uHole,
      (gravityX * 2 - 1) / scaleX,
      (1 - gravityY * 2) / scaleY,
      (horizon * 2) / scaleY,
    );

    gl.bindVertexArray(res.particleVao);
    gl.drawArrays(gl.POINTS, 0, Math.min(quality.particles, MAX_PARTICLES));
    gl.bindVertexArray(null);
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    const gl = this.gl;
    const res = this.resources;
    if (!res) return;
    res.textures.dispose();
    res.depths.dispose();
    gl.deleteProgram(res.sceneProgram);
    gl.deleteProgram(res.hazeProgram);
    gl.deleteFramebuffer(res.hazeFramebuffer);
    gl.deleteTexture(res.hazeTexture);
    gl.deleteProgram(res.particleProgram);
    gl.deleteVertexArray(res.screenVao);
    gl.deleteVertexArray(res.particleVao);
    gl.deleteBuffer(res.particleBuffer);
    this.resources = null;
  }
}
