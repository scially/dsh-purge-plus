// 精简版自检：把 core.patchStatus() 的原始状态表变成**可断言的证据链**。
// 上游 lib/selfcheck.js 是逐层自检（宿主/注入/profile/权限各一层，287 行）；本 fork 只保留最小闭环：
//   输入 = { patch_status, patches }；输出 = 分类计数 + 逐条证据 + 退出码。
// 判定口径：有 broken / unknown 就 ok:false（fail closed），状态表整体缺失就单独给一个退出码。
import { patchStateCategory, summarizePatchRows } from "./patch-state.mjs";

export const EXIT_OK = 0;
export const EXIT_ISSUES = 1;
export const EXIT_UNKNOWN_STATE = 2;

const MARKS = { applied: "✓", pending: "✗", inactive: "·", unknown: "?", broken: "!" };

/**
 * @param {object} input
 * @param {Record<string,string>} input.patch_status core.patchStatus() 的原始状态表。
 * @param {Array<object>} input.patches 补丁表（core.ALL_PATCHES 或桩表）。
 * @param {string} [input.host] 宿主版本（未定位则留空）。
 * @param {string} [input.dsh_home] DSH 数据目录，仅用于输出证据。
 * @param {string} [input.generated_at] 生成时间；不传则用当前时间。
 */
export function selfcheck({ patch_status = {}, patches = [], host = "", dsh_home = "", generated_at = "" } = {}) {
  const statusMap = patch_status && typeof patch_status === "object" ? patch_status : {};
  const list = Array.isArray(patches) ? patches : [];
  const hostLabel = String(host || "").trim();
  // 宿主没定位时 patchStatus 返回空表：这时每条补丁都记 unlocated，而不是「未知但可能没事」。
  const fallback = hostLabel ? "unknown" : "unlocated";
  const rows = list.map((patch) => {
    const raw = statusMap[patch?.id];
    const status = raw === undefined || raw === null ? "" : String(raw);
    const optional = patch?.optional === true;
    return {
      id: patch?.id,
      name: String(patch?.name || ""),
      status: status || fallback,
      category: patchStateCategory({ optional, settleWhenAbsent: patch?.settleWhenAbsent === true }, status),
      optional,
      layer: String(patch?.layer || ""),
    };
  });

  const counts = summarizePatchRows(rows);
  const statusEmpty = Object.keys(statusMap).length === 0;
  let exitCode = EXIT_OK;
  let reason = "";
  if (!rows.length) {
    exitCode = EXIT_ISSUES;
    reason = "no_patches";
  } else if (statusEmpty) {
    exitCode = EXIT_UNKNOWN_STATE;
    reason = hostLabel ? "patch_status_missing" : "host_not_located";
  } else if (counts.broken > 0 || counts.unknown > 0) {
    exitCode = EXIT_ISSUES;
    reason = "broken_or_unknown";
  }
  return {
    ok: exitCode === EXIT_OK,
    exitCode,
    reason,
    // 上游 selfCheck() 把 pending 也算「未通过」；这里按本任务的判定口径：只有 broken/unknown 让 ok 变 false，
    // 但把「点一次应用就能收尾」单独标出来，信息不丢。
    needs_apply: counts.pending > 0,
    counts,
    rows,
    issues: {
      broken: rows.filter((r) => r.category === "broken").map((r) => r.id),
      unknown: rows.filter((r) => r.category === "unknown").map((r) => r.id),
      pending: rows.filter((r) => r.category === "pending").map((r) => r.id),
    },
    host: hostLabel,
    dsh_home: String(dsh_home || ""),
    generated_at: generated_at || new Date().toISOString(),
  };
}

/** 从 core.gatherState() 的结果直接构造，省得调用方自己搬字段。 */
export function selfcheckFromState(state, { patches = [], generated_at = "" } = {}) {
  const source = state && typeof state === "object" ? state : {};
  return selfcheck({
    patch_status: source.patch_status,
    patches,
    host: source.host_version || source.ai_base || "",
    dsh_home: source.dsh_home || "",
    generated_at,
  });
}

/** 纯文本渲染：分类计数 + 逐条证据。 */
export function renderSelfcheck(report) {
  const counts = report.counts || {};
  const lines = [];
  lines.push("dsh-purge 自检 / selfcheck");
  lines.push(`  宿主 / host      ${report.host || "未定位 / not found"}`);
  lines.push(`  结论 / verdict   ${report.ok ? "OK" : `有问题 / issues（${report.reason || "unknown"}）`}`);
  lines.push(
    `  分类 / counts    已应用 ${counts.applied} · 待应用 ${counts.pending} · 不适用 ${counts.inactive}`
    + ` · 未知 ${counts.unknown} · 异常 ${counts.broken}（合计 ${counts.all}，需核对 ${counts.total}）`,
  );
  const statuses = Object.entries(counts.by_status || {})
    .map(([word, n]) => `${word}×${n}`)
    .join(", ");
  if (statuses) lines.push(`  原始状态词      ${statuses}`);
  if (report.needs_apply) lines.push(`  待应用          ${counts.pending} 条：跑 dsh-purge --apply 收尾（不计入失败）`);
  if (!report.rows.length) lines.push("", "  没有可核对的补丁：补丁表为空。");
  else {
    lines.push("", "  逐条 / rows");
    for (const row of report.rows) {
      const mark = MARKS[row.category] || "?";
      lines.push(
        `    ${mark} [#${String(row.id).padEnd(2)}] ${String(row.name).padEnd(32)}`
        + ` ${String(row.layer).padEnd(4)} ${row.status}${row.optional ? " (optional)" : ""}`,
      );
    }
  }
  if (report.exitCode !== EXIT_OK && report.reason === "host_not_located") {
    lines.push("", "  未定位宿主：状态表读不出来，所有补丁记为 unlocated。先跑 dsh-purge --status 看宿主根。");
  } else if (report.exitCode !== EXIT_OK && report.reason === "patch_status_missing") {
    lines.push("", "  读不到补丁状态：这次自检没有核对任何东西（不当作通过）。");
  } else if (counts.broken > 0 || counts.unknown > 0) {
    lines.push("", `  需处理：异常 #${report.issues.broken.join(", #") || "-"}；未知 #${report.issues.unknown.join(", #") || "-"}`);
    lines.push("  修法：dsh-purge diagnose --detail 看失配锚点，或 dsh-purge reanchor <id> --index <n> --text \"<片段>\"。");
  }
  return lines.join("\n");
}
