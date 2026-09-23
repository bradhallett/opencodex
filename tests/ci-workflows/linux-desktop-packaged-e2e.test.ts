import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeRecordPort,
  locateArtifacts,
  parseArguments,
  processTreeRssKiB,
  readRuntimeRecord,
  selectDebExecutable,
} from "../../desktop/scripts/linux-packaged-e2e";
import { repoPath } from "../helpers/repo-root";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "opencodex-linux-e2e-test-"));
}

describe("Linux packaged desktop E2E driver", () => {
  test("requires an explicit bundle root, report and strict version", () => {
    expect(() => parseArguments([])).toThrow("required");
    expect(() => parseArguments([
      "--bundle-root", "/bundles",
      "--report", "/report.json",
      "--version", "latest",
    ])).toThrow("strict semver");
    expect(parseArguments([
      "--bundle-root", "/bundles",
      "--report", "/report.json",
      "--version", "2.61.0-preview.1",
    ]).version).toBe("2.61.0-preview.1");
  });

  test("requires exactly one AppImage and deb from their bundle directories", () => {
    const root = temporaryDirectory();
    try {
      mkdirSync(join(root, "appimage"));
      mkdirSync(join(root, "deb"));
      writeFileSync(join(root, "appimage", "OpenCodex.AppImage"), "appimage");
      writeFileSync(join(root, "deb", "OpenCodex.deb"), "deb");
      expect(locateArtifacts(root)).toEqual({
        appimage: join(root, "appimage", "OpenCodex.AppImage"),
        deb: join(root, "deb", "OpenCodex.deb"),
      });
      writeFileSync(join(root, "deb", "stale.deb"), "deb");
      expect(() => locateArtifacts(root)).toThrow("exactly one deb");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("selects the deb desktop host without mistaking the ocx sidecar for the app", () => {
    expect(selectDebExecutable(["/payload/usr/bin/ocx", "/payload/usr/bin/opencodex-desktop"]))
      .toBe("/payload/usr/bin/opencodex-desktop");
    expect(() => selectDebExecutable(["/payload/usr/bin/ocx"]))
      .toThrow("expected exactly one deb desktop executable");
  });

  test("accepts only a complete positive runtime record", () => {
    const root = temporaryDirectory();
    try {
      const record = join(root, "runtime-port.json");
      writeFileSync(record, JSON.stringify({ pid: 42, port: 10100 }));
      expect(readRuntimeRecord(record)).toEqual({ pid: 42, port: 10100 });
      expect(assertRuntimeRecordPort({ pid: 42, port: 10100 }, 10100)).toEqual({
        pid: 42,
        port: 10100,
      });
      expect(() => assertRuntimeRecordPort({ pid: 42, port: 10101 }, 10100))
        .toThrow("recorded port 10101, expected isolated port 10100");
      for (const invalid of [
        { pid: 0, port: 10100 },
        { pid: 42, port: 0 },
        { pid: 42, port: 65_536 },
        { pid: "42", port: 10100 },
      ]) {
        writeFileSync(record, JSON.stringify(invalid));
        expect(readRuntimeRecord(record)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("measures only the selected process tree", () => {
    const rows = [
      { pid: 10, ppid: 1, rssKiB: 100 },
      { pid: 11, ppid: 10, rssKiB: 50 },
      { pid: 12, ppid: 11, rssKiB: 25 },
      { pid: 20, ppid: 1, rssKiB: 1_000 },
    ];
    expect(processTreeRssKiB(10, rows)).toBe(175);
    expect(processTreeRssKiB(20, rows)).toBe(1_000);
  });

  test("CI scopes the real package build and keeps the E2E unprivileged", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
      permissions?: Record<string, string>;
      jobs?: Record<string, {
        if?: string;
        outputs?: Record<string, string>;
        steps?: Array<{
          name?: string;
          uses?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
        }>;
      }>;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const changes = workflow.jobs?.changes;
    expect(changes?.outputs?.desktop).toBe("${{ steps.scope.outputs.desktop }}");
    const filter = changes?.steps?.find(step => step.name === "Detect changed areas");
    const filters = String(filter?.with?.filters ?? "");
    expect(filters).toContain("desktop:");
    expect(filters).toContain("'desktop/**'");
    expect(filters).toContain("'src/**'");
    expect(filters).toContain("'.github/workflows/ci.yml'");

    const shell = workflow.jobs?.["desktop-shell"];
    expect(shell?.if).toContain("needs.changes.outputs.desktop == 'true'");
    const checkResources = shell?.steps?.find(step => step.name === "Prepare desktop check resources");
    expect(checkResources?.run).toContain("binaries/ocx-");
    expect(checkResources?.run).not.toContain("resources/sidecar/ocx");
    const preserve = shell?.steps?.find(step => step.name === "Preserve the compiled Linux sidecar");
    expect(preserve?.run).toContain("chmod +x desktop/scripts/appimage-patchelf.py");
    const appImageBuild = shell?.steps?.find(step => step.name === "Build Linux AppImage");
    const debBuild = shell?.steps?.find(step => step.name === "Build Linux deb");
    expect(appImageBuild?.env?.CARGO_TARGET_DIR).toContain("opencodex-appimage-target");
    expect(appImageBuild?.env?.PATCHELF).toContain("desktop/scripts/appimage-patchelf.py");
    expect(debBuild?.env?.CARGO_TARGET_DIR).toContain("opencodex-deb-target");
    expect(appImageBuild?.env?.CARGO_TARGET_DIR).not.toBe(debBuild?.env?.CARGO_TARGET_DIR);
    const stage = shell?.steps?.find(step => step.name === "Stage isolated Linux bundles");
    expect(stage?.run).toContain("$APPIMAGE_BUNDLE/.");
    expect(stage?.run).toContain("$DEB_BUNDLE/.");
    expect(stage?.run).toContain('chmod -R a-w "$BUNDLE_ROOT"');

    const aggregate = workflow.jobs?.ci?.steps?.find(step => step.name === "Assert every job this event requested succeeded");
    expect(aggregate?.env?.CHANGES_DESKTOP).toBe("${{ needs.changes.outputs.desktop }}");
    expect(aggregate?.run).toContain("desktop-shell) echo \"$desktop_shell\"");

    const e2e = shell?.steps?.find(step => step.name === "Run Linux packaged-shell E2E");
    expect(e2e?.if).toBe("needs.changes.outputs.desktop == 'true'");
    expect(e2e?.run).toContain("dbus-run-session -- xvfb-run");
    expect(e2e?.run).toContain("openbox");
    expect(e2e?.run).toContain("linux-packaged-e2e.ts");
    expect(e2e?.run).toContain("opencodex-linux-bundles");
    expect(e2e?.run).not.toContain("sudo");
    expect(e2e?.run).not.toContain("dpkg -i");

    const upload = shell?.steps?.find(step => step.name === "Upload Linux packaged-shell E2E report");
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
    expect(upload?.if).toContain("always()");
  });

  test("the driver isolates each package from a runtime already using the default port", () => {
    const driver = readFileSync(
      repoPath("desktop", "scripts", "linux-packaged-e2e.ts"),
      "utf8",
    );
    expect(driver).toContain('server.listen(0, "127.0.0.1"');
    expect(driver).toContain('join(opencodexHome, "config.json")');
    expect(driver).toContain("JSON.stringify({ port: configuredPort }");
    expect(driver).not.toContain('port: 10100');
    expect(driver).toContain('["search", "--onlyvisible", "--name", "^OpenCodex$"]');
  });
});
