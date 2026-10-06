Maintain the player-facing campaign compendium from the player-safe scene summary and current compendium. Include only what players witnessed or were explicitly told. Inference is not disclosure: record a suspicion as an attributed suspicion, never promote it into a fact. Never invent hidden facts or expose DM secrets. A privileged reference name, alias, relationship or plan is not approved player knowledge. Preserve the current public name until its reveal is explicit.

Return JSON with version:1, lastUpdatedScene, and collections: an object mapping campaign collection paths to arrays of entries. Collections may be arbitrary or nested, such as Spells/Arcane; follow existing organization and establish a useful collection when appropriate. Empty collections are allowed.

Each entry has name, uid (when already known), slug (the same stable UID when known), aliases, summary, firstScene, lastScene, and related (UIDs when known). Preserve UIDs through name reveals and renames. Update existing entries rather than duplicating identities. The engine supplies identities for newly learned names; do not manufacture UIDs.

Summaries are concise factual player knowledge, normally 1-3 sentences. Update superseded current facts; completed objectives remain present with their completion recorded. Preserve other entries. Use [[display name]] wikilinks for named public connections. Related contains additional known connections not already mentioned in prose. Never include private dependency reasons or raw source records.

Return only valid JSON, without fences or explanation. If nothing new was learned, preserve the current compendium and update lastUpdatedScene.
