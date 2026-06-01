import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolvePackageVersion(packageName: string): string | undefined {
  const directPackageJson = join(
    process.cwd(),
    "node_modules",
    ...packageName.split("/"),
    "package.json"
  );
  const directVersion = readVersion(packageName, directPackageJson);
  if (directVersion) {
    return directVersion;
  }

  let current = dirname(require.resolve(packageName));
  const root = parse(current).root;

  while (current !== root) {
    const packageJsonPath = join(current, "package.json");
    const version = readVersion(packageName, packageJsonPath);
    if (version) {
      return version;
    }
    current = dirname(current);
  }

  return undefined;
}

function readVersion(
  packageName: string,
  packageJsonPath: string
): string | undefined {
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };

  return pkg.name === packageName ? pkg.version : undefined;
}
