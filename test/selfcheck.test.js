// 精简自检：桩状态表 → 分类计数 + 逐条证据 + 退出码；以及 CLI `selfcheck --json` 的输出可解析。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(pathToFileURL(path.join(repo, "lib", "selfcheck.js")).href);
const { selfcheck, selfcheckFromState, renderSelfcheck } = mod;

// 桩补丁表：一条必需、一条可选、一条必需（用来区分 optional 对分类的影响）。
const PATCHES = [
  { id: 1, name: "ALPHA", layer: "提示词" },
  { id: 2, name: "BETA", layer: "工具", optional: true },
  { id: 3, name: "GAMMA", layer: "代码" },
];
const HOST = "0.2.1-rc.5";

function categoryOf(status, patch = PATCHES[0]) {
  const report = selfcheck({ patch_status: { [patch.id]: status }, patches: [patch], host: HOST });
  return report.rows[0].category;
}

test("selfcheck: 全部 applied → ok，exitCode 0", () => {
  const report = selfcheck({ patch_status: { 1: "applied", 2: "applied", 3: "already" }, patches: PATCHES, host: HOST });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.reason, "");
  assert.equal(report.counts.applied, 3);
  assert.equal(report.counts.all, 3);
  assert.equal(report.needs_apply, false);
  assert.deepEqual(report.rows[0], { id: 1, name: "ALPHA", status: "applied", category: "applied", optional: false, layer: "提示词" });
});

test("selfcheck: drifted → broken，ok:false 且 exitCode 非零", () => {
  const report = selfcheck({ patch_status: { 1: "applied", 2: "applied", 3: "drifted" }, patches: PATCHES, host: HOST });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.reason, "broken_or_unknown");
  assert.equal(report.counts.broken, 1);
  assert.deepEqual(report.issues.broken, [3]);
  assert.equal(report.rows[2].category, "broken");
});

test("selfcheck: 没见过的状态词按 unknown 处理（fail closed）", () => {
  const report = selfcheck({ patch_status: { 1: "applied", 2: "applied", 3: "sealed" }, patches: PATCHES, host: HOST });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.issues.unknown, [3]);
  assert.equal(report.counts.unknown, 1);
});

test("selfcheck: pending 不算失败，但 needs_apply 标出来", () => {
  const report = selfcheck({ patch_status: { 1: "pending", 2: "applied", 3: "applied" }, patches: PATCHES, host: HOST });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.needs_apply, true);
  assert.deepEqual(report.issues.pending, [1]);
});

test("selfcheck: 空状态表 + 宿主未定位 → exitCode 2 / host_not_located", () => {
  const report = selfcheck({ patch_status: {}, patches: PATCHES, host: "" });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.reason, "host_not_located");
  assert.ok(report.rows.every((row) => row.category === "unknown" && row.status === "unlocated"));
});

test("selfcheck: 宿主在但状态表读不出来 → patch_status_missing", () => {
  const report = selfcheck({ patch_status: {}, patches: PATCHES, host: HOST });
  assert.equal(report.exitCode, 2);
  assert.equal(report.reason, "patch_status_missing");
  assert.ok(report.rows.every((row) => row.status === "unknown"));
});

test("selfcheck: 空补丁表 → no_patches（不算核对通过）", () => {
  const report = selfcheck({ patch_status: { 1: "applied" }, patches: [], host: HOST });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.reason, "no_patches");
});

test("selfcheck: 状态词 → 分类映射逐项对齐 core.patchStatus 的词表", () => {
  const required = PATCHES[0];
  const optional = PATCHES[1];
  const cases = [
    ["applied", required, "applied"],
    ["already", required, "applied"],
    ["pending", required, "pending"],
    ["na", required, "inactive"],
    ["off", required, "inactive"],
    ["missing_file", required, "inactive"],
    ["skipped", optional, "inactive"],
    ["skipped", required, "unknown"],
    ["pattern_not_found", optional, "inactive"],
    ["pattern_not_found", required, "broken"],
    ["hit_count_mismatch:2/1", optional, "inactive"],
    ["hit_count_mismatch:2/1", required, "broken"],
    ["drifted", required, "broken"],
    ["unmatched", required, "broken"],
    ["", required, "unknown"],
    ["unknown", required, "unknown"],
    ["unlocated", required, "unknown"],
    ["EACCES: permission denied", required, "broken"],
  ];
  for (const [status, patch, want] of cases) {
    assert.equal(categoryOf(status, patch), want, `状态 ${JSON.stringify(status)}（optional=${patch.optional}）应归 ${want}`);
  }
});

test("selfcheck: missing_file 的必需补丁不算损坏（clean 机器不该被自检判红）", () => {
  const report = selfcheck({ patch_status: { 1: "missing_file", 2: "na", 3: "applied" }, patches: PATCHES, host: HOST });
  assert.equal(report.ok, true);
  assert.equal(report.counts.inactive, 2);
  assert.equal(report.counts.total, 1);
  assert.deepEqual(report.counts.by_status, { missing_file: 1, na: 1, applied: 1 });
});

test("selfcheck: 逐条证据字段与顺序跟补丁表一致", () => {
  const report = selfcheck({ patch_status: { 1: "applied", 2: "na", 3: "applied" }, patches: PATCHES, host: HOST });
  assert.deepEqual(report.rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(report.rows.map((r) => r.optional), [false, true, false]);
  assert.deepEqual(report.rows.map((r) => r.layer), ["提示词", "工具", "代码"]);
});

test("selfcheckFromState: 从 gatherState() 形状直接构造", () => {
  const report = selfcheckFromState(
    { patch_status: { 1: "applied" }, host_version: HOST, dsh_home: "C:/tmp/dsh" },
    { patches: [PATCHES[0]] },
  );
  assert.equal(report.ok, true);
  assert.equal(report.host, HOST);
  assert.equal(report.dsh_home, "C:/tmp/dsh");
});

test("selfcheck: 文本渲染包含计数与逐条行", () => {
  const report = selfcheck({ patch_status: { 1: "applied", 2: "na", 3: "drifted" }, patches: PATCHES, host: HOST });
  const text = renderSelfcheck(report);
  assert.match(text, /dsh-purge 自检 \/ selfcheck/);
  assert.match(text, /分类 \/ counts/);
  assert.match(text, /\[#1 \] ALPHA/);
  assert.match(text, /\[#3 ?\] GAMMA/);
  assert.match(text, /异常 1/);
});

test("selfcheck CLI: --json 输出可解析，退出码与报告一致", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-selfcheck-"));
  const run = spawnSync(process.execPath, [path.join(repo, "bin", "dsh-purge.js"), "selfcheck", "--json"], {
    cwd: repo,
    // 钉一个空 DSH_HOME，别把真实机器状态带进断言；宿主能不能定位都允许，只断言输出契约。
    env: { ...process.env, DSH_HOME: home, DSH_BASE: "" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  assert.ok(run.stdout, run.stderr || "子进程没有输出");
  const report = JSON.parse(run.stdout);
  assert.equal(typeof report.ok, "boolean");
  assert.equal(report.exitCode, run.status, "退出码必须与报告一致");
  assert.ok(Array.isArray(report.rows) && report.rows.length >= 1);
  assert.equal(typeof report.counts.all, "number");
  assert.equal(report.counts.all, report.rows.length);
  for (const row of report.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["category", "id", "layer", "name", "optional", "status"],
      "逐条证据字段固定",
    );
  }
});
