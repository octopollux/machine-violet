import { describe, it, expect } from "vitest";
import { parseResolutionXml } from "./resolve-xml.js";

describe("parseResolutionXml", () => {
  it("parses a well-formed paladin turn", () => {
    const text = `I'll resolve Kael's attack with Divine Smite.

<resolution>
  <narrative>Kael's longsword strikes true, divine energy blazing along the blade.</narrative>
  <rolls>
    <roll expr="1d20+7" reason="Attack roll" result="23" detail="[16]+7=23"/>
    <roll expr="2d6+4" reason="Longsword damage" result="13" detail="[5,4]+4=13"/>
    <roll expr="2d8" reason="Divine Smite (2nd level)" result="11" detail="[6,5]=11"/>
  </rolls>
  <deltas>
    <delta type="hp_change" target="dragon" resource="HP" amount="-24" damage_type="slashing+radiant"/>
    <delta type="resource_spend" target="Kael" resource="spell_slots_2nd" spent="1" remaining="2"/>
  </deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe(
      "Kael's longsword strikes true, divine energy blazing along the blade.",
    );

    expect(result!.rolls).toHaveLength(3);
    expect(result!.rolls[0]).toEqual({
      expression: "1d20+7",
      reason: "Attack roll",
      result: 23,
      detail: "[16]+7=23",
    });
    expect(result!.rolls[1].reason).toBe("Longsword damage");
    expect(result!.rolls[2].result).toBe(11);

    expect(result!.deltas).toHaveLength(2);
    expect(result!.deltas[0]).toEqual({
      type: "hp_change",
      target: "dragon",
      details: { resource: "HP", amount: -24, damage_type: "slashing+radiant" },
    });
    expect(result!.deltas[1]).toEqual({
      type: "resource_spend",
      target: "Kael",
      details: { resource: "spell_slots_2nd", spent: 1, remaining: 2 },
    });
  });

  it("returns null when no resolution block found", () => {
    const text = "The goblin attacks with its scimitar and hits for 7 damage.";
    expect(parseResolutionXml(text)).toBeNull();
  });

  it("handles missing narrative gracefully", () => {
    const text = `<resolution>
  <rolls>
    <roll expr="1d20+3" reason="Attack" result="15" detail="[12]+3=15"/>
  </rolls>
  <deltas>
    <delta type="hp_change" target="goblin" amount="-5"/>
  </deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe("");
    expect(result!.rolls).toHaveLength(1);
    expect(result!.deltas).toHaveLength(1);
  });

  it("handles empty rolls and deltas", () => {
    const text = `<resolution>
  <narrative>Nothing happens.</narrative>
  <rolls></rolls>
  <deltas></deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe("Nothing happens.");
    expect(result!.rolls).toHaveLength(0);
    expect(result!.deltas).toHaveLength(0);
  });

  it("skips deltas with missing type or target", () => {
    const text = `<resolution>
  <narrative>Partial data.</narrative>
  <rolls></rolls>
  <deltas>
    <delta type="hp_change" amount="-5"/>
    <delta target="goblin" amount="-5"/>
    <delta type="hp_change" target="goblin" amount="-5"/>
  </deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    // Only the third delta has both type and target
    expect(result!.deltas).toHaveLength(1);
    expect(result!.deltas[0].target).toBe("goblin");
  });

  it("parses condition_add and condition_remove deltas", () => {
    const text = `<resolution>
  <narrative>The spell takes hold.</narrative>
  <rolls></rolls>
  <deltas>
    <delta type="condition_add" target="goblin" condition="frightened" duration="1 minute" source="Kael"/>
    <delta type="condition_remove" target="Kael" condition="poisoned"/>
  </deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.deltas).toHaveLength(2);
    expect(result!.deltas[0].details).toEqual({
      condition: "frightened",
      duration: "1 minute",
      source: "Kael",
    });
    expect(result!.deltas[1].details).toEqual({
      condition: "poisoned",
    });
  });

  it("parses position_change deltas", () => {
    const text = `<resolution>
  <narrative>Kael dashes forward.</narrative>
  <rolls></rolls>
  <deltas>
    <delta type="position_change" target="Kael" from="E4" to="E6"/>
  </deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.deltas[0].details).toEqual({ from: "E4", to: "E6" });
  });

  it("handles self-closing roll tags", () => {
    const text = `<resolution>
  <narrative>Hit.</narrative>
  <rolls>
    <roll expr="1d20+5" reason="Attack" result="18" detail="[13]+5=18" />
  </rolls>
  <deltas></deltas>
</resolution>`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.rolls).toHaveLength(1);
    expect(result!.rolls[0].result).toBe(18);
  });

  it("extracts resolution block from text with surrounding content", () => {
    const text = `Let me resolve this attack step by step.

First, I need to check the attack modifier from the character sheet.

The attack roll is 1d20+5.

<resolution>
  <narrative>The arrow flies wide.</narrative>
  <rolls>
    <roll expr="1d20+5" reason="Longbow attack" result="8" detail="[3]+5=8"/>
  </rolls>
  <deltas></deltas>
</resolution>

That concludes the turn.`;

    const result = parseResolutionXml(text);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe("The arrow flies wide.");
    expect(result!.rolls[0].result).toBe(8);
  });
});
