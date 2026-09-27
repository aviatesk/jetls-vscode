import type {
  DiagnosticRelatedInformation,
  Location,
  Position,
  Range,
} from "vscode-languageclient/node";

/** The JETLS request listing the runnable `@testset` blocks of a document. */
export const TESTSETS_METHOD = "jetls/testsets";
/** The JETLS request running `@testset`s, answered once the run finishes. */
export const RUN_TESTSETS_METHOD = "jetls/runTestsets";
/** The command code lenses and code actions use to run a `@testset`. */
export const RUN_TESTSET_COMMAND = "jetls.testrunner.run@testset";
/** The command code lenses use to clear the result of a `@testset`. */
export const CLEAR_TESTSET_RESULT_COMMAND = "jetls.testrunner.clearResult";

/** An element of the `TESTSETS_METHOD` response. */
export interface TestsetItem {
  /** 1-based index within the document. */
  index: number;
  /** Source text of the description, including the quotes of string literals. */
  name: string;
  range: Range;
}

export interface TestRunnerRunStats {
  passed: number;
  failed: number;
  errored: number;
  broken: number;
  /** In seconds. */
  duration: number;
}

export interface TestRunnerRunFailure {
  location: Location;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

/** The result of an individual `@testset` in `TestRunnerRunResult`. */
export interface TestsetRunResult {
  /** The `index` of the `TestsetItem`. */
  index: number;
  /** Including the nested `@testset`s. */
  stats: TestRunnerRunStats;
  /** Including the nested `@testset`s. */
  failures: TestRunnerRunFailure[];
}

/** The result of `RUN_TESTSETS_METHOD`. */
export interface TestRunnerRunResult {
  status: "completed" | "cancelled" | "errored";
  message: string;
  stats?: TestRunnerRunStats;
  failures?: TestRunnerRunFailure[];
  logs?: string;
  /** Including the `@testset`s nested in the requested ones. */
  testsets?: TestsetRunResult[];
}

export interface TestsetNode {
  testset: TestsetItem;
  children: TestsetNode[];
}

export type TestsetOutcome =
  | { kind: "passed"; duration: number }
  | { kind: "failed"; duration: number }
  | { kind: "skipped" }
  | { kind: "errored"; message: string };

export interface TestsetReport {
  outcome: TestsetOutcome;
  failures: TestRunnerRunFailure[];
}

/** Whether the server advertised support for `TESTSETS_METHOD`. */
export function supportsTestsets(experimental: unknown): boolean {
  return (
    typeof experimental === "object" &&
    experimental !== null &&
    (experimental as { testsetsProvider?: unknown }).testsetsProvider === true
  );
}

/** Strips the quotes of string literal descriptions. */
export function testsetLabel(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1);
  }
  return name;
}

function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

function rangeContains(outer: Range, inner: Range): boolean {
  return (
    comparePositions(outer.start, inner.start) <= 0 &&
    comparePositions(inner.end, outer.end) <= 0
  );
}

/** Builds the `@testset` nesting from the source order of `testsets`. */
export function nestTestsets(testsets: readonly TestsetItem[]): TestsetNode[] {
  const roots: TestsetNode[] = [];
  const ancestors: TestsetNode[] = [];
  for (const testset of testsets) {
    const node: TestsetNode = { testset, children: [] };
    while (
      ancestors.length > 0 &&
      !rangeContains(
        ancestors[ancestors.length - 1].testset.range,
        testset.range,
      )
    ) {
      ancestors.pop();
    }
    const parent = ancestors[ancestors.length - 1];
    (parent === undefined ? roots : parent.children).push(node);
    ancestors.push(node);
  }
  return roots;
}

export function statsOutcome(stats: TestRunnerRunStats): TestsetOutcome {
  const { passed, failed, errored, broken, duration } = stats;
  if (failed > 0 || errored > 0) {
    return { kind: "failed", duration: duration * 1000 };
  }
  if (passed + broken === 0) {
    return { kind: "skipped" };
  }
  return { kind: "passed", duration: duration * 1000 };
}

/**
 * Reports the outcomes of the `@testset`s of a run by their indices: those
 * of the requested `@testset`s and of the `@testset`s nested in them.
 */
export function testsetReports(
  result: TestRunnerRunResult | null,
  requested: readonly number[],
): Map<number, TestsetReport> {
  const reports = new Map<number, TestsetReport>();
  if (result?.status !== "completed") {
    const outcome: TestsetOutcome =
      result?.status === "cancelled"
        ? { kind: "skipped" }
        : {
            kind: "errored",
            message: result?.message ?? "TestRunner did not return a result.",
          };
    for (const index of requested) {
      reports.set(index, { outcome, failures: [] });
    }
    return reports;
  }
  for (const testset of result.testsets ?? []) {
    reports.set(testset.index, {
      outcome: statsOutcome(testset.stats),
      failures: testset.failures,
    });
  }
  for (const index of requested) {
    if (!reports.has(index)) {
      reports.set(index, { outcome: { kind: "skipped" }, failures: [] });
    }
  }
  return reports;
}
