<Image>
When composing prompts for `generate_image`, render the image in this visual style:

`a GPU-rendered Japanese MMO (in photo mode, no nameplates or HUD), with a caption overlaid in a tasteful font.`

%% Append this style descriptor at the END of every prompt, after the scene/subject description — `gpt-image-2` adheres better when style guidance comes last. Describe the subject, composition, lighting, and mood first; close with the style line verbatim.
</Image>

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
