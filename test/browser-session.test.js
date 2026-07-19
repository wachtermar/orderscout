import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverChromeProfiles, importChromeSession } from "../src/browser-session.js";

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

test("login discovers Chrome profiles and saves only the live verified session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orderscout-auto-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const defaultCookies = join(directory, "Default", "Network", "Cookies");
  const liveCookies = join(directory, "Profile 2", "Cookies");
  await mkdir(join(directory, "Default", "Network"), { recursive: true });
  await mkdir(join(directory, "Profile 2"), { recursive: true });
  await writeFile(defaultCookies, "expired cookies");
  await writeFile(liveCookies, "live cookies");
  const now = new Date();
  await utimes(defaultCookies, now, new Date(now.getTime() + 1_000));

  const profiles = await discoverChromeProfiles({ roots: [directory] });
  assert.deepEqual(profiles.map((entry) => entry.profile), ["Default", "Profile 2"]);

  const verified = [];
  const sessionsDirectory = join(directory, "sessions");
  const result = await importChromeSession("glovo", {
    profile: "auto",
    profileRoots: [directory],
    sessionsDirectory,
    cookieReader: async () => [{ name: "glovo_auth_info", value: "provider-token" }],
    verify: async (session) => {
      verified.push(session.source);
      if (session.source !== "chrome:Profile 2") throw Object.assign(new Error("expired"), { code: "AUTH_EXPIRED" });
      return { authenticated: true, id: "account-2" };
    },
  });

  assert.deepEqual(verified, ["chrome:Default", "chrome:Profile 2"]);
  assert.equal(result.profile, "Profile 2");
  assert.equal(result.verified.id, "account-2");
  const saved = JSON.parse(await readFile(join(sessionsDirectory, "glovo.json"), "utf8"));
  assert.equal(saved.source, "chrome:Profile 2");
});
