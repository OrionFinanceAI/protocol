/**
 * Run OpenZeppelin solidity-docgen without the Hardhat 2 plugin (extendConfig/task are removed in Hardhat 3).
 * Merges Hardhat 3 split build artifacts: <id>.json (input) + <id>.output.json (compiler output).
 */
import { createRequire } from "module";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { docgen } = require("solidity-docgen");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildInfoDir = path.join(root, "artifacts", "build-info");

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
  const builds = [];
  let sourcesDir = "contracts";

  for (const file of mains) {
    const basePath = path.join(buildInfoDir, file);
    const stat = await fs.stat(basePath);
    const raw = await fs.readFile(basePath, "utf8");
    const data = JSON.parse(raw);
    if (raw.includes('"hh3-sol-build-info')) {
      sourcesDir = "project/contracts";
    }

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

    builds.push({
      mtime: stat.mtimeMs,
      build: { input: data.input, output },
    });
  }

  builds.sort((a, b) => b.mtime - a.mtime);
  return {
    builds: builds.map((b) => b.build),
    sourcesDir: process.env.HH_DOCGEN_SOURCES_DIR ?? sourcesDir,
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
