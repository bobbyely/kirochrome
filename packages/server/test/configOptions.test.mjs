import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseConfigOptions } from "../dist/configOptions.js";

describe("normaliseConfigOptions", () => {
  it("passes modern configOptions through", () => {
    const options = normaliseConfigOptions({
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a", options: [] }],
    });
    assert.deepEqual(options.map((o) => o.id), ["model"]);
  });

  it("converts the legacy modes state into an option", () => {
    const options = normaliseConfigOptions({
      modes: { currentModeId: "ask", availableModes: [{ id: "code", name: "Code" }, { id: "ask", name: "Ask" }] },
    });
    const mode = options.find((o) => o.id === "mode");
    assert.equal(mode.currentValue, "ask");
    assert.deepEqual(mode.options.map((o) => o.value), ["code", "ask"]);
  });

  it("merges both dialects rather than letting one hide the other", () => {
    // Agents mid-migration emit both, and not always with the same settings in
    // each — this exact case lost the mode picker before it was fixed.
    const options = normaliseConfigOptions({
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a", options: [] }],
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] },
    });
    assert.deepEqual(options.map((o) => o.id).sort(), ["mode", "model"]);
  });

  it("does not duplicate an option present in both dialects", () => {
    const options = normaliseConfigOptions({
      configOptions: [{ id: "mode", name: "Mode", type: "select", currentValue: "code", options: [] }],
      modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
    });
    assert.equal(options.filter((o) => o.id === "mode").length, 1);
    assert.equal(options[0].currentValue, "code", "the modern dialect wins");
  });

  it("makes a readable label from an id when the agent sends no name", () => {
    // Kiro advertises agents as modes with ids like these, often unnamed.
    const options = normaliseConfigOptions({
      modes: {
        currentModeId: "kiro_default",
        availableModes: [{ id: "kiro_default" }, { id: "kirocrew-conductor" }],
      },
    });
    assert.deepEqual(options[0].options.map((o) => o.name), ["Kiro Default", "Kirocrew Conductor"]);
    assert.deepEqual(options[0].options.map((o) => o.value), ["kiro_default", "kirocrew-conductor"]);
  });

  it("returns nothing when the agent advertises nothing", () => {
    assert.deepEqual(normaliseConfigOptions({}), []);
    assert.deepEqual(normaliseConfigOptions({ configOptions: [] }), []);
  });
});
