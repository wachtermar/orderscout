import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("the npm-style pide symlink executes the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pide-bin-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "pide");
  await symlink(fileURLToPath(new URL("../src/pide.js", import.meta.url)), link);

  const { stdout } = await execFileAsync(link, ["--version"], { encoding: "utf8" });
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});
