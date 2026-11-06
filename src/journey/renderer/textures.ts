/** Seconds a picture takes to fade in once it has loaded. */
const FADE_IN = 0.7;

interface Entry {
  texture: WebGLTexture | null;
  /** 0–1: how far the picture has faded in. */
  fade: number;
  loading: Promise<void> | null;
}

async function decode(src: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    // Decodes off the main thread, so a picture arriving mid-scroll does not cause a hitch.
    const response = await fetch(src);
    if (!response.ok) throw new Error(`${src} responded with ${response.status}`);
    return createImageBitmap(await response.blob());
  }
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return image;
}

/**
 * Loads scene pictures on demand and keeps them as GPU textures. Until a picture
 * is ready the scene is drawn black, and then fades in.
 */
export class SceneTextures {
  private entries: Entry[];
  private blank: WebGLTexture;
  private disposed = false;

  constructor(
    private gl: WebGL2RenderingContext,
    count: number,
    private source: (index: number) => string,
  ) {
    this.entries = Array.from({ length: count }, () => ({ texture: null, fade: 0, loading: null }));
    this.blank = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  load(index: number): Promise<void> {
    const entry = this.entries[index];
    if (!entry) return Promise.resolve();
    if (!entry.loading) {
      entry.loading = decode(this.source(index)).then(
        (image) => this.upload(entry, image),
        (error) => {
          // Leave the door open for another attempt the next time this scene is needed.
          entry.loading = null;
          console.warn(`[beyond] Could not load scene ${index + 1}.`, error);
        },
      );
    }
    return entry.loading;
  }

  private upload(entry: Entry, image: ImageBitmap | HTMLImageElement) {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost()) return;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Mirroring keeps blur and lens samples that land past an edge looking natural.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    if ("close" in image) image.close();
    entry.texture = texture;
  }

  texture(index: number): WebGLTexture {
    return this.entries[index]?.texture ?? this.blank;
  }

  fade(index: number): number {
    const fade = this.entries[index]?.fade ?? 0;
    return fade * fade * (3 - 2 * fade);
  }

  isReady(index: number): boolean {
    return this.entries[index]?.texture != null;
  }

  /** Marks every loaded picture as fully faded in. */
  settle() {
    for (const entry of this.entries) if (entry.texture) entry.fade = 1;
  }

  /** Advances fade-ins. Returns true while any picture is still fading. */
  tick(delta: number): boolean {
    let fading = false;
    for (const entry of this.entries) {
      if (entry.texture && entry.fade < 1) {
        entry.fade = Math.min(1, entry.fade + delta / FADE_IN);
        fading = true;
      }
    }
    return fading;
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries) {
      if (entry.texture) this.gl.deleteTexture(entry.texture);
      entry.texture = null;
    }
    this.gl.deleteTexture(this.blank);
  }
}
