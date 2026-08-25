// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard: every element ID required by `getDomRefs()` must exist in
 * index.html. Without this, the renderer IIFE throws at startup, no IPC
 * handlers register, and the GUI freezes at "Initializing...".
 *
 * Root cause reference: tab-chat and pty-tree were missing from index.html,
 * causing getDomRefs() to throw "missing #tab-chat element", crashing the
 * renderer before api.onStatus() could register.
 */

const root = resolve(import.meta.dirname, "..", "..", "..", "..");

function extractDomIds(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

function extractReqIds(ts: string): string[] {
  return [...ts.matchAll(/req\("([^"]+)"\)/g)].map((m) => m[1]);
}

describe("DOM ID coverage", () => {
  it("every getDomRefs() ID exists in index.html", () => {
    const htmlPath = resolve(root, "src/delivery/gui/index.html");
    const html = readFileSync(htmlPath, "utf8");
    const domIds = extractDomIds(html);

    const domRefsPath = resolve(root, "src/delivery/gui/dom-refs.ts");
    const domRefs = readFileSync(domRefsPath, "utf8");
    const requiredIds = extractReqIds(domRefs);

    const missing = requiredIds.filter((id) => !domIds.has(id));
    expect(missing).toEqual([]);
  });

  it("every getDomRefs() ID exists in test DOM (renderer-flow.test.ts)", () => {
    const testPath = resolve(root, "src/__tests__/delivery/gui/renderer-flow.test.ts");
    const testSrc = readFileSync(testPath, "utf8");

    // Find the DOM template literal between const DOM = ` ... `;
    const startMarker = "const DOM = `";
    const startIdx = testSrc.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const contentStart = startIdx + startMarker.length;
    const endIdx = testSrc.indexOf("`;", contentStart);
    expect(endIdx).toBeGreaterThan(contentStart);
    const domContent = testSrc.slice(contentStart, endIdx);

    const testDomIds = extractDomIds(domContent);

    const domRefsPath = resolve(root, "src/delivery/gui/dom-refs.ts");
    const domRefs = readFileSync(domRefsPath, "utf8");
    const requiredIds = extractReqIds(domRefs);

    const missing = requiredIds.filter((id) => !testDomIds.has(id));
    expect(missing).toEqual([]);
  });
});
