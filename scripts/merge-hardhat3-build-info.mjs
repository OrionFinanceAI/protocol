import { promises as fs } from "node:fs";
import path from "node:path";

const buildInfoDir = path.resolve("artifacts/build-info");

async function main() {
  const entries = await fs.readdir(buildInfoDir);
  const mainFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".output.json"));

  for (const filename of mainFiles) {
    const mainPath = path.join(buildInfoDir, filename);
    const pairPath = path.join(buildInfoDir, filename.replace(/\.json$/i, ".output.json"));

    const mainRaw = await fs.readFile(mainPath, "utf8");
    const mainJson = JSON.parse(mainRaw);

    // Already compatible (HH2 style or previously merged)
    if (mainJson.output !== undefined) {
      continue;
    }

    try {
      const outRaw = await fs.readFile(pairPath, "utf8");
      const outJson = JSON.parse(outRaw);
      if (outJson.output === undefined) {
        continue;
      }

      mainJson.output = outJson.output;
      await fs.writeFile(mainPath, `${JSON.stringify(mainJson)}\n`);
    } catch {
      // Skip files without a pair; Slither will ignore/handle as needed.
    }
  }
}

main().catch((err) => {
  console.error("Failed to merge Hardhat 3 build-info for Slither:", err);
  process.exit(1);
});
