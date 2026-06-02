import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

export function resolveProjectCwd(
  project: string | undefined,
  workspace = process.env.WORKSPACE ?? resolve(homedir(), ".agent-bridge")
): string {
  const requestedProject = project?.trim() || ".";

  if (isAbsolute(requestedProject)) {
    throw new Error("project must be a relative path");
  }

  const projectsRoot = resolve(expandHome(workspace), "projects");
  const cwd = resolve(projectsRoot, requestedProject);
  const relativePath = relative(projectsRoot, cwd);

  if (
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("project must stay inside WORKSPACE/projects");
  }

  return cwd;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}
