import * as assert from "node:assert/strict";
import { test } from "node:test";

import { stopClient, StoppableClient } from "../src/client-shutdown";

function createClient(behavior: {
  needsStop: boolean;
  stopError?: Error;
  disposeError?: Error;
}): { client: StoppableClient; calls: string[] } {
  const calls: string[] = [];
  const client: StoppableClient = {
    needsStop: () => behavior.needsStop,
    stop: (timeout) => {
      calls.push(`stop(${timeout})`);
      return behavior.stopError
        ? Promise.reject(behavior.stopError)
        : Promise.resolve();
    },
    dispose: (timeout) => {
      calls.push(`dispose(${timeout})`);
      return behavior.disposeError
        ? Promise.reject(behavior.disposeError)
        : Promise.resolve();
    },
  };
  return { client, calls };
}

test("skips clients that are absent or need no stop", async () => {
  const logs: string[] = [];
  await stopClient(undefined, 10, (message) => logs.push(message));

  const { client, calls } = createClient({ needsStop: false });
  await stopClient(client, 10, (message) => logs.push(message));

  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("stops a stoppable client without disposing it", async () => {
  const logs: string[] = [];
  const { client, calls } = createClient({ needsStop: true });

  await stopClient(client, 10, (message) => logs.push(message));

  assert.deepEqual(calls, ["stop(10)"]);
  assert.deepEqual(logs, []);
});

test("disposes a client whose stop fails", async () => {
  const logs: string[] = [];
  const { client, calls } = createClient({
    needsStop: true,
    stopError: new Error(
      "Client is not running and can't be stopped. " +
        "It's current state is: starting",
    ),
  });

  await stopClient(client, 10, (message) => logs.push(message));

  assert.deepEqual(calls, ["stop(10)", "dispose(10)"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Failed to stop language client: .*starting/);
});

test("resolves even when both stop and dispose fail", async () => {
  const logs: string[] = [];
  const { client, calls } = createClient({
    needsStop: true,
    stopError: new Error("stop failed"),
    disposeError: new Error("dispose failed"),
  });

  await stopClient(client, 10, (message) => logs.push(message));

  assert.deepEqual(calls, ["stop(10)", "dispose(10)"]);
  assert.deepEqual(logs, [
    "[jetls-client] Failed to stop language client: stop failed.",
    "[jetls-client] Failed to dispose language client: dispose failed.",
  ]);
});
