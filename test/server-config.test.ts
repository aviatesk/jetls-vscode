import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  affectsServerConfig,
  getServerConfig,
  hasServerConfigChanged,
  ServerConfig,
} from "../src/server-config";

function createServerConfig(
  values: Record<string, unknown> = {},
): ServerConfig {
  return getServerConfig({
    get<T>(section: string, defaultValue?: T): T {
      return (values[section] ?? defaultValue) as T;
    },
  });
}

test("uses an empty managed storage path by default", () => {
  assert.deepEqual(createServerConfig(), {
    executable: {},
    managedStoragePath: "",
    communicationChannel: "auto",
    socketPort: 8080,
    initializationOptions: {},
  });
});

test("reads the configured managed storage path", () => {
  const config = createServerConfig({ managedStoragePath: "C:/jls" });

  assert.equal(config.managedStoragePath, "C:/jls");
});

test("detects the initial server configuration", () => {
  assert.equal(hasServerConfigChanged(null, createServerConfig()), true);
});

test("requires a restart when the managed storage root changes", () => {
  const defaults = createServerConfig();
  const firstRoot = createServerConfig({ managedStoragePath: "C:/jls" });
  const secondRoot = createServerConfig({ managedStoragePath: "C:/jetls" });

  assert.equal(hasServerConfigChanged(defaults, firstRoot), true);
  assert.equal(hasServerConfigChanged(firstRoot, secondRoot), true);
  assert.equal(hasServerConfigChanged(secondRoot, defaults), true);
  assert.equal(hasServerConfigChanged(defaults, createServerConfig()), false);
  assert.equal(
    hasServerConfigChanged(
      firstRoot,
      createServerConfig({ managedStoragePath: "C:/jls" }),
    ),
    false,
  );
});

test("ignores managed storage root changes for a custom executable path", () => {
  const config = createServerConfig({
    executable: { path: "/custom/jetls" },
  });

  assert.equal(
    hasServerConfigChanged(config, { ...config, managedStoragePath: "C:/jls" }),
    false,
  );
});

test("ignores managed storage root changes for a custom command array", () => {
  const config = createServerConfig({
    executable: ["julia", "-m", "JETLS", "serve"],
  });

  assert.equal(
    hasServerConfigChanged(config, { ...config, managedStoragePath: "C:/jls" }),
    false,
  );
});

test("recognizes server configuration change events", () => {
  for (const section of [
    "jetls-client.executable",
    "jetls-client.managedStoragePath",
    "jetls-client.communicationChannel",
    "jetls-client.socketPort",
    "jetls-client.initializationOptions",
  ]) {
    assert.equal(
      affectsServerConfig({
        affectsConfiguration: (candidate) => candidate === section,
      }),
      true,
      section,
    );
  }
});

test("ignores unrelated configuration change events", () => {
  for (const section of ["jetls-client.settings", "editor.fontSize"]) {
    assert.equal(
      affectsServerConfig({
        affectsConfiguration: (candidate) => candidate === section,
      }),
      false,
      section,
    );
  }
});
