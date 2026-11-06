/** Most particles any quality level draws; lower levels draw the first N of the same set. */
export const MAX_PARTICLES = 6000;

const FLOATS_PER_PARTICLE = 8;

/** Small deterministic random generator, so the star field looks the same on every visit. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the particle field: three depth layers shuffled together so that any
 * prefix of the buffer contains the same mix.
 *
 *  - stars: thousands of fine points far away, nearly still; a few of them
 *    slowly cross the view, and a few are noticeably brighter
 *  - dust:  small motes that stream past as the camera advances
 *  - bokeh: a few large, faint, out-of-focus discs very close to the lens
 *
 * Layout per particle: x, y, depth, random, layer, size, speed, drift.
 */
export function buildParticles(): Float32Array {
  const random = seeded(20261106);
  const data = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);

  for (let i = 0; i < MAX_PARTICLES; i++) {
    const pick = random();
    const layer = pick < 0.8 ? 0 : pick < 0.975 ? 1 : 2;
    const o = i * FLOATS_PER_PARTICLE;

    data[o] = random() * 2 - 1;
    data[o + 1] = random() * 2 - 1;
    data[o + 3] = random();
    data[o + 4] = layer;

    if (layer === 0) {
      const bright = random() < 0.06;
      data[o + 2] = 0.4 + random() * 0.6; // stars keep to the distance
      data[o + 5] = bright ? 2.2 + random() * 1.4 : 0.9 + random() * 1.1;
      data[o + 6] = 0.04;
      data[o + 7] = random() < 0.04 ? 0.004 + random() * 0.008 : 0;
    } else if (layer === 1) {
      data[o + 2] = random();
      data[o + 5] = 1.8 + random() * 3.2;
      data[o + 6] = 0.5 + random() * 0.5;
      data[o + 7] = 0;
    } else {
      data[o + 2] = random();
      data[o + 5] = 16 + random() * 18;
      data[o + 6] = 0.8 + random() * 0.5;
      data[o + 7] = 0;
    }
  }
  return data;
}

/** Uploads the field and describes its layout. Returns the vertex array to draw from. */
export function createParticleBuffer(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
} {
  const vao = gl.createVertexArray()!;
  const buffer = gl.createBuffer()!;
  const stride = FLOATS_PER_PARTICLE * 4;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, buildParticles(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
  gl.bindVertexArray(null);
  return { vao, buffer };
}
