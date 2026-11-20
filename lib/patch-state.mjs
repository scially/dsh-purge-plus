// 补丁状态 → 分类：从上游 lib/patch-state.mjs 移植过来的最小映射（纯函数，不碰文件系统）。
//
// 上游只有 inactive / applied / pending / unknown / broken 五类，本模块保持一致，
// 但状态词表换成**本 fork 实际会吐出的词**（lib/core.js 的 patchStatus / rollupPatchStatus
// / hooks-deny 标注）：applied、already、pending、drifted、unmatched、skipped、missing_file、
// na、off、pattern_not_found、hit_count_mismatch:<n>，以及 lastError 直接回传的错误文本。
//
// 映射表（也是 fail-closed 的依据：认不出来的词一律不算通过）：
//   applied / already                         → applied   已落盘
//   pending                                   → pending   还没打上，点一次「应用」即可
//   na / off / disabled / not_needed           → inactive  明确不适用（宿主版本/组开关/平台）
//   missing_file                               → inactive  本机根本没有它的目标文件（组件/预设未装）：
//                                             core.patchStatusReady 也把 missing_file 算「已就绪」，
//                                             不能把它当损坏，否则干净机器也会被自检判红
//   skipped + (optional 或自标记型补丁)         → inactive  真正无需处理
//   skipped（其它）                            → unknown   中立态：文件在、原文对不上、又没有本插件痕迹，
//                                             既不能证明已生效，也不能断言坏了
//   pattern_not_found / hit_count_mismatch:* + optional → inactive 可选目标没命中，不算失败
//   pattern_not_found / hit_count_mismatch:*（其它）    → broken   锚点没对上/命中次数不对
//   drifted / unmatched                        → broken    官方原文已改，锚点要更新
//   空 / "?" / unknown / unreadable / unlocated → unknown   没有可信状态
//   其它没见过的词                              → unknown   fail closed：不认识就不许报 ok
//   Node 风格错误文本（EACCES: / EPERM: 等）    → broken    写失败（lastError 直接回传的错误）

const INACTIVE_WORDS = new Set(["na", "off", "disabled", "not_needed"]);
const APPLIED_WORDS = new Set(["applied", "already"]);
const PENDING_WORDS = new Set(["pending", "not_applied", "todo"]);
const UNKNOWN_WORDS = new Set(["", "?", "unknown", "unreadable", "unlocated", "-"]);
const BROKEN_WORDS = new Set(["drifted", "unmatched"]);
const HARD_ANCHOR_WORDS = new Set(["pattern_not_found"]);

function hasAnchorMismatch(status) {
  return HARD_ANCHOR_WORDS.has(status) || status.startsWith("hit_count_mismatch:");
}

/** 写失败时 lastError 会把 Node 的原始错误文本塞进状态位（例如 EACCES: permission denied）。 */
function looksLikeWriteError(status) {
  return /^(E[A-Z]+:|[A-Z]+_ERR|Error:|TypeError:)/.test(status);
}

/** 上游同名函数：这条补丁在当前状态下是否属于「明确不适用」。 */
export function patchNotApplicable(patch, status) {
  const word = String(status ?? "");
  if (INACTIVE_WORDS.has(word)) return true;
  if (word === "missing_file") return true;
  // settleWhenAbsent 是上游字段；本 fork 没有用它，但保留语义以便兼容上游补丁表。
  if (word === "skipped") return patch?.optional === true || patch?.settleWhenAbsent === true || patch?.selfMarked === true;
  if (hasAnchorMismatch(word)) return patch?.optional === true;
  return false;
}

/** 五分类映射。未知/异常一律不折叠成成功。 */
export function patchStateCategory(patch, status) {
  const word = String(status ?? "").trim();
  if (patchNotApplicable(patch, word)) return "inactive";
  if (APPLIED_WORDS.has(word)) return "applied";
  if (PENDING_WORDS.has(word)) return "pending";
  if (hasAnchorMismatch(word)) return "broken";
  if (BROKEN_WORDS.has(word)) return "broken";
  if (looksLikeWriteError(word)) return "broken";
  if (UNKNOWN_WORDS.has(word)) return "unknown";
  return "unknown";
}

/** 分类计数。all = 全部补丁；total = 扣掉 inactive 后真正需要核对的补丁。 */
export function summarizePatchRows(rows) {
  const out = {
    all: 0,
    total: 0,
    applied: 0,
    pending: 0,
    inactive: 0,
    unknown: 0,
    broken: 0,
    optional: 0,
    required: 0,
    by_status: {},
  };
  for (const row of rows || []) {
    const status = String(row?.status ?? "");
    const category = patchStateCategory(row, status);
    out.all += 1;
    out[category] += 1;
    if (category !== "inactive") out.total += 1;
    if (row?.optional === true) out.optional += 1;
    else out.required += 1;
    out.by_status[status || "(空)"] = (out.by_status[status || "(空)"] || 0) + 1;
  }
  return out;
}
