/**
 * Turns the six source PNGs in assets/source into web-ready WebP files.
 *
 *   npm run images
 *
 * For every scene it writes two variants into public/scenes (a full-size one and a
 * lighter one for low-powered devices) and records them in src/journey/scenes.manifest.json.
 * Images are only re-encoded and, for the light variant, scaled down proportionally —
 * they are never cropped, stretched or recoloured.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "assets/source");
const outDir = path.join(root, "public/scenes");
const manifestPath = path.join(root, "src/journey/scenes.manifest.json");

const LITE_WIDTH = 1024;
const QUALITY = { full: 84, lite: 78 };

const files = (await readdir(sourceDir)).filter((f) => /^scene-\d{2}-.+\.png$/.test(f)).sort();
if (files.length !== 6) {
  throw new Error(`Expected 6 scene images in ${sourceDir}, found ${files.length}.`);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const previous = await readFile(manifestPath, "utf8").then(JSON.parse, () => []);
const manifest = [];

for (const file of files) {
  const id = file.replace(/\.png$/, "");
  const input = await readFile(path.join(sourceDir, file));
  const { width, height } = await sharp(input).metadata();

  const variants = {};
  for (const [name, targetWidth] of [
    ["full", width],
    ["lite", Math.min(LITE_WIDTH, width)],
  ]) {
    const { data, info } = await sharp(input)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality: QUALITY[name], effort: 6, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
    const outName = `${id}.${name}.${hash}.webp`;
    await writeFile(path.join(outDir, outName), data);
    variants[name] = { src: `/scenes/${outName}`, width: info.width, height: info.height, bytes: data.length };
  }

  // Depth maps come from `npm run depth`; keep them if they exist.
  const depth = previous.find((entry) => entry.id === id)?.depth;
  manifest.push({ id, width, height, ...variants, ...(depth ? { depth } : {}) });
  const kb = (n) => `${Math.round(n / 1024)} kB`;
  console.log(`${id}: ${kb(input.length)} png → full ${kb(variants.full.bytes)}, lite ${kb(variants.lite.bytes)}`);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nWrote ${path.relative(root, manifestPath)}`);
