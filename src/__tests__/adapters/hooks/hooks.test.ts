import { describe, it, expect } from "vitest";
import { createHookFile, readHookEvents, removeHookFile } from "../../../adapters/hooks/endpoint.js";
import * as fs from "node:fs";

describe("hooks/endpoint", () => {
  it("creates and cleans up hook file", () => {
    const file = createHookFile("step-1");
    expect(fs.existsSync(file)).toBe(true);

    const events = readHookEvents(file);
    expect(events).toEqual([]);

    removeHookFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});
