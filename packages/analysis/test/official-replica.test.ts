import assert from "node:assert/strict";
import test from "node:test";

import { isDefaultScenePrompt, validateOfficialSvml } from "../src/official-replica.js";

function validTimelineH3Svml(takeCount: number): string {
  const takes: string[] = [];
  for (let index = 1; index <= takeCount; index += 1) {
    const imageRefs = index === 1
      ? `      <h3:Reference image={product-reference}/>`
      : `      <h3:Reference image={product-reference}/>
      <h3:Reference image={shot_${index - 1}-last.image}/>`;
    takes.push(`
    <text:Render id="shot_${index}-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="shot_${index}-take" prompt={shot_${index}-prompt} duration="15" resolution="768P" aspect-ratio="9:16">
${imageRefs}
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>`);
    if (index < takeCount) {
      takes.push(`
    <pipeline:ExtractFrame id="shot_${index}-last" source={shot_${index}-take.video}
      video="primary-moving" at="last"/>`);
    }
  }
  return `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
    ${takes.join("")}
    <gpt:Image id="scene-2" prompt={scene-2-prompt} aspect-ratio="9:16" resolution="1K">
      <gpt:Reference image={product-reference}/>
    </gpt:Image>
  `;
}

test("validateOfficialSvml accepts timeline H3 scaffold with ugc-replica kit", () => {
  const report = validateOfficialSvml(validTimelineH3Svml(1), {
    videoAroll: true,
    requireProductReference: true,
  });
  assert.equal(report.ok, true);
});

test("validateOfficialSvml accepts multi-shot timeline H3 with last-frame chain", () => {
  const report = validateOfficialSvml(validTimelineH3Svml(2), {
    videoAroll: true,
    requireProductReference: true,
  });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.id === "h3-frame-chain" && check.ok));
});

test("validateOfficialSvml rejects legacy per-scene H3 scaffold", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
    <text:Render id="scene_1-prompt" template={speaker-kit.speaker-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="scene_1-take" prompt={scene_1-prompt} duration="4" resolution="768P" aspect-ratio="9:16">
      <h3:Reference image={product-reference}/>
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.id === "h3-timeline-shots" && !check.ok));
  assert.ok(report.checks.some((check) => check.id === "speaker-template" && !check.ok));
});

test("validateOfficialSvml rejects multi-shot H3 without last-frame chain", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
    <text:Render id="shot_1-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="shot_1-take" prompt={shot_1-prompt} duration="15" resolution="768P" aspect-ratio="9:16">
      <h3:Reference image={product-reference}/>
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>
    <pipeline:ExtractFrame id="shot_1-last" source={shot_1-take.video}
      video="primary-moving" at="last"/>
    <text:Render id="shot_2-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="shot_2-take" prompt={shot_2-prompt} duration="6" resolution="768P" aspect-ratio="9:16">
      <h3:Reference image={product-reference}/>
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.id === "h3-frame-chain" && !check.ok));
});

test("validateOfficialSvml rejects caption-fine overlay on H3 A-roll path", () => {
  const svml = `${validTimelineH3Svml(1)}
    <import as="caption-fine" from="@hypit/caption-fine@1"/>
    <caption-fine:Track id="captions" document={story.caption} timeline={speech.timeline}/>`;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.id === "h3-burned-captions" && !check.ok));
});

test("validateOfficialSvml rejects legacy reference-audio path", () => {
  const svml = `
    <asset:Audio id="reference-audio" src="../assets/reference-audio.wav"/>
    <gpt:Image id="scene-1" prompt={scene-1-prompt} aspect-ratio="9:16" resolution="1K"/>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.id === "no-reference-audio" && !check.ok));
});

test("validateOfficialSvml accepts TTS generated-speech without H3", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="generated-speech" src="../assets/generated-speech.wav"/>
    <gpt:Image id="scene-1" prompt={scene-1-prompt} aspect-ratio="9:16" resolution="1K">
      <gpt:Reference image={product-reference.image}/>
    </gpt:Image>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: false, requireProductReference: true });
  assert.equal(report.ok, true);
});

test("isDefaultScenePrompt detects template fallback", () => {
  assert.equal(
    isDefaultScenePrompt("Vertical 9:16 short-form social video frame, cinematic lighting, clean composition. Chinese product promo scene 1."),
    true,
  );
});
