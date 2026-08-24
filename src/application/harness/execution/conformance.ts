import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../../core/log.js";

export interface ConformanceCheckOptions {
  projectDir?: string;
  contractArtifact?: string;
  codeFiles?: string[];
  testFiles?: string[];
  contractSymbols?: string[];
}

export interface MismatchDetail {
  symbol: string;
  expectedIn: "contract" | "code" | "test";
  actualStatus: "missing" | "signature_mismatch" | "extra_unspecified";
  message: string;
  deviatingSide: "code" | "test" | "both";
}

export interface ConformanceResult {
  matched: boolean;
  mismatches: MismatchDetail[];
  deviatingProducer: "code" | "test" | "both" | "none";
  repairFeedback?: string;
  summary: string;
}

export class ConformanceChecker {
  /**
   * Deterministically compare code & test artifacts against an architecture contract (ADR-013).
   * Verifies exported signatures and references without heuristic/LLM hallucination.
   */
  static checkArtifactConformance(options: ConformanceCheckOptions): ConformanceResult {
    const root = options.projectDir ?? process.cwd();
    const mismatches: MismatchDetail[] = [];

    // 1. Extract contract symbols
    const contractSymbols = new Set<string>(options.contractSymbols ?? []);
    if (options.contractArtifact) {
      const contractPath = join(root, options.contractArtifact);
      if (existsSync(contractPath)) {
        const content = readFileSync(contractPath, "utf-8");
        const extracted = ConformanceChecker.extractContractSymbols(content);
        for (const s of extracted) contractSymbols.add(s);
      }
    }

    // 2. Extract code exports
    const codeExports = new Set<string>();
    for (const relPath of options.codeFiles ?? []) {
      const fullPath = join(root, relPath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        const exports = ConformanceChecker.extractCodeExports(content);
        for (const e of exports) codeExports.add(e);
      }
    }

    // 3. Extract test imports / references
    const testImports = new Set<string>();
    for (const relPath of options.testFiles ?? []) {
      const fullPath = join(root, relPath);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        const imports = ConformanceChecker.extractTestReferences(content);
        for (const i of imports) testImports.add(i);
      }
    }

    // Check A: If contract defines symbols, verify code exports them
    if (contractSymbols.size > 0) {
      for (const expected of contractSymbols) {
        if (!codeExports.has(expected)) {
          mismatches.push({
            symbol: expected,
            expectedIn: "code",
            actualStatus: "missing",
            message: `Code artifact fails to export required contract symbol '${expected}'.`,
            deviatingSide: "code",
          });
        }
      }
    }

    // Check B: Verify test references match code exports
    for (const ref of testImports) {
      // If test references a symbol expected from the contract but code didn't export it
      if (contractSymbols.has(ref) && !codeExports.has(ref)) {
        // Code is missing a contract-required export tested by test
        // Already recorded above or noted as code deviation
      } else if (!codeExports.has(ref) && codeExports.size > 0) {
        // Test references a symbol that neither contract nor code provides
        mismatches.push({
          symbol: ref,
          expectedIn: "test",
          actualStatus: "extra_unspecified",
          message: `Test artifact imports '${ref}' which is not exported by the code artifact.`,
          deviatingSide: "test",
        });
      }
    }

    // Check C: If code exported symbols required by contract, but tests never cover them
    if (codeExports.size > 0 && testImports.size > 0) {
      for (const sym of codeExports) {
        if (contractSymbols.has(sym) && !testImports.has(sym)) {
          mismatches.push({
            symbol: sym,
            expectedIn: "test",
            actualStatus: "missing",
            message: `Test artifact does not import or test contract symbol '${sym}' exported by code.`,
            deviatingSide: "test",
          });
        }
      }
    }

    const matched = mismatches.length === 0;
    const deviatingSides = new Set(mismatches.map(m => m.deviatingSide));
    const deviatingProducer: "code" | "test" | "both" | "none" =
      deviatingSides.has("code") && deviatingSides.has("test")
        ? "both"
        : deviatingSides.has("code")
        ? "code"
        : deviatingSides.has("test")
        ? "test"
        : "none";

    let repairFeedback: string | undefined;
    if (!matched) {
      const feedbackLines = [
        `=== CONFORMANCE CHECK FAILURE (ADR-013) ===`,
        `Deterministic structural mismatch detected between parallel artifacts and contract:`,
        ...mismatches.map(m => `- [${m.deviatingSide.toUpperCase()}] ${m.message}`),
        `\nContract is ground truth. Please repair the ${deviatingProducer} artifact to match the architecture contract.`,
      ];
      repairFeedback = feedbackLines.join("\n");
    }

    const summary = matched
      ? `Conformance check passed: ${codeExports.size} code exports and ${testImports.size} test references align with contract.`
      : `Conformance check failed: ${mismatches.length} mismatch(es) detected (deviating side: ${deviatingProducer}).`;

    return {
      matched,
      mismatches,
      deviatingProducer,
      repairFeedback,
      summary,
    };
  }

  static extractContractSymbols(content: string): string[] {
    const symbols = new Set<string>();
    // Match export declarations, interface names, type names, function names
    const typeMatches = content.matchAll(/(?:interface|type|class|function|export const|export function)\s+([A-Za-z0-9_$]+)/g);
    for (const m of typeMatches) {
      if (m[1]) symbols.add(m[1]);
    }
    // Match markdown code signatures e.g. `functionName(...)` or `ClassName`
    const mdMatches = content.matchAll(/`([A-Za-z0-9_$]+)(?:\(.*?\))?`/g);
    for (const m of mdMatches) {
      if (m[1] && m[1].length > 1 && !["true", "false", "null", "undefined", "string", "number", "boolean"].includes(m[1])) {
        symbols.add(m[1]);
      }
    }
    return Array.from(symbols);
  }

  static extractCodeExports(content: string): string[] {
    const exports = new Set<string>();
    const matches = content.matchAll(/export\s+(?:const|function|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g);
    for (const m of matches) {
      if (m[1]) exports.add(m[1]);
    }
    const namedExports = content.matchAll(/export\s*\{\s*([^}]+)\s*\}/g);
    for (const m of namedExports) {
      if (m[1]) {
        for (const item of m[1].split(",")) {
          const trimmed = item.trim().split(/\s+as\s+/)[0]?.trim();
          if (trimmed) exports.add(trimmed);
        }
      }
    }
    return Array.from(exports);
  }

  static extractTestReferences(content: string): string[] {
    const refs = new Set<string>();
    const importMatches = content.matchAll(/import\s*\{([^}]+)\}\s*from/g);
    for (const m of importMatches) {
      if (m[1]) {
        for (const item of m[1].split(",")) {
          const trimmed = item.trim().split(/\s+as\s+/)[0]?.trim();
          if (trimmed && trimmed !== "describe" && trimmed !== "it" && trimmed !== "expect" && trimmed !== "test") {
            refs.add(trimmed);
          }
        }
      }
    }
    return Array.from(refs);
  }
}
