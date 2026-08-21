import { describe, it, expect } from "vitest";
import {
  classifyComplexity,
  readRepoState,
  COMPLEX_CHANGED_FILES,
} from "../../../application/agents/complexity.js";
import type { Exec } from "../../../application/agents/complexity.js";

const fakeExec = (stdout: string, code = 0): Exec => async () => ({ stdout, code });

describe("agents/complexity", () => {
  describe("readRepoState", () => {
    it("counts modified files from porcelain output", async () => {
      const exec = fakeExec(" M src/a.ts\n?? new-file.ts\nA  src/b.ts\n");
      const state = await readRepoState("/proj", exec);
      expect(state).toEqual({ changedFiles: 3 });
    });

    it("counts a single line", async () => {
      const state = await readRepoState("/proj", fakeExec(" M src/a.ts\n"));
      expect(state).toEqual({ changedFiles: 1 });
    });

    it("returns zero for an empty diff", async () => {
      const state = await readRepoState("/proj", fakeExec(""));
      expect(state).toEqual({ changedFiles: 0 });
    });

    it("treats whitespace-only porcelain lines as no change", async () => {
      const state = await readRepoState("/proj", fakeExec(" M src/a.ts\n\n"));
      expect(state).toEqual({ changedFiles: 1 });
    });

    it("returns undefined when git exits non-zero", async () => {
      const state = await readRepoState("/proj", fakeExec("", 128));
      expect(state).toBeUndefined();
    });

    it("returns undefined when the exec rejects", async () => {
      const exec: Exec = async () => {
        throw new Error("boom");
      };
      const state = await readRepoState("/proj", exec);
      expect(state).toBeUndefined();
    });
  });

  describe("classifyComplexity", () => {
    it("routes complex when no repo state is available (never under-provision)", () => {
      expect(classifyComplexity("add login", undefined)).toBe("complex");
    });

    it("routes simple for a small diff", () => {
      expect(classifyComplexity("add login", { changedFiles: 1 })).toBe("simple");
    });

    it("is inclusive at the boundary: exactly COMPLEX_CHANGED_FILES is complex", () => {
      expect(classifyComplexity("x", { changedFiles: COMPLEX_CHANGED_FILES })).toBe("complex");
      expect(classifyComplexity("x", { changedFiles: COMPLEX_CHANGED_FILES - 1 })).toBe("simple");
    });

    it("routes complex above the threshold", () => {
      expect(classifyComplexity("x", { changedFiles: COMPLEX_CHANGED_FILES + 1 })).toBe("complex");
    });

    it("routes simple for zero changed files", () => {
      expect(classifyComplexity("x", { changedFiles: 0 })).toBe("simple");
    });

    it("routes on repo state regardless of task text", () => {
      expect(classifyComplexity("", { changedFiles: 1 })).toBe("simple");
      expect(classifyComplexity("anything at all", { changedFiles: 100 })).toBe("complex");
    });

    it("produces both routing outcomes across the input space", () => {
      const simple = [0, 1, 7].map(n => classifyComplexity("t", { changedFiles: n }));
      const complex = [8, 9, 20].map(n => classifyComplexity("t", { changedFiles: n }));
      expect(simple.every(o => o === "simple")).toBe(true);
      expect(complex.every(o => o === "complex")).toBe(true);
    });
  });
});