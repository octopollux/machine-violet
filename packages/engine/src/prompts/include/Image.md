<Image>
When composing prompts for `generate_image`, render the image in this visual style:

`a GPU-rendered Japanese MMO (in photo mode, no nameplates or HUD), with a caption overlaid in a tasteful font.`

%% Append this style descriptor at the END of every prompt, after the scene/subject description — `gpt-image-2` adheres better when style guidance comes last. Describe the subject, composition, lighting, and mood first; close with the style line verbatim.
</Image>

<PaperbackCover>
When composing prompts for `generate_image`, render the image in this visual style:

`Painted as a vintage 1970s science-fiction paperback cover in the tradition of hand-airbrushed gouache matte painting, with strict process discipline. Work from a tightly restrained palette of roughly four or five muted period hues only — admit no other colors. Build the whole image from a few large, simple value masses: group shadow into broad unmodulated dark shapes, and let most of the subject dissolve into soft atmospheric falloff and lost-and-found edges. Reserve fine brushwork and detail for ONE focal element and the lit silhouette edges only; every other surface stays broad, flat, soft, and economical, with no rendered panel or surface detail. Keep large passages of the background calm and near-empty — resist filling negative space. The only fine texture anywhere is the flat, uniform offset-printing rosette grain and paper tooth laid evenly over the finished painting, never rendered surface detail. Close with a cover-style caption integrated like real paperback typography: a bold engraved-serif title treatment naming the place or moment, with one short evocative tagline beneath it, set in elegant period type.`

%% Append this style descriptor at the END of every prompt, after the scene/subject description — `gpt-image-2` adheres better when style guidance comes last. Describe the subject, composition, lighting, and mood first; close with the style line verbatim. The economy directives (limited palette, large flat value masses, lost edges, detail reserved to one focal element, near-empty negative space, grain only from the print process) are load-bearing — they are what keep gpt-image-2 from crowding every surface with reflexive "bored-model" detail. Don't trim them.
</PaperbackCover>

<PracticalMiniature>
When composing prompts for `generate_image`, render the image in this visual style:

`Photographed as a practical motion-control miniature model from a pre-CGI late-1970s science-fiction film, shot on a large physical model with an anamorphic lens. Strict process discipline: the subject is a real built object — matte-painted model surfaces with restrained weathering, panel lines or sculpted texture, and a few sharp greebles concentrated ONLY on the focal section; broad areas of the surface stay clean, simple, and unmodulated. Light it with one hard key from a single direction, deep falloff into black; let smoke, haze, and atmospheric depth fill the negative space instead of detail. Shallow depth of field — only the focal subject is crisp, everything else softens. Fine 35mm film grain, gentle anamorphic flare and bloom on the single brightest light, slight gate weave. Keep large passages of the frame dark and near-empty — resist filling them. Close with a film-still caption: a single line of subtitle text in a clean lower-third, as if burned into the print.`

%% Append this style descriptor at the END of every prompt, after the scene/subject description — `gpt-image-2` adheres better when style guidance comes last. Describe the subject, composition, lighting, and mood first; close with the style line verbatim. The economy directives (restrained weathering concentrated on one focal section, broad clean surfaces, single hard key with deep falloff, smoke/haze filling negative space, shallow depth of field, large dark near-empty passages) are load-bearing — they keep gpt-image-2 from greebling every surface. The shallow depth of field and single-key falloff also flatter a referenced character dropped into the frame: a figure rendered from behind or in soft focus reads as a real actor on the model stage, not a pasted-in portrait. Don't trim them.
</PracticalMiniature>

<IntaglioVignette>
When composing prompts for `generate_image`, render the image in this visual style:

`Rendered as a small steel-plate intaglio VIGNETTE engraving in the banknote tradition, printed in a single dark ink and floating in a large field of bare, unprinted cream paper. Strict process discipline: the engraved image is a vignette — it occupies only a modest central area and FADES OUT softly into blank paper at every edge; at least half of the whole sheet stays bare unengraved cream paper with nothing on it at all. Work mostly in clean, sparse, confident burin contour lines; reserve actual cross-hatching for a SINGLE small focal element and a few shadow accents; render everything else as open outline or leave it as bare paper. The sky and background are blank paper — at most a handful of tiny engraved star-dots, never stippled tone, never a filled field. High-key overall: the light IS the bare paper, and line appears only where shadow truly falls. No solid black fills, no edge-to-edge texture, no engraved border touching the paper's edges. Faint plate tone only at the vignette's heart. Close with an engraved caption beneath the vignette: a short title in elegant serif small-caps on bare paper, as if lettered into the plate.`

%% Append this style descriptor at the END of every prompt, after the scene/subject description — `gpt-image-2` adheres better when style guidance comes last. Describe the subject, composition, lighting, and mood first; close with the style line verbatim. Engraving is the hard case: dense burin line is the medium's DEFAULT, so merely asking for "less detail" fails — gpt-image-2 will hatch every surface (the textbook tic). The load-bearing fix is STRUCTURAL: it is a *vignette* that fades into blank paper, at least half the sheet stays bare, and the sky is unprinted paper, not stippled tone. Those clauses are what give the model a reason to stop. Don't trim them or let the image fill the rectangle edge-to-edge.
</IntaglioVignette>

<!--
  Named variants go here as additional top-level sections, e.g.

  <IlluminatedManuscript>
    ... full Image guidance with a different visual-style line ...
    **EVERY IMAGE STYLE MUST DECLARE A CAPTION/CAPTION STYLE**
  </IlluminatedManuscript>

  A campaign seed selects one with `<!--include:Image.IlluminatedManuscript-->`,
  which produces an `<Image>` block (outer tag is always the file stem; the
  variant only picks which section is rendered).

  See ./README.md and ../process-includes.ts for the full spec.

  ALL variants must be human-eyeballed against gpt-image-2 before landing —
  the model is temperamental and defaults look terrible. Don't add a variant
  without a sample image to back it up.
-->
