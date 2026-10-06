import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { seal, unseal } from "../src/lib/crypto-core";
const key = "ab".repeat(32);
test("AES-GCM detects tampering and wrong keys", () => {
  const sealed = seal({ refresh_token: "test-only", caption: "☕" }, key);
  assert.deepEqual(unseal(sealed, key), {
    refresh_token: "test-only",
    caption: "☕",
  });
  assert.throws(() => unseal(sealed, "cd".repeat(32)));
  const data = Buffer.from(sealed.slice(3), "base64url");
  data[15] ^= 1;
  assert.throws(() => unseal("v1." + data.toString("base64url"), key));
});
test("Node and Python share the same encryption format", () => {
  const python = process.env.TEST_PYTHON || "python3";
  const payload = { refresh_token: "fake-test-token", title: "Prague ☕" };
  const result = spawnSync(
    python,
    [
      "-c",
      "import json,sys; from worker.core import seal,unseal; x=json.loads(sys.stdin.read()); print(json.dumps(unseal(x['cipher'],x['key']),ensure_ascii=False)); print(seal(x['payload'],x['key']))",
    ],
    {
      input: JSON.stringify({ key, cipher: seal(payload, key), payload }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(lines[0]), payload);
  assert.deepEqual(unseal(lines[1], key), payload);
});
