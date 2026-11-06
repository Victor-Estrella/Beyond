/**
 * Renders the journey frame by frame — the real WebGL stage and the real text,
 * in a headless Chrome — and turns the frames into:
 *
 *   out/beyond.mp4            H.264 video (and out/beyond.webm with --webm)
 *   public/sequence/*.webp    a lighter frame sequence for the scroll-driven
 *                             player at /sequence, plus its manifest.json
 *
 * Usage (after `npm run build`, which the script serves with `next start`):
 *
 *   npm run video -- [--fps 30] [--duration 48] [--width 1920] [--height 1080]
 *                    [--hold 1.5] [--sequence 160] [--sequence-width 1440]
 *                    [--webm] [--url http://localhost:3000] [--out out]
 *
 * `--hold` keeps the opening and closing frames still for that many seconds.
 * Every frame depends only on its progress and time (the page is opened with
 * `?render`), so the result is deterministic and can be re-rendered at any size.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Options

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};
const number = (name, fallback) => Number(option(name, fallback));

const fps = number("fps", 30);
const duration = number("duration", 48);
const width = number("width", 1920);
const height = number("height", 1080);
const hold = number("hold", 1.5);
const sequenceCount = number("sequence", 160);
const sequenceWidth = number("sequence-width", 1440);
const wantWebm = option("webm", false) === true;
const outDir = path.resolve(root, String(option("out", "out")));
const framesDir = path.join(outDir, "frames");
const sequenceDir = path.join(root, "public/sequence");
let url = option("url", null);

const totalFrames = Math.round(duration * fps);
const holdFrames = Math.round(hold * fps);

// ---------------------------------------------------------------------------
// Tools

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to its executable.");
  return found;
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

/** Serves the production build on a spare port until we are done. */
async function startServer() {
  if (!existsSync(path.join(root, ".next"))) {
    throw new Error("No production build found. Run `npm run build` first, or pass --url to a running server.");
  }
  const port = 3999;
  const server = spawn("npx", ["next", "start", "-p", String(port)], { cwd: root, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base);
      if (response.ok) return { base, stop: () => server.kill() };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  server.kill();
  throw new Error("The server did not come up.");
}

// ---------------------------------------------------------------------------
// Render

const ffmpeg = hasFfmpeg();
if (!ffmpeg) console.warn("ffmpeg not found: frames will be rendered, but no video will be encoded.");

let stopServer = () => {};
if (!url) {
  const server = await startServer();
  url = server.base;
  stopServer = server.stop;
}

await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--hide-scrollbars"],
});

try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") console.warn(`[page] ${message.text()}`);
  });
  await page.goto(`${url}/?render`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.beyond?.ready === true, { timeout: 60_000 });

  const webgl = await page.evaluate(() => !!document.querySelector("canvas")?.getContext("webgl2"));
  if (!webgl) console.warn("WebGL 2 is not available in this Chrome: rendering with the simplified stage.");

  console.log(`Rendering ${totalFrames} frames at ${width}×${height}, ${fps} fps…`);
  const started = Date.now();
  const journeyFrames = Math.max(1, totalFrames - 1 - holdFrames * 2);
  for (let i = 0; i < totalFrames; i++) {
    const progress = Math.min(1, Math.max(0, (i - holdFrames) / journeyFrames));
    await page.evaluate((p, t) => window.beyond.renderFrame(p, t), progress, i / fps);
    await page.screenshot({ type: "png", path: path.join(framesDir, `${String(i).padStart(5, "0")}.png`) });
    if (i % Math.ceil(totalFrames / 20) === 0 || i === totalFrames - 1) {
      const elapsed = (Date.now() - started) / 1000;
      const eta = (elapsed / (i + 1)) * (totalFrames - i - 1);
      console.log(`  ${String(Math.round((100 * (i + 1)) / totalFrames)).padStart(3)}%  frame ${i + 1}/${totalFrames}  (${elapsed.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s left)`);
    }
  }
} finally {
  await browser.close();
  stopServer();
}

// ---------------------------------------------------------------------------
// Encode

if (ffmpeg) {
  const input = ["-y", "-framerate", String(fps), "-i", path.join(framesDir, "%05d.png")];
  const mp4 = path.join(outDir, "beyond.mp4");
  console.log("Encoding beyond.mp4…");
  await run("ffmpeg", [
    ...input,
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-loglevel", "error", mp4,
  ]);
  console.log(`  ${path.relative(root, mp4)}`);

  if (wantWebm) {
    const webm = path.join(outDir, "beyond.webm");
    console.log("Encoding beyond.webm…");
    await run("ffmpeg", [...input, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", "-loglevel", "error", webm]);
    console.log(`  ${path.relative(root, webm)}`);
  }
}

// ---------------------------------------------------------------------------
// Scroll-driven frame sequence

if (sequenceCount > 0) {
  console.log(`Writing a ${sequenceCount}-frame sequence at ${sequenceWidth}px…`);
  await rm(sequenceDir, { recursive: true, force: true });
  await mkdir(sequenceDir, { recursive: true });
  const first = holdFrames;
  const last = totalFrames - 1 - holdFrames;
  let sequenceHeight = 0;
  for (let n = 0; n < sequenceCount; n++) {
    const source = Math.round(first + ((last - first) * n) / (sequenceCount - 1));
    const { info } = await sharp(path.join(framesDir, `${String(source).padStart(5, "0")}.png`))
      .resize({ width: sequenceWidth })
      .webp({ quality: 80, effort: 5 })
      .toBuffer({ resolveWithObject: true })
      .then(async (result) => {
        await writeFile(path.join(sequenceDir, `${String(n).padStart(4, "0")}.webp`), result.data);
        return result;
      });
    sequenceHeight = info.height;
  }
  await writeFile(
    path.join(sequenceDir, "manifest.json"),
    `${JSON.stringify({ count: sequenceCount, width: sequenceWidth, height: sequenceHeight, pattern: "/sequence/{index}.webp", pad: 4, source: { fps, duration, width, height } }, null, 2)}\n`,
  );
  console.log(`  public/sequence/ (${sequenceCount} frames + manifest.json)`);
}

console.log("Done.");
