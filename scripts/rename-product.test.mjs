// Unit tests for scripts/rename-product.mjs (ADR-0127). Run: pnpm test:scripts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { rename, scopeOf } from "./rename-product.mjs";

const OLD = "Harbour";
const swap = (text, scope = "whole") => rename(text, scope).text;

describe("rename-product", () => {
  it("renames the product where people read it, possessives and sentence ends included", () => {
    assert.equal(swap(`Open ${OLD} to see it.`), "Open Thapsus Care to see it.");
    assert.equal(swap(`${OLD}'s target`), "Thapsus Care's target");
    assert.equal(swap(`in ${OLD}: done`), "in Thapsus Care: done");
  });

  it("renames inside a regular expression but not in a host, address or path", () => {
    assert.equal(swap(`toMatch(/${OLD} sets this/)`, "code"), "toMatch(/Thapsus Care sets this/)");
    for (const kept of [
      `HTTPS://Family.${OLD}.Example`,
      `no-reply@${OLD}.example`,
      `-//Thapsus Cargo Ltd//${OLD}//EN`,
      `ios/${OLD}.xcworkspace`,
    ]) {
      assert.equal(swap(kept, "code"), kept);
    }
  });

  it("keeps the invented demo names, comments and identifiers", () => {
    for (const kept of [
      `${OLD} House`,
      `${OLD} Demo Care`,
      `${OLD} Care Ltd`,
      `${OLD} Care Example Ltd`,
      `${OLD} Example Care and Support Services`,
      "@harbour/api HARBOUR_SEED_DEMO harbour_app",
    ]) {
      assert.equal(swap(kept, "code"), kept);
    }
    assert.equal(swap(`  // ${OLD} never sends it`, "code"), `  // ${OLD} never sends it`);
  });

  it("leaves frozen history, generated files and the stored-row test out of scope", () => {
    assert.equal(scopeOf("docs/decisions/0127-product-name-thapsus-care.md"), null);
    assert.equal(scopeOf("docs/changelog-dev/2026-11-07-x.md"), null);
    assert.equal(scopeOf("packages/db/drizzle/0081_quality_audit_programme.sql"), null);
    assert.equal(scopeOf("packages/contracts/src/client/api-types.ts"), null);
    assert.equal(scopeOf("packages/db/test/product-name-stored-rows.test.ts"), null);
    assert.equal(scopeOf("packages/i18n/src/messages/en-GB.json"), "whole");
    assert.equal(scopeOf("apps/api/src/app.ts"), "code");
  });

  it("finds no in-scope use of the old name in the tree (--check)", () => {
    const out = execFileSync("node", ["scripts/rename-product.mjs", "--check"], {
      encoding: "utf8",
    });
    assert.match(out, /No in-scope "Harbour" left\./);
  });
});
