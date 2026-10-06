import type { SystemBlock } from "../../providers/types.js";

/** Replace complete earned responsibility paragraphs, never adjacent fiction. */
function replaceParagraph(text: string, start: string, replacement: string): string {
  return text.split(/(\r?\n\r?\n)/).map(paragraph =>
    paragraph.startsWith(start) ? replacement : paragraph).join("");
}

/** Migrate only bookkeeping paragraphs in the already-resolved effective prompt.
 * Identity, player agency, model conditionals, seed/personality overrides, and
 * every scene-image paragraph retain their existing bytes. */
export function migrateForegroundPrompt(blocks: SystemBlock[]): SystemBlock[] {
  const migrated = blocks.map(block => {
    let text = replaceParagraph(block.text, "Use `scribe` to record narrative state changes",
      "A continuing co-DM observes complete exchanges and authoritative tool results, including dm_notes. It maintains canonical campaign memory without a handoff tool. Within your ordinary assistant prose, embed <co_dm>private annotation</co_dm> only for hidden intent, canonical identity binds, visibility, corrections, or staging requests that observation cannot supply. These blocks remain private and do not require another tool round. Do not annotate facts already apparent in the exchange.");
    text = replaceParagraph(text, "Use known UIDs for recurring",
      "Use known UIDs for identity binds in private co-DM annotations; otherwise retain established names and aliases. When you need current facts, inspect with knowledge; the engine waits for prior completed observations on that dependent read. remember remains your explicit atomic correction tool. Dependency notices identify candidates for your interpretation, never predetermined deaths or quest failures.");
    text = replaceParagraph(text, "When `update_portrait` is in your toolset",
      "The co-DM silently maintains lasting PC portrait changes from your established fiction. You retain every scene image and its prompt; narrate appearance changes naturally.");
    text = text.replace("also scribe a `private` `player` update appending", "also include a private co-DM annotation requesting an append-only factual player-profile update appending")
    .replace("recording changes via scribe", "independent resource updates")
    .replace("Use `scribe` freely to spin out characters, locations, and lore as they occur to you — you can always use them later.", "Establish characters, locations and lore as they occur to you; the continuing co-DM records established facts. Stage unrevealed ideas through private annotations when useful.");
    return { ...block, text };
  });
  if (migrated.length) migrated[0].text += "\n<co_dm_ownership>Run fiction, immediate mechanics, private notes, and all scene images yourself. The co-DM maintains routine themes, modelines, resources and portraits. You may still set expressive modelines and resource keys; newer foreground intent takes precedence. Co-DM feedback is volatile advice with no reply obligation. Any inherited scribe handoff guidance describes the co-DM's responsibility: communicate hidden intent with private inline annotations, never call a missing scribe tool. Startup directives are engine instructions, never player speech; proposed seed openings are possibilities until you establish them in fiction.</co_dm_ownership>";
  return migrated;
}
