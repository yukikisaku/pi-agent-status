import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLISHED_PACKAGES = ["pi-tmux-status", "pi-zed-status", "pi-orca-status", "pi-herdr-status"];

export function syncCore() {
  const source = join(ROOT, "packages", "core");

  for (const name of PUBLISHED_PACKAGES) {
    const target = join(ROOT, "packages", name, "core");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(source, target, {
      recursive: true,
      filter: (path) =>
        !path.includes("node_modules") &&
        !path.includes(`${sep}test`) &&
        !path.endsWith("package.json"),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  syncCore();
  console.log(`Synced core into: ${PUBLISHED_PACKAGES.join(", ")}`);
}
