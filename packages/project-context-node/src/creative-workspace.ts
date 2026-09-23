import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { resolveProjectRoot } from "./project-context.js";
import { findRuntimeProfile, selectRuntimeProfile } from "./runtime-selection.js";

const CREATIVE_PROJECT_PACKAGE = `${JSON.stringify({
  name: "hypit-creative-project",
  version: "0.0.0",
  private: true,
  type: "module",
}, null, 2)}\n`;

export type ResolveCreativeProjectRootOptions = {
  readonly workspaceRoot?: string;
  readonly cwd?: string;
  readonly distributionRoot?: string;
};

export type CreativeProjectRoot = {
  readonly projectRoot: string;
  readonly redirectedFrom?: string;
};

export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (resolvedParent === resolvedChild) return true;
  const rel = relative(resolvedParent, resolvedChild);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isExamplesWorkspace(path: string, distributionRoot: string): boolean {
  return isPathInside(join(resolve(distributionRoot), "examples"), path);
}

export function isDistributionRoot(path: string, distributionRoot: string): boolean {
  return resolve(path) === resolve(distributionRoot);
}

function projectSlugFromExamplesWorkspace(examplesWorkspace: string, distributionRoot: string): string {
  const rel = relative(join(resolve(distributionRoot), "examples"), resolve(examplesWorkspace));
  const slug = basename(rel.split(/[\\/]/u)[0] ?? "default");
  return slug.length > 0 ? slug : "default";
}

async function isDistributionCheckout(root: string): Promise<boolean> {
  try {
    await access(join(resolve(root), "pnpm-workspace.yaml"));
    return true;
  } catch {
    return false;
  }
}

async function ensureCreativeProjectRoot(
  projectRoot: string,
  sourceWorkspace: string,
  distributionRoot: string,
): Promise<void> {
  await mkdir(projectRoot, { recursive: true });

  const packageJson = join(projectRoot, "package.json");
  try {
    await access(packageJson);
  } catch {
    await writeFile(packageJson, CREATIVE_PROJECT_PACKAGE, "utf8");
  }

  const runtimeJson = join(projectRoot, "hypit.runtime.json");
  let runtimeReady = false;
  try {
    await access(runtimeJson);
    runtimeReady = true;
  } catch {
    const runtimeCandidates = [
      join(sourceWorkspace, "hypit.runtime.json"),
      join(distributionRoot, "examples/byok-openai-compatible/hypit.runtime.json"),
    ];
    for (const candidate of runtimeCandidates) {
      try {
        await access(candidate);
        await copyFile(candidate, runtimeJson);
        runtimeReady = true;
        break;
      } catch {
        // try next template
      }
    }
  }

  if (runtimeReady && await findRuntimeProfile(projectRoot) === undefined) {
    await selectRuntimeProfile(projectRoot, runtimeJson);
  }
}

/**
 * Resolve a video-project workspace for creative workflows.
 *
 * In a Hypit source checkout, examples/ and the repository root are fixtures — not
 * durable production locations. Those boundaries redirect to projects/<slug>/ instead.
 */
export async function resolveCreativeProjectRoot(
  options: ResolveCreativeProjectRootOptions = {},
): Promise<CreativeProjectRoot> {
  const distributionRoot = resolve(options.distributionRoot ?? options.cwd ?? process.cwd());
  const resolved = await resolveProjectRoot({
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    cwd: options.cwd,
  });

  if (!(await isDistributionCheckout(distributionRoot))) {
    return { projectRoot: resolved };
  }

  if (isExamplesWorkspace(resolved, distributionRoot)) {
    const slug = projectSlugFromExamplesWorkspace(resolved, distributionRoot);
    const projectRoot = join(distributionRoot, "projects", slug);
    await ensureCreativeProjectRoot(projectRoot, resolved, distributionRoot);
    return { projectRoot, redirectedFrom: resolved };
  }

  if (isDistributionRoot(resolved, distributionRoot)) {
    const projectRoot = join(distributionRoot, "projects", "default");
    const templateRoot = join(distributionRoot, "examples/byok-openai-compatible");
    await ensureCreativeProjectRoot(projectRoot, templateRoot, distributionRoot);
    return { projectRoot, redirectedFrom: resolved };
  }

  return { projectRoot: resolved };
}
