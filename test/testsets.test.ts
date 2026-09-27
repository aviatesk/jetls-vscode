import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  nestTestsets,
  statsOutcome,
  supportsTestsets,
  TestRunnerRunFailure,
  TestRunnerRunStats,
  TestsetItem,
  testsetLabel,
  testsetReports,
} from "../src/testsets";

function testset(
  index: number,
  name: string,
  [startLine, endLine]: [number, number],
): TestsetItem {
  return {
    index,
    name,
    range: {
      start: { line: startLine, character: 0 },
      end: { line: endLine, character: 3 },
    },
  };
}

function stats(counts: Partial<TestRunnerRunStats>): TestRunnerRunStats {
  return {
    passed: 0,
    failed: 0,
    errored: 0,
    broken: 0,
    duration: 1.5,
    ...counts,
  };
}

const failure: TestRunnerRunFailure = {
  location: {
    uri: "file:///runtests.jl",
    range: {
      start: { line: 6, character: 0 },
      end: { line: 6, character: 10 },
    },
  },
  message: "Test Failed",
};

test("detects the testsets capability", () => {
  assert.equal(supportsTestsets({ testsetsProvider: true }), true);
  assert.equal(supportsTestsets({ testsetsProvider: "true" }), false);
  assert.equal(supportsTestsets({}), false);
  assert.equal(supportsTestsets(undefined), false);
  assert.equal(supportsTestsets(null), false);
});

test("strips the quotes of string literal testset names", () => {
  assert.equal(testsetLabel('"foo"'), "foo");
  assert.equal(testsetLabel('"foo $x"'), "foo $x");
  assert.equal(testsetLabel("name"), "name");
  assert.equal(testsetLabel('"'), '"');
});

test("nests testsets by range containment", () => {
  const outer = testset(1, '"outer"', [0, 8]);
  const inner1 = testset(2, '"inner1"', [1, 3]);
  const innermost = testset(3, '"innermost"', [2, 2]);
  const inner2 = testset(4, '"inner2"', [4, 7]);
  const other = testset(5, '"other"', [10, 12]);
  assert.deepEqual(nestTestsets([outer, inner1, innermost, inner2, other]), [
    {
      testset: outer,
      children: [
        {
          testset: inner1,
          children: [{ testset: innermost, children: [] }],
        },
        { testset: inner2, children: [] },
      ],
    },
    { testset: other, children: [] },
  ]);
});

test("maps test counts to test outcomes", () => {
  assert.deepEqual(statsOutcome(stats({ passed: 2 })), {
    kind: "passed",
    duration: 1500,
  });
  assert.deepEqual(statsOutcome(stats({ passed: 2, broken: 1 })), {
    kind: "passed",
    duration: 1500,
  });
  assert.deepEqual(statsOutcome(stats({ passed: 2, failed: 1 })), {
    kind: "failed",
    duration: 1500,
  });
  assert.deepEqual(statsOutcome(stats({ errored: 1 })), {
    kind: "failed",
    duration: 1500,
  });
  assert.deepEqual(statsOutcome(stats({})), { kind: "skipped" });
});

test("reports the results of the individual testsets", () => {
  const reports = testsetReports(
    {
      status: "completed",
      message: "",
      testsets: [
        {
          index: 1,
          stats: stats({ passed: 1, failed: 1 }),
          failures: [failure],
        },
        { index: 2, stats: stats({ passed: 1 }), failures: [] },
      ],
    },
    [1, 3],
  );
  assert.deepEqual(
    [...reports].sort(([a], [b]) => a - b),
    [
      [1, { outcome: { kind: "failed", duration: 1500 }, failures: [failure] }],
      // nested testsets that were not requested are reported too
      [2, { outcome: { kind: "passed", duration: 1500 }, failures: [] }],
      // requested testsets without results were not run
      [3, { outcome: { kind: "skipped" }, failures: [] }],
    ],
  );
});

test("reports incomplete runs for the requested testsets", () => {
  assert.deepEqual(
    [...testsetReports({ status: "cancelled", message: "cancelled" }, [1, 2])],
    [
      [1, { outcome: { kind: "skipped" }, failures: [] }],
      [2, { outcome: { kind: "skipped" }, failures: [] }],
    ],
  );
  assert.deepEqual(
    [
      ...testsetReports(
        { status: "errored", message: "Test execution failed" },
        [1],
      ),
    ],
    [
      [
        1,
        {
          outcome: { kind: "errored", message: "Test execution failed" },
          failures: [],
        },
      ],
    ],
  );
  assert.equal(testsetReports(null, [1]).get(1)?.outcome.kind, "errored");
});
