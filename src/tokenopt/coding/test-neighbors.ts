import fs from "node:fs";
import path from "node:path";
import type { TestNeighborPacket } from "../types.js";
import { collectCodingFiles, isTestPath, tokenizeQuery } from "./symbol-index.js";

export interface TestNeighborInput {
  repoRoot: string;
  target: string;
  symbolName?: string;
  limit?: number;
}

export function findTestNeighbors(input: TestNeighborInput): TestNeighborPacket {
  const files = collectCodingFiles(input.repoRoot);
  const testFiles = files.filter(isTestPath);
  const sourceFiles = findSourceFiles(files, input.target, input.symbolName).slice(0, 12);
  const queryTokens = buildNeighborTokens(input.target, input.symbolName, sourceFiles);
  const rankedTests = testFiles
    .map((file) => ({ file, score: scoreTestFile(file, queryTokens, sourceFiles) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, input.limit ?? 12)
    .map((entry) => entry.file);

  const frameworkHints = inferFrameworkHints(input.repoRoot, rankedTests);
  const mockingHints = inferMockingHints(input.repoRoot, rankedTests);
  const namingPatterns = inferNamingPatterns(sourceFiles, rankedTests, input.symbolName);

  return {
    target: input.target,
    source_files: sourceFiles,
    test_files: rankedTests,
    naming_patterns: namingPatterns,
    framework_hints: frameworkHints,
    mocking_hints: mockingHints,
    coverage: {
      source_target: sourceFiles.length > 0 ? "covered" : "missing",
      existing_test_neighbor: rankedTests.length > 0 ? "covered" : "missing",
      test_naming_pattern: namingPatterns.length > 0 ? "covered" : "partial",
      test_framework: frameworkHints.length > 0 ? "covered" : "partial",
      mocking_style: mockingHints.length > 0 ? "covered" : "partial"
    }
  };
}

function findSourceFiles(files: string[], target: string, symbolName?: string): string[] {
  const normalizedTarget = target.replace(/\\/g, "/");
  const targetTokens = new Set(buildNeighborTokens(target, symbolName, []));
  return files
    .filter((file) => !isTestPath(file))
    .map((file) => ({ file, score: scoreSourceFile(file, normalizedTarget, targetTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((entry) => entry.file);
}

function scoreSourceFile(file: string, target: string, targetTokens: Set<string>): number {
  const lower = file.toLowerCase();
  if (lower === target.toLowerCase()) {
    return 10;
  }
  if (lower.endsWith(`/${target.toLowerCase()}`) || lower.includes(target.toLowerCase())) {
    return 7;
  }
  const base = stripKnownSuffix(path.basename(file, path.extname(file))).toLowerCase();
  let score = 0;
  for (const token of targetTokens) {
    if (base.includes(token)) {
      score += 3;
    } else if (lower.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function buildNeighborTokens(target: string, symbolName: string | undefined, sourceFiles: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenizeQuery([target, symbolName, ...sourceFiles.map((file) => path.basename(file))].filter(Boolean).join(" "))) {
    tokens.add(stripKnownSuffix(token));
  }
  return tokens;
}

function scoreTestFile(testFile: string, queryTokens: Set<string>, sourceFiles: string[]): number {
  const lower = testFile.toLowerCase();
  const base = stripKnownSuffix(path.basename(testFile, path.extname(testFile))).toLowerCase();
  let score = 0;
  for (const source of sourceFiles) {
    const sourceBase = stripKnownSuffix(path.basename(source, path.extname(source))).toLowerCase();
    if (base.includes(sourceBase) || lower.includes(sourceBase)) {
      score += 8;
    }
    const sourceDir = path.dirname(source).replace(/\\/g, "/").toLowerCase();
    if (sourceDir !== "." && lower.includes(sourceDir.split("/").slice(-2).join("/"))) {
      score += 2;
    }
  }
  for (const token of queryTokens) {
    if (base.includes(token)) {
      score += 4;
    } else if (lower.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function inferNamingPatterns(sourceFiles: string[], testFiles: string[], symbolName?: string): string[] {
  const patterns = new Set<string>();
  if (symbolName) {
    patterns.add(`${symbolName}.test/spec or Test${symbolName}`);
  }
  for (const source of sourceFiles.slice(0, 4)) {
    const base = path.basename(source, path.extname(source));
    patterns.add(`${base}.test/spec`);
    patterns.add(`${base}Test`);
  }
  for (const test of testFiles.slice(0, 6)) {
    const base = path.basename(test);
    if (/\.test\.[cm]?[jt]sx?$/i.test(base)) {
      patterns.add("*.test.ts/js");
    } else if (/\.spec\.[cm]?[jt]sx?$/i.test(base)) {
      patterns.add("*.spec.ts/js");
    } else if (/Test\.java$/i.test(base)) {
      patterns.add("*Test.java");
    } else if (/^test_.*\.py$/i.test(base)) {
      patterns.add("test_*.py");
    }
  }
  return [...patterns].slice(0, 8);
}

function inferFrameworkHints(repoRoot: string, testFiles: string[]): string[] {
  const hints = new Set<string>();
  for (const file of testFiles.slice(0, 20)) {
    const text = safeRead(path.join(repoRoot, file));
    if (/\b(vitest|vi\.|describe\(|it\(|expect\()/.test(text)) {
      hints.add("vitest/jest-style describe/it/expect");
    }
    if (/\bjest\b|jest\./.test(text)) {
      hints.add("jest");
    }
    if (/\bpytest\b|def test_/.test(text)) {
      hints.add("pytest");
    }
    if (/\bunittest\b|TestCase/.test(text)) {
      hints.add("python unittest");
    }
    if (/org\.junit|@Test\b|Assertions\./.test(text)) {
      hints.add("JUnit");
    }
  }
  return [...hints].slice(0, 8);
}

function inferMockingHints(repoRoot: string, testFiles: string[]): string[] {
  const hints = new Set<string>();
  for (const file of testFiles.slice(0, 20)) {
    const text = safeRead(path.join(repoRoot, file));
    if (/\bvi\.(mock|fn|spyOn)\b/.test(text)) {
      hints.add("vitest vi.mock/vi.fn");
    }
    if (/\bjest\.(mock|fn|spyOn)\b/.test(text)) {
      hints.add("jest mock/fn/spyOn");
    }
    if (/\bMockito\b|@Mock\b|when\(|verify\(/.test(text)) {
      hints.add("Mockito");
    }
    if (/\b(monkeypatch|unittest\.mock|Mock\(|patch\()/.test(text)) {
      hints.add("pytest/unittest mock");
    }
  }
  return [...hints].slice(0, 8);
}

function stripKnownSuffix(value: string): string {
  return value
    .replace(/\.(test|spec)$/i, "")
    .replace(/^test_/i, "")
    .replace(/test$/i, "")
    .toLowerCase();
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
