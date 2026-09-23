import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSvs } from "@hypit/svs";
import { renderText, sealTextBindings, textTemplateFromSvsRecipes } from "@hypit/text";

const cases = [
  {
    file: "h3-ugc-replica-v1.svs",
    id: "h3-ugc-replica-v1",
    bindings: { dialogue: "Follow the wind, live free." },
    marker: "Voice timbre follows reference audio 1",
  },
  {
    file: "h3-speaker-v1.svs",
    id: "h3-speaker-v1",
    bindings: { dialogue: "Follow the wind, live free." },
    marker: "Character speaks:",
  },
] as const;

test("MiniMax H3 Kits are finite data programs with distinct rendered semantics", () => {
  for (const item of cases) {
    const source = readFileSync(new URL(`../kits/${item.file}`, import.meta.url), "utf8");
    const recipes = parseSvs(item.file, source.slice(source.indexOf("<sheet"))).recipes.map((recipe) => recipe.value);
    const template = textTemplateFromSvsRecipes(recipes, item.id);
    const output = renderText(template, sealTextBindings(item.bindings));
    assert.match(output.value, new RegExp(item.marker, "u"), item.file);
    assert.doesNotMatch(output.value, /Seedance/u, item.file);
    if (item.id === "h3-ugc-replica-v1") {
      assert.doesNotMatch(output.value, /Tier list overlay:/u, item.file);
      assert.doesNotMatch(output.value, /Add no logos, watermarks, UI chrome/u, item.file);
    }
  }
});

test("h3-ugc-replica-v1 renders tier-list overlay only when the slot is supplied", () => {
  const source = readFileSync(new URL("../kits/h3-ugc-replica-v1.svs", import.meta.url), "utf8");
  const recipes = parseSvs("h3-ugc-replica-v1.svs", source.slice(source.indexOf("<sheet"))).recipes.map((recipe) => recipe.value);
  const template = textTemplateFromSvsRecipes(recipes, "h3-ugc-replica-v1");
  const output = renderText(template, sealTextBindings({
    dialogue: "Review tier-one milk brands in sixty seconds.",
    "tier-list": "Keep a fixed vertical ranking panel on the left side of the frame.",
  }));
  assert.match(output.value, /Tier list overlay:/u);
  assert.match(output.value, /ranking panel on the left side/u);
});
