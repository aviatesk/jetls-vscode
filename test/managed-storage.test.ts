import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import {
  MANAGED_STORAGE_SETTING,
  ManagedJETLSError,
  resolveManagedStoragePath,
} from "../src/managed-installation";

const windowsStorage =
  "C:/Users/alice/VSCode_Julia_portable/assets/VSCode/data/" +
  "user-data/User/globalStorage/aviatesk.jetls-client";

test("keeps the default storage unchanged on all platforms, including portable Windows", () => {
  for (const storage of [
    windowsStorage,
    "C:/Users/alice/AppData/Roaming/Code/User/globalStorage/aviatesk.jetls-client",
  ]) {
    assert.equal(resolveManagedStoragePath(storage, "", "win32"), storage);
  }
  for (const platform of ["darwin", "linux"] as const) {
    const storage =
      "/home/user/.vscode-server/data/User/globalStorage/aviatesk.jetls-client";
    assert.equal(resolveManagedStoragePath(storage, "", platform), storage);
  }
});

test("isolates storage owners when they choose the same override", () => {
  const first = resolveManagedStoragePath(windowsStorage, "D:/jetls", "win32");
  assert.equal(
    resolveManagedStoragePath(
      windowsStorage.toUpperCase().replaceAll("/", "\\") + "\\",
      "D:/jetls",
      "win32",
    ),
    first,
  );
  assert.notEqual(
    resolveManagedStoragePath(
      "D:/other-portable/data/storage",
      "D:/jetls",
      "win32",
    ),
    first,
  );
});

test("accepts literal absolute overrides on the extension host", () => {
  const storage = resolveManagedStoragePath(
    windowsStorage,
    "D:/jetls",
    "win32",
  );
  const storageId = path.win32.basename(storage);
  assert.match(storageId, /^[0-9a-f]{12}$/);
  for (const root of [
    "D:/jetls",
    "D:\\JETLS storage",
    "\\\\server\\share\\jls",
  ]) {
    assert.equal(
      resolveManagedStoragePath(windowsStorage, root, "win32"),
      path.win32.join(root, storageId),
    );
  }
  for (const platform of ["darwin", "linux"] as const) {
    const storage = resolveManagedStoragePath(
      "/vscode/storage",
      "/managed",
      platform,
    );
    assert.equal(path.posix.dirname(storage), "/managed");
    assert.match(path.posix.basename(storage), /^[0-9a-f]{12}$/);
    assert.notEqual(
      resolveManagedStoragePath("/other/storage", "/managed", platform),
      storage,
    );
  }
});

test("trims surrounding whitespace from the override", () => {
  assert.equal(
    resolveManagedStoragePath(windowsStorage, " ", "win32"),
    windowsStorage,
  );
  assert.equal(
    resolveManagedStoragePath(windowsStorage, " D:/jetls ", "win32"),
    resolveManagedStoragePath(windowsStorage, "D:/jetls", "win32"),
  );
});

test("rejects relative overrides with actionable settings guidance", () => {
  const invalidPaths = {
    win32: [
      "relative",
      "C:relative",
      "\\jls",
      "/jls",
      "\\\\server",
      "%LOCALAPPDATA%/jls",
      "~/jls",
    ],
    linux: ["relative", "C:/jls", "~/jls"],
  };
  for (const platform of ["win32", "linux"] as const) {
    for (const configuredPath of invalidPaths[platform]) {
      assert.throws(
        () =>
          resolveManagedStoragePath(windowsStorage, configuredPath, platform),
        (error: unknown) => {
          assert.ok(error instanceof ManagedJETLSError);
          assert.equal(error.retryable, false);
          assert.equal(error.setting, MANAGED_STORAGE_SETTING);
          assert.match(error.summary, /must be an absolute path/);
          return true;
        },
      );
    }
  }
});

test("rejects depot path-list separators before Julia can use unintended storage", () => {
  const assertInvalid = (resolve: () => string): void => {
    assert.throws(resolve, (error: unknown) => {
      assert.ok(error instanceof ManagedJETLSError);
      assert.equal(error.retryable, false);
      assert.equal(error.setting, MANAGED_STORAGE_SETTING);
      assert.match(error.message, /path-list separator/);
      return true;
    });
  };
  assertInvalid(() =>
    resolveManagedStoragePath(windowsStorage, "C:/jls;cache", "win32"),
  );
  assertInvalid(() =>
    resolveManagedStoragePath("/vscode/storage", "/tmp/jls:cache", "linux"),
  );
});

test("a short override leaves room for the libgit2 reference path reported in #20", () => {
  const referencePath =
    "jetls-depots/v1.12-a0321c78/2026-09-06-8069a336/" +
    "clones/2106982716426084302/refs/remotes/remotes/cache/heads/" +
    "1aa8e618b20499693795d42fccddae099ac487ff/HEAD";
  const oldPath = path.win32.join(windowsStorage, referencePath);
  assert.equal(oldPath.length, 260);
  // libgit2 reserves the lock suffix even when just reading a reference.
  assert.ok(oldPath.length + ".lock".length > 260);
  const newPath = path.win32.join(
    resolveManagedStoragePath(windowsStorage, "C:/jls", "win32"),
    referencePath,
  );
  assert.ok(newPath.length + ".lock".length <= 260);
});
