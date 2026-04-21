import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildInfoDir = path.join(root, "artifacts", "build-info");

function getPackageSpec(sourcePath) {
  // npm/@scope/name@1.2.3/...
  const rel = sourcePath.slice("npm/".length);
  const parts = rel.split("/");
  if (parts[0].startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

function parsePackageName(spec) {
  // "@scope/name@1.2.3" -> "@scope/name", "pkg@1.2.3" -> "pkg"
  if (spec.startsWith("@")) {
    const [scope, namedWithVersion] = spec.split("/");
    if (!namedWithVersion) return null;
    const name = namedWithVersion.replace(/@[^/]+$/u, "");
    return `${scope}/${name}`;
  }
  return spec.replace(/@[^/]+$/u, "");
}

async function ensureSymlink(linkPath, targetPath) {
  try {
    const st = await fs.lstat(linkPath);
    if (st.isSymbolicLink()) return;
    return;
  } catch {
    // missing
  }

  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(targetPath, linkPath, "dir");
}

async function main() {
  const entries = await fs.readdir(buildInfoDir);
  const mainFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".output.json"));

  const virtualSources = new Set();
  for (const filename of mainFiles) {
    const fullPath = path.join(buildInfoDir, filename);
    const data = JSON.parse(await fs.readFile(fullPath, "utf8"));
    if (data?.input?.sources) {
      for (const src of Object.keys(data.input.sources)) {
        if (src.startsWith("npm/")) virtualSources.add(src);
      }
    }
  }

  for (const src of virtualSources) {
    const spec = getPackageSpec(src);
    if (!spec) continue;
    const packageName = parsePackageName(spec);
    if (!packageName) continue;

    const linkPath = path.join(root, "npm", spec);
    const targetPath = path.relative(path.dirname(linkPath), path.join(root, "node_modules", packageName));
    await ensureSymlink(linkPath, targetPath);
  }
}

main().catch((err) => {
  console.error("Failed to create virtual source links:", err);
  process.exit(1);
});
