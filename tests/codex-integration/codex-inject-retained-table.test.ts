import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

setDefaultTimeout(SPAWN_BUDGET_MS);

// Full injectCodexConfig runs in a subprocess with isolated CODEX_HOME/OPENCODEX_HOME so
// module-level path constants bind to the temp dirs (same pattern as codex-journal.test.ts).
function runInject(
  codexHome: string,
  ocxHome: string,
  configJson = "{}",
): { stdout: string; stderr: string; status: number } {
  const script = `
    const { injectCodexConfig } = require("./src/codex/inject");
    injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(r => {
      console.log(JSON.stringify(r));
    });
  `;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, TEST_OCX_CONFIG: configJson },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

describe("injectCodexConfig retained provider restore", () => {
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-codex-")));
    ocxHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-inject-home-")));
  });

  afterEach(() => {
    removeTreeWithRetry(codexHome);
    removeTreeWithRetry(ocxHome);
  });

  test("a journaled same-named foreign table aborts restore and reinstates the pre-restore config", () => {
    // The user's pre-injection config carries its own [model_providers.opencodex] table.
    // Injection strips it (it is not ours) but journals it as the user's baseline, so the
    // journal restore replays it verbatim. Retention then sees a table that differs from
    // the captured block, refuses to rebind tagged threads, and the failed config artifact
    // makes the caller roll every file back to its pre-restore bytes.
    const configPath = join(codexHome, "config.toml");
    const journalPath = join(codexHome, "opencodex-journal.json");
    writeFileSync(configPath, [
      'model="test"',
      "",
      "[model_providers.opencodex]",
      'name="Unrelated Provider"',
      'base_url="https://unrelated.invalid/v1"',
      "",
    ].join("\n"));
    const seed = runInject(codexHome, ocxHome, JSON.stringify({ codexClientCompaction: true }));
    expect(seed.status).toBe(0);
    expect(JSON.parse(seed.stdout).success).toBe(true);
    const configBefore = readFileSync(configPath, "utf8");
    expect(configBefore).not.toContain("unrelated.invalid");
    const script = `
      const fs = require("node:fs");
      const { join } = require("node:path");
      const { Database } = require("bun:sqlite");
      const { restoreNativeCodex } = require("./src/codex/inject");
      const { syncCodexHistoryProvider, historyBackupPathFor } = require("./src/codex/history-provider");
      const dbPath = require("./src/codex/paths").resolveCodexStateDbPath();
      const rollout = join(process.env.CODEX_HOME, "manifest-fixture.jsonl");
      fs.writeFileSync(rollout, JSON.stringify({type:"session_meta",payload:{id:"fixture",model_provider:"openai",source:"cli"}})+String.fromCharCode(10));
      const db = new Database(dbPath);
      db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, source TEXT, first_user_message TEXT, has_user_event INTEGER)");
      db.run("INSERT INTO threads VALUES ('fixture', ?, 'openai', 'cli', 'hello', 1)", rollout);
      const routed = syncCodexHistoryProvider("opencodex", dbPath);
      if (routed.failed || routed.rows !== 1) throw new Error("fixture history route failed");
      db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
      db.close();
      const historyPaths = [historyBackupPathFor(dbPath), rollout];
      const beforeHistory = historyPaths.map(p=>fs.readFileSync(p,"utf8"));
      const result = restoreNativeCodex();
      const restoredDb = new Database(dbPath, { readonly: true });
      const provider = restoredDb.query("SELECT model_provider FROM threads WHERE id='fixture'").get().model_provider;
      restoredDb.close();
      const configAfter = fs.readFileSync(join(process.env.CODEX_HOME,"config.toml"),"utf8");
      console.log(JSON.stringify({
        result,
        provider,
        configAfter,
        journalExists: fs.existsSync(join(process.env.CODEX_HOME,"opencodex-journal.json")),
        historyPreserved: historyPaths.every((p,i)=>fs.readFileSync(p,"utf8")===beforeHistory[i]),
      }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ocxHome },
      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.result.success).toBe(false);
    expect(result.result.artifacts.config).toMatchObject({ state: "failed", action: "failed" });
    expect(result.result.artifacts.config.message).toContain(
      "native config already defines a different [model_providers.opencodex] table",
    );
    expect(result.configAfter).toBe(configBefore);
    expect(result.journalExists).toBe(true);
    expect(result.provider).toBe("opencodex");
    expect(result.historyPreserved).toBe(true);
  });

});
