import assert from "node:assert/strict";
import test from "node:test";

import { isDefaultScenePrompt, validateOfficialSvml } from "../src/official-replica.js";

test("validateOfficialSvml accepts official ugc speaker scaffold", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
    <text:Render id="shot_1-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="segment_1-take" prompt={segment_1-prompt} duration="8" resolution="768P" aspect-ratio="9:16">
      <h3:Reference image={product-reference.image}/>
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>
    <gpt:Image id="scene-2" prompt={scene-2-prompt} aspect-ratio="9:16" resolution="1K">
      <gpt:Reference image={product-reference}/>
    </gpt:Image>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, true);
});

test("validateOfficialSvml accepts presenter-voice without generated-speech asset id", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Audio id="presenter-voice" src="../assets/voice-reference.wav"/>
    <text:Render id="shot_1-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}/>
    <h3:ReferenceVideo id="segment-1-take" prompt={segment-1-prompt} duration="8" resolution="768P" aspect-ratio="9:16">
      <h3:Reference image={product-reference}/>
      <h3:Reference audio={presenter-voice}/>
    </h3:ReferenceVideo>
    <gpt:Image id="scene-2" prompt={scene-2-prompt} aspect-ratio="9:16" resolution="1K">
      <gpt:Reference image={product-reference}/>
    </gpt:Image>
  `;
  const report = validateOfficialSvml(svml, { videoAroll: true, requireProductReference: true });
  assert.equal(report.ok, true);
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
