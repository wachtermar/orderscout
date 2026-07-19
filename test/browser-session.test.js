import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importChromeSession } from "../src/browser-session.js";

test("native Chrome login imports provider cookies into an owner-only session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orderscout-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cookiePath = join(directory, "Cookies");
  const sessionsDirectory = join(directory, "sessions");
  await writeFile(cookiePath, "synthetic cookie database");

  const result = await importChromeSession("glovo", {
    cookiePath,
    sessionsDirectory,
    cookieReader: async (url) => {
      assert.equal(url, "https://glovoapp.com/");
      return [
        { name: "glovo_auth_info", value: "provider-token" },
        { name: "glovo_user_city", value: "MBA" },
      ];
    },
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.cookieCount, 2);
  const savedPath = join(sessionsDirectory, "glovo.json");
  const saved = JSON.parse(await readFile(savedPath, "utf8"));
  assert.deepEqual(saved.cookieNames, ["glovo_auth_info", "glovo_user_city"]);
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
});
