/**
 * Run OpenZeppelin solidity-docgen without the Hardhat 2 plugin (extendConfig/task are removed in Hardhat 3).
 * Merges Hardhat 3 split build artifacts: <id>.json (input) + <id>.output.json (compiler output).
 *
 * Only passes the latest compile wave into docgen(): leftover build-info from other branches or
 * toolchains would otherwise share one global sourcesDir and can emit stale or mis-rooted docs.
 */
import { createRequire } from "module";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
// Avoid `require("solidity-docgen")`: its index always loads `./hardhat/type-extensions`,
// which `require()`s Hardhat 3 ESM and throws ERR_REQUIRE_ESM. The programmatic API is `main`.
const { main: docgen } = require("solidity-docgen/dist/main.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildInfoDir = path.join(root, "artifacts", "build-info");

/** Max age (ms) below the newest build-info mtime to treat as the same compile batch. */
const DEFAULT_WAVE_MS = Number.parseInt(process.env.DOCGEN_BUILD_WAVE_MS ?? "", 10) || 5000;

/**
 * @param {Array<{ mtimeMs: number, raw: string, build: { input: unknown, output: unknown } }>} entries
 */
function scopeToLatestCompileWave(entries) {
  if (entries.length <= 1) {
    return entries;
  }
  const maxMtime = Math.max(...entries.map((e) => e.mtimeMs));
  const scoped = entries.filter((e) => maxMtime - e.mtimeMs <= DEFAULT_WAVE_MS);
  scoped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return scoped;
}

function resolveSourcesDirFromScoped(scoped) {
  for (const { raw } of scoped) {
    if (raw.includes('"hh3-sol-build-info')) {
      return "project/contracts";
    }
  }
  return "contracts";
}

async function loadBuildsAndSourcesDir() {
  let entries;
  try {
    entries = await fs.readdir(buildInfoDir);
  } catch {
    throw new Error(
      `No ${buildInfoDir} found. Run "pnpm compile" (or "hardhat compile") before docgen.`,
    );
  }

  const mains = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".output.json"));
  /** @type {Array<{ mtimeMs: number, raw: string, build: { input: unknown, output: unknown } }>} */
  const collected = [];

  for (const file of mains) {
    const basePath = path.join(buildInfoDir, file);
    const stat = await fs.stat(basePath);
    const raw = await fs.readFile(basePath, "utf8");
    const data = JSON.parse(raw);

    const baseId = file.replace(/\.json$/i, "");
    const splitOutputPath = path.join(buildInfoDir, `${baseId}.output.json`);

    let output;
    try {
      const outRaw = await fs.readFile(splitOutputPath, "utf8");
      output = JSON.parse(outRaw).output;
    } catch {
      output = data.output;
    }

    if (!data.input || !output) {
      console.warn(`Skipping ${file}: missing compiler input or output`);
      continue;
    }

    collected.push({
      mtimeMs: stat.mtimeMs,
      raw,
      build: { input: data.input, output },
    });
  }

  const scoped = scopeToLatestCompileWave(collected);
  const dropped = collected.length - scoped.length;
  if (dropped > 0) {
    console.warn(
      `docgen: ignoring ${dropped} stale build-info file(s) not in the latest compile wave (newest mtime ± ${DEFAULT_WAVE_MS}ms).`,
    );
  }

  const sourcesDir =
    process.env.HH_DOCGEN_SOURCES_DIR ?? resolveSourcesDirFromScoped(scoped);

  return {
    builds: scoped.map((s) => s.build),
    sourcesDir,
  };
}

const { builds, sourcesDir } = await loadBuildsAndSourcesDir();

if (builds.length === 0) {
  throw new Error("No compiler builds found under artifacts/build-info.");
}

await docgen(builds, {
  root,
  sourcesDir,
  outputDir: "docs",
  pages: "single",
  exclude: [],
  collapseNewlines: true,
});
