/**
 * Estimates a depth map for each scene picture with Depth Anything V2 (ONNX, on
 * the CPU) and writes it next to the colour variants in public/scenes.
 *
 *   npm run depth
 *
 * Depth maps let the renderer treat each picture as a relief: near matter
 * (foreground rocks, dust) slides and grows faster than the distant glow when
 * the camera moves. The model is downloaded on first run (~100 MB) and cached.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { env, pipeline, RawImage } from "@huggingface/transformers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "assets/source");
const outDir = path.join(root, "public/scenes");
const manifestPath = path.join(root, "src/journey/scenes.manifest.json");

env.cacheDir = path.join(root, "node_modules/.cache/transformers");

/** Depth maps are smooth, so a modest resolution is enough and keeps them light. */
const DEPTH_WIDTH = 1024;

const files = (await readdir(sourceDir)).filter((f) => /^scene-\d{2}-.+\.png$/.test(f)).sort();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.length !== files.length) {
  throw new Error("Run `npm run images` first so the manifest matches the source pictures.");
}

console.log("Loading Depth Anything V2 (small)…");
const estimate = await pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", {
  dtype: "fp32",
});
await mkdir(outDir, { recursive: true });

for (const [index, file] of files.entries()) {
  const id = file.replace(/\.png$/, "");
  const input = await readFile(path.join(sourceDir, file));
  const { data, info } = await sharp(input)
    .resize({ width: DEPTH_WIDTH })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  const { predicted_depth } = await estimate(image);

  // The model returns relative inverse depth (bright = near). Normalise per image
  // and keep that convention: 1 = nearest, 0 = farthest.
  const values = predicted_depth.data;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const [height, width] = predicted_depth.dims.slice(-2);
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < values.length; i++) gray[i] = Math.round(((values[i] - min) / (max - min)) * 255);

  const encoded = await sharp(gray, { raw: { width, height, channels: 1 } })
    // Softens the model's slight blockiness so nothing tears when displaced.
    .blur(1.2)
    .resize({ width: DEPTH_WIDTH, height: Math.round((DEPTH_WIDTH * info.height) / info.width) })
    .webp({ quality: 85, effort: 6 })
    .toBuffer();

  const hash = createHash("sha256").update(encoded).digest("hex").slice(0, 8);
  const outName = `${id}.depth.${hash}.webp`;
  await writeFile(path.join(outDir, outName), encoded);
  const meta = await sharp(encoded).metadata();
  manifest[index].depth = { src: `/scenes/${outName}`, width: meta.width, height: meta.height, bytes: encoded.length };
  console.log(`${id}: depth ${meta.width}×${meta.height}, ${Math.round(encoded.length / 1024)} kB`);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nUpdated ${path.relative(root, manifestPath)}`);
