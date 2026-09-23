import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  isDistributionRoot,
  isExamplesWorkspace,
  resolveCreativeProjectRoot,
} from "../src/creative-workspace.js";

test("isExamplesWorkspace detects paths under examples/", () => {
  const root = resolve("/repo");
  assert.equal(isExamplesWorkspace(join(root, "examples/byok-openai-compatible"), root), true);
  assert.equal(isExamplesWorkspace(join(root, "examples"), root), true);
  assert.equal(isExamplesWorkspace(join(root, "projects/default"), root), false);
});

test("isDistributionRoot matches the checkout root only", () => {
  const root = resolve("/repo");
  assert.equal(isDistributionRoot(root, root), true);
  assert.equal(isDistributionRoot(join(root, "examples/demo"), root), false);
});

test("resolveCreativeProjectRoot redirects examples/ to projects/<slug>/ in a checkout", async () => {
  const checkout = await mkdtempCheckout();
  try {
    const example = join(checkout, "examples/demo-example");
    await mkdir(example, { recursive: true });
    await writeFile(join(example, "hypit.runtime.json"), "{}\n", "utf8");

    const resolved = await resolveCreativeProjectRoot({
      workspaceRoot: example,
      distributionRoot: checkout,
    });

    assert.equal(resolved.projectRoot, join(checkout, "projects/demo-example"));
    assert.equal(resolved.redirectedFrom, example);
    assert.equal(await readFile(join(resolved.projectRoot, "package.json"), "utf8").then((text) => text.includes("hypit-creative-project")), true);
    assert.equal(await readFile(join(resolved.projectRoot, ".hypit/runtime"), "utf8").then((text) => text.trim()), "hypit.runtime.json");
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("resolveCreativeProjectRoot redirects the checkout root to projects/default/", async () => {
  const checkout = await mkdtempCheckout();
  try {
    const template = join(checkout, "examples/byok-openai-compatible");
    await mkdir(template, { recursive: true });
    await writeFile(join(template, "hypit.runtime.json"), "{}\n", "utf8");

    const resolved = await resolveCreativeProjectRoot({
      cwd: checkout,
      distributionRoot: checkout,
    });

    assert.equal(resolved.projectRoot, join(checkout, "projects/default"));
    assert.equal(resolved.redirectedFrom, checkout);
    await access(join(resolved.projectRoot, "hypit.runtime.json"));
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("resolveCreativeProjectRoot leaves standalone projects unchanged", async () => {
  const checkout = await mkdtempCheckout();
  const project = join(checkout, "my-video");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), "{}\n", "utf8");

    const resolved = await resolveCreativeProjectRoot({
      workspaceRoot: project,
      distributionRoot: checkout,
    });

    assert.equal(resolved.projectRoot, project);
    assert.equal(resolved.redirectedFrom, undefined);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

async function mkdtempCheckout(): Promise<string> {
  const root = join(tmpdir(), `hypit-creative-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(join(root, "package.json"), "{}\n", "utf8");
  return root;
}
