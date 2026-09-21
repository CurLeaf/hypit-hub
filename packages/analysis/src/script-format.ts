export function sanitizeScriptId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/gu, "_");
}

export function formatHostDialogue(text: string): string {
  return text.replace(/\s+/gu, "").trim();
}

export function buildOfficialScript(segments: readonly { readonly id: string; readonly text: string }[]): string {
  const blocks: string[] = [];
  let index = 0;
  for (const segment of segments) {
    const body = formatHostDialogue(segment.text);
    if (body.length === 0) continue;
    const tagId = sanitizeScriptId(segment.id);
    const host = index === 0 ? body : `@${tagId} ${body} @/${tagId}`;
    // Role cues are bare tags; `</HOST>` is parsed as a Segment close and fails check.
    blocks.push(`    <${tagId}>\n      <HOST>${host}\n    </${tagId}>`);
    index += 1;
  }
  if (blocks.length === 0) {
    return `    <main>\n      <HOST>\n    </main>`;
  }
  return blocks.join("\n");
}
