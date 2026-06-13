// Guards the CLI's section wiring. The analyze->overview / diagnose->timeline
// rename and gear.audit->gear.run unification all broke cli.mjs silently because
// nothing imported it. cli.mjs now exposes its wiring as pure data
// (SECTION_SPECS) so this test can resolve every (module, method) it invokes --
// turning "renamed a module / export out from under the CLI" into a red test.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
globalThis.fetch = async () => { throw new Error("cli wiring test must not hit the network"); };

const { SECTION_SPECS, loadSectionModule } = await import("../cli.mjs");

test("every CLI section resolves to a real run() entry point", async () => {
  assert.ok(SECTION_SPECS.length, "SECTION_SPECS should not be empty");
  for (const spec of SECTION_SPECS) {
    const mod = await loadSectionModule(spec); // throws if the module path is stale
    assert.equal(
      typeof mod[spec.method], "function",
      `section "${spec.key}" -> ${spec.module}#${spec.method} is not a function`,
    );
  }
});

test("CLI entry points are uniformly run()", () => {
  // The whole point of the audit->run unification: no per-module special case.
  for (const spec of SECTION_SPECS) {
    assert.equal(spec.method, "run", `section "${spec.key}" should call run(), not ${spec.method}()`);
  }
});

test("section keys are unique and each builds an argument array", () => {
  const keys = SECTION_SPECS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate section key");
  const p = { name: "X", server: "y", region: "US", cls: "Monk", spec: "Brewmaster", difficulty: 5, priority: "crit" };
  for (const spec of SECTION_SPECS) {
    assert.ok(Array.isArray(spec.args(p)), `section "${spec.key}" args() must return an array`);
  }
});
