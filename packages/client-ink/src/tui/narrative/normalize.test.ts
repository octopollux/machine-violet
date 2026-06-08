import { normalizeDialect } from "./normalize.js";

describe("normalizeDialect", () => {
  it("passes plain prose through untouched (fast path)", () => {
    expect(normalizeDialect("The door creaks open.")).toBe("The door creaks open.");
    expect(normalizeDialect("")).toBe("");
  });

  it("is idempotent on already-canonical markup", () => {
    const canon = "<b>Bold</b> and <color=#ff0000>red</color> and <i>flavor</i>";
    expect(normalizeDialect(canon)).toBe(canon);
  });

  describe("HTML synonyms → canonical tags", () => {
    it("maps semantic emphasis tags", () => {
      expect(normalizeDialect("<strong>loud</strong>")).toBe("<b>loud</b>");
      expect(normalizeDialect("<em>soft</em>")).toBe("<i>soft</i>");
    });

    it("strips attributes from known tags", () => {
      expect(normalizeDialect(`<b class="x">hi</b>`)).toBe("<b>hi</b>");
      expect(normalizeDialect(`<center style="color:red">SIGN</center>`)).toBe("<center>SIGN</center>");
      expect(normalizeDialect(`<i data-k="v">y</i>`)).toBe("<i>y</i>");
    });

    it("canonicalizes <br>, <br/>, <br /> to <br>", () => {
      expect(normalizeDialect("a<br>b<br/>c<br />d")).toBe("a<br>b<br>c<br>d");
    });

    it("maps headings (markdown and HTML) to bold", () => {
      expect(normalizeDialect("## The Vault")).toBe("<b>The Vault</b>");
      expect(normalizeDialect("# Title #")).toBe("<b>Title</b>");
      expect(normalizeDialect("<h2>Chapter</h2>")).toBe("<b>Chapter</b>");
    });

    it("drops strikethrough tags but keeps content (no primitive)", () => {
      expect(normalizeDialect("<s>gone</s>")).toBe("gone");
      expect(normalizeDialect("<del>removed</del>")).toBe("removed");
    });

    it("tolerates quoted/spaced color forms", () => {
      expect(normalizeDialect(`<color="#abc">x</color>`)).toBe("<color=#abc>x</color>");
      expect(normalizeDialect(`<color = #ABCDEF >x</color>`)).toBe("<color=#ABCDEF>x</color>");
    });
  });

  describe("inline markdown", () => {
    it("converts **bold** and *italic*", () => {
      expect(normalizeDialect("**loud** and *soft*")).toBe("<b>loud</b> and <i>soft</i>");
    });

    it("converts _italic_ but leaves snake_case alone", () => {
      expect(normalizeDialect("_whispered_")).toBe("<i>whispered</i>");
      expect(normalizeDialect("the field_notes_id var")).toBe("the field_notes_id var");
    });

    it("does not mangle arithmetic asterisks", () => {
      expect(normalizeDialect("3 * 4 = 12")).toBe("3 * 4 = 12");
    });

    it("strips markdown links to their text and drops images", () => {
      expect(normalizeDialect("see [the map](x/y.md) now")).toBe("see the map now");
      expect(normalizeDialect("![alt](pic.png)done")).toBe("done");
    });
  });

  describe("inline code protection", () => {
    it("protects markup inside backtick code spans", () => {
      expect(normalizeDialect("run `<b>npm</b> **test**` now"))
        .toBe("run <code><b>npm</b> **test**</code> now");
    });

    it("normalizes <code> and leaves its content verbatim", () => {
      expect(normalizeDialect("<code>a *b* c</code>")).toBe("<code>a *b* c</code>");
    });
  });

  it("handles a full diegetic-sign line end to end", () => {
    expect(normalizeDialect("<CENTER><strong>STOP</strong><br/>**proceed**</CENTER>"))
      .toBe("<center><b>STOP</b><br><b>proceed</b></center>");
  });
});
