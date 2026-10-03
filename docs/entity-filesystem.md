# Campaign Knowledge Store

Mutable campaign knowledge lives in `knowledge.sqlite`, accessed through an injected `CampaignKnowledgeStore`. Agents use `knowledge` for inspection and `remember` for atomic updates. Markdown remains a rendering format for specialized sheets and an unchanged authoring format in source seeds; it is not the campaign entity persistence format.

## Tree and identity

The tree has organizational collections, narrative entities, and typed value nodes. Collections may nest arbitrarily and may be empty. Characters, Locations, Factions, Items and Lore are useful initial collections, not a closed category schema. Additional collections can hold spells, quests, timelines, clues or encounter-specific records.

Each node has a stable short UID such as `k000a`. Object properties, ordered-list instances and repeated cards also have their own UIDs; display names and list positions are not identity. Nested values support strings, finite numbers, booleans, null, objects, ordered lists and explicit `{$ref:"UID or known handle"}` relationships. Bulk description text and append-only history sit beside typed fields.

Entity names and aliases resolve globally after Unicode, whitespace and case normalization. The owner deliberately accepts same-name conflation: name-only upsert reuses an existing identity even if it has moved collections. This prevents a fresh scribe knowing only an old nickname from creating a duplicate. Renaming uses an explicit patch, preserves old aliases and retains the UID. A name-only upsert resolving an old alias preserves the current canonical display name. Consolidation redirects the old UID, aliases and incoming references to the surviving identity.

Collections are organizational: use their UID or exact path (`Spells/Arcane`) when names repeat beneath different parents. Handles may display as `@k000a`; both forms resolve. No identity ambiguity is escalated into an extra DM turn.

## Writes, references and consequences

Every operation batch runs in one serialized SQLite transaction. Typed state, explicit edges, history, aliases, canonical result identities and a durable pending notice commit together. A failed late operation rolls back earlier operations in the batch. Optional operation IDs make crash retries idempotent and reject reuse with a different payload.

Object patches merge recursively; replacing a list is explicit. `create_node`, `set_value` and `move` address ordered instances directly. Field removal is explicit in the generic API; typed null is meaningful data. Dependencies target any node, including scalar leaves. Changes to a node, ancestor or subtree produce candidate dependent identities, following at most two reverse graph edges with cycle-safe deduplication. Updating a dependent in the same batch does not prove its consequence was handled; notices remain until acknowledged. These are candidate notifications, never inferred narrative outcomes.

Relationships are structural `{$ref:...}` values or explicit labeled edges. SQLite foreign keys reject dangling targets and deletion of referenced nodes. Text mentions and log metadata do not create edges. Consolidation rehomes missing fields with their descendant UIDs and rewires canonical identity references. Existing winner fields prevail; a conflicting losing field with an incoming leaf reference is rejected atomically with an instruction to reconcile or move it first. Moving a value between owners transfers its indexed source ownership.

## Bounded inspection and scene context

`outline()` includes every UID, parent, kind, position and collection note. `snapshot()` renders the complete compact identity tree, including empty collections and ordered instances. It summarizes bulk strings and records text/history lengths rather than dumping full descriptions into the DM prefix.

`read()` pages body/leaf text, children/typed object fields and history entries. Long history bodies have independent per-entry text offsets. Lengths and continuation offsets let callers retrieve the entire text. Wide nested objects/lists and long strings return UID descriptors; read those nodes to obtain their content. The exact response shapes `{$text:UID,length:n}`, `{$list:UID,length:n}` and `{$object:UID,length:n}` are reserved and cannot be authored back as state. Other ordinary object keys remain available. History metadata is inert typed JSON limited to 4096 serialized characters; bulk history belongs in the log body.

A fresh full outline is available to DM tools. The DM context uses one frozen knowledge snapshot per scene, persisted in `state/scene.json`; reopening a scene reuses it. Mutation notices provide terse canonical identity and dependency feedback between scene boundaries.

Player-facing sheets and the Player Knowledge projection must contain only disclosed information. The public projection has its own records and UID references to canonical private identities; a private source record must never be published wholesale. The specialized `EntityStore` facade renders sheets for existing mechanics/viewers without reading or writing entity Markdown files.

## Storage and lifecycle

The production FileIO owns one store per canonical campaign root. Missing provider injection fails closed; isolated test doubles may use an in-memory provider. The built-in Node SQLite driver uses DELETE journaling and synchronous EXTRA. Committed database bytes are self-contained; no WAL sidecars need to enter Git or archives.

`withSnapshot()` drains the same mutation lane and closes the database while bytes are captured or restored. Git staging holds this boundary through actual staging. Rollback validates target config and database before reset, then closes/reopens the restored database. Archive holds the boundary through ZIP verification and source removal; backup reopens the surviving database. Read-only offline inspectors validate without writable pragmas or creating files.

Campaign format version 2 is mandatory. Unversioned, version 1, future-version and missing/unsupported database saves are rejected before providers, repair, startup writes or archive extraction. There is no Markdown-save migration. Open old campaigns in the release that created them or start a new campaign.

## Unchanged boundaries

Machine-scoped player profiles, source `.mvworld`/DM-seed formats and parsers, rules, maps, clocks, combat, mechanical decks, objectives, conversation, resources, transcripts, recaps, configuration and UI state retain their existing storage formats. Portrait/media files may still live in category directories. Source world entity titles/front matter/bodies materialize into SQLite; authored `additional_names` become aliases and exact known `[[Name]]` metadata declarations become explicit graph edges. Unknown links and arbitrary prose remain literal text.
