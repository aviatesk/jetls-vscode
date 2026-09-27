import * as vscode from "vscode";
import {
  ExecuteCommandSignature,
  LanguageClient,
  State,
} from "vscode-languageclient/node";

import {
  CLEAR_TESTSET_RESULT_COMMAND,
  nestTestsets,
  RUN_TESTSET_COMMAND,
  RUN_TESTSETS_METHOD,
  TestRunnerRunFailure,
  TestRunnerRunResult,
  TestsetItem,
  testsetLabel,
  TestsetNode,
  TestsetReport,
  testsetReports,
  TESTSETS_METHOD,
} from "./testsets";

const REFRESH_DELAY = 500;

interface TestsetData {
  /** The document URI in the form sent to the server. */
  uri: string;
  index: number;
  name: string;
}

function isTestsetDocument(document: vscode.TextDocument): boolean {
  return (
    document.languageId === "julia" &&
    (document.uri.scheme === "file" || document.uri.scheme === "untitled")
  );
}

function testsetId(index: number, name: string): string {
  return `${index}:${name}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function* withDescendants(item: vscode.TestItem): Generator<vscode.TestItem> {
  yield item;
  for (const [, child] of item.children) {
    yield* withDescendants(child);
  }
}

/**
 * Exposes the `@testset` blocks of open Julia documents through the VS Code
 * Testing API, which shows run buttons in the editor gutter and lists the
 * testsets in the Test Explorer. Runs go through `RUN_TESTSETS_METHOD`, whose
 * response carries the results of the individual testsets.
 */
export class TestsetController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly testsets = new WeakMap<vscode.TestItem, TestsetData>();
  /** Testset items by document URI and testset index. */
  private readonly documentTestsets = new Map<
    string,
    Map<number, vscode.TestItem>
  >();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  /** Discards responses of superseded `TESTSETS_METHOD` requests. */
  private readonly latestRefreshes = new Map<string, number>();
  private refreshCount = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly client: LanguageClient) {
    this.controller = vscode.tests.createTestController(
      "jetls-testrunner",
      "JETLS TestRunner",
    );
    this.controller.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token),
      true,
    );
    this.disposables.push(
      this.controller,
      vscode.workspace.onDidOpenTextDocument((document) =>
        this.scheduleRefresh(document, 0),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
          this.scheduleRefresh(event.document, REFRESH_DELAY);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.remove(document.uri),
      ),
      // Refetch after vscode-languageclient restarted a crashed server.
      client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
          this.refreshAll();
        }
      }),
    );
    this.refreshAll();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /**
   * Runs the testsets that code lenses and code actions ask to run through
   * the Testing API as well, so that their results show up in the gutter and
   * the Test Explorer, and marks the results they clear as outdated there.
   */
  executeCommand(
    command: string,
    args: unknown[],
    next: ExecuteCommandSignature,
  ): vscode.ProviderResult<unknown> {
    if (command === RUN_TESTSET_COMMAND) {
      const item = this.findTestset(args);
      if (item !== undefined) {
        return this.run(new vscode.TestRunRequest([item]));
      }
    } else if (command === CLEAR_TESTSET_RESULT_COMMAND) {
      const item = this.findTestset(args);
      if (item !== undefined) {
        return this.clearResult(item, () => next(command, args));
      }
    }
    return next(command, args);
  }

  private async clearResult(
    item: vscode.TestItem,
    clear: () => vscode.ProviderResult<unknown>,
  ): Promise<unknown> {
    const result = await clear();
    this.controller.invalidateTestResults(item);
    return result;
  }

  private findTestset(args: unknown[]): vscode.TestItem | undefined {
    const [uri, index, name] = args;
    if (
      typeof uri !== "string" ||
      typeof index !== "number" ||
      typeof name !== "string"
    ) {
      return undefined;
    }
    const item = this.testsetItems(uri)?.get(index);
    return item !== undefined && this.testsets.get(item)?.name === name
      ? item
      : undefined;
  }

  /** `uri` is a document URI in the form sent to the server. */
  private testsetItems(uri: string): Map<number, vscode.TestItem> | undefined {
    return this.documentTestsets.get(vscode.Uri.parse(uri).toString());
  }

  private refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.scheduleRefresh(document, 0);
    }
  }

  private scheduleRefresh(document: vscode.TextDocument, delay: number): void {
    if (this.disposed || !isTestsetDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    clearTimeout(this.refreshTimers.get(key));
    this.refreshTimers.set(
      key,
      setTimeout(() => {
        this.refreshTimers.delete(key);
        void this.refresh(document);
      }, delay),
    );
  }

  private async refresh(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const generation = ++this.refreshCount;
    this.latestRefreshes.set(key, generation);
    let testsets: TestsetItem[] | null;
    try {
      testsets = await this.client.sendRequest<TestsetItem[] | null>(
        TESTSETS_METHOD,
        {
          textDocument: {
            uri: this.client.code2ProtocolConverter.asUri(document.uri),
          },
        },
      );
    } catch (err) {
      this.client.debug(`Failed to list the testsets of ${key}.`, err);
      return;
    }
    if (
      this.disposed ||
      document.isClosed ||
      this.latestRefreshes.get(key) !== generation
    ) {
      return;
    }
    this.update(document.uri, testsets ?? []);
  }

  private update(uri: vscode.Uri, testsets: TestsetItem[]): void {
    const key = uri.toString();
    if (testsets.length === 0) {
      this.controller.items.delete(key);
      this.documentTestsets.delete(key);
      return;
    }
    let fileItem = this.controller.items.get(key);
    if (fileItem === undefined) {
      fileItem = this.controller.createTestItem(
        key,
        vscode.workspace.asRelativePath(uri),
        uri,
      );
      this.controller.items.add(fileItem);
    }
    const protocolUri = this.client.code2ProtocolConverter.asUri(uri);
    const items = new Map<number, vscode.TestItem>();
    // Reuse the existing items so that in-flight runs keep referring to
    // items that stay in the tree.
    const updateItems = (
      collection: vscode.TestItemCollection,
      nodes: TestsetNode[],
    ): vscode.TestItem[] =>
      nodes.map(({ testset, children }) => {
        const id = testsetId(testset.index, testset.name);
        const item =
          collection.get(id) ??
          this.controller.createTestItem(id, testsetLabel(testset.name), uri);
        item.range = this.client.protocol2CodeConverter.asRange(testset.range);
        item.children.replace(updateItems(item.children, children));
        this.testsets.set(item, {
          uri: protocolUri,
          index: testset.index,
          name: testset.name,
        });
        items.set(testset.index, item);
        return item;
      });
    fileItem.children.replace(
      updateItems(fileItem.children, nestTestsets(testsets)),
    );
    this.documentTestsets.set(key, items);
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.refreshTimers.get(key));
    this.refreshTimers.delete(key);
    this.latestRefreshes.delete(key);
    this.controller.items.delete(key);
    this.documentTestsets.delete(key);
  }

  private async run(
    request: vscode.TestRunRequest,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const cancellation = token ?? run.token;
    const documents = this.runnableItems(request);
    for (const items of documents.values()) {
      for (const item of items) {
        for (const testItem of withDescendants(item)) {
          run.enqueued(testItem);
        }
      }
    }
    for (const [uri, items] of documents) {
      if (cancellation.isCancellationRequested) {
        for (const item of items) {
          run.skipped(item);
        }
      } else {
        await this.runTestsets(run, uri, items, cancellation);
      }
    }
    run.end();
  }

  /**
   * Running a testset also runs the testsets nested in it, so a file item
   * expands to its outermost testsets, and testsets nested in other selected
   * testsets are left to them. The items are grouped by their documents,
   * each of which is run at once.
   */
  private runnableItems(
    request: vscode.TestRunRequest,
  ): Map<string, vscode.TestItem[]> {
    const excluded = new Set(request.exclude);
    const items = new Set<vscode.TestItem>();
    const add = (item: vscode.TestItem) => {
      if (excluded.has(item)) {
        return;
      }
      if (this.testsets.has(item)) {
        items.add(item);
      } else {
        item.children.forEach(add);
      }
    };
    if (request.include === undefined) {
      this.controller.items.forEach(add);
    } else {
      request.include.forEach(add);
    }
    const hasSelectedAncestor = (item: vscode.TestItem) => {
      for (let parent = item.parent; parent; parent = parent.parent) {
        if (items.has(parent)) {
          return true;
        }
      }
      return false;
    };
    const documents = new Map<string, vscode.TestItem[]>();
    for (const item of items) {
      const testset = this.testsets.get(item);
      if (testset === undefined || hasSelectedAncestor(item)) {
        continue;
      }
      const documentItems = documents.get(testset.uri);
      if (documentItems === undefined) {
        documents.set(testset.uri, [item]);
      } else {
        documentItems.push(item);
      }
    }
    return documents;
  }

  /** `uri` is a document URI in the form sent to the server. */
  private async runTestsets(
    run: vscode.TestRun,
    uri: string,
    items: vscode.TestItem[],
    token: vscode.CancellationToken,
  ): Promise<void> {
    const testsets = items.map((item) => this.testsets.get(item)!);
    // The testsets nested in the requested ones are run as parts of them. Those
    // left without results are marked as skipped when the run ends.
    for (const item of items) {
      for (const testItem of withDescendants(item)) {
        run.started(testItem);
      }
    }
    let result: TestRunnerRunResult | null;
    try {
      result = await this.client.sendRequest<TestRunnerRunResult | null>(
        RUN_TESTSETS_METHOD,
        {
          textDocument: { uri },
          testsets: testsets.map(({ index, name }) => ({ index, name })),
        },
        token,
      );
    } catch (err) {
      for (const item of items) {
        if (token.isCancellationRequested) {
          run.skipped(item);
        } else {
          run.errored(item, new vscode.TestMessage(errorMessage(err)));
        }
      }
      return;
    }
    if (result?.logs) {
      run.appendOutput(
        result.logs.replace(/\r?\n/g, "\r\n"),
        undefined,
        items.length === 1 ? items[0] : undefined,
      );
    }
    const reports = testsetReports(
      result,
      testsets.map(({ index }) => index),
    );
    const documentItems = this.testsetItems(uri);
    for (const [index, report] of reports) {
      const item = documentItems?.get(index);
      if (item !== undefined) {
        this.report(run, item, report, result?.message ?? "");
      }
    }
  }

  private report(
    run: vscode.TestRun,
    item: vscode.TestItem,
    { outcome, failures }: TestsetReport,
    summary: string,
  ): void {
    switch (outcome.kind) {
      case "passed":
        run.passed(item, outcome.duration);
        break;
      case "failed":
        run.failed(
          item,
          this.failureMessages(failures, summary),
          outcome.duration,
        );
        break;
      case "skipped":
        run.skipped(item);
        break;
      case "errored":
        run.errored(item, new vscode.TestMessage(outcome.message));
        break;
    }
  }

  private failureMessages(
    failures: TestRunnerRunFailure[],
    summary: string,
  ): vscode.TestMessage[] {
    const converter = this.client.protocol2CodeConverter;
    const messages = failures.map((failure) => {
      const message = new vscode.TestMessage(failure.message);
      message.location = converter.asLocation(failure.location);
      message.stackTrace = failure.relatedInformation?.map(
        (frame) =>
          new vscode.TestMessageStackFrame(
            frame.message,
            converter.asUri(frame.location.uri),
            converter.asPosition(frame.location.range.start),
          ),
      );
      return message;
    });
    if (messages.length === 0) {
      messages.push(new vscode.TestMessage(summary));
    }
    return messages;
  }
}
