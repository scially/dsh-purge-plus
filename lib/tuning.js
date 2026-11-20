/**
 * 插件自有的调参状态（$DSH_HOME/dsh-purge/tuning.json）。
 *
 * 为什么不写进 profile 的 YAML：开关是插件自己的运行状态，改一个值不该要求动宿主文件、
 * 更不该等 profile 重启；tuning.json 是纯数据，`dsh plugin add` / 热重载都不会把它带走。
 *
 * 容错口径（apply 路径不能因为一份数据文件起不来）：
 *   - 文件不存在 / JSON 坏 / 顶层不是对象 → 整份走 TUNING_DEFAULTS，绝不抛；
 *   - 单个字段类型不对（`inject: 5`、`boost: "no"`）→ 该字段走默认，其余字段照读；
 *   - 读取只认白名单字段；writeTuning 回写时把文件里未知字段原样保留，不丢用户手写内容。
 */
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";
import { atomicWriteSync } from "./atomic-files.js";

export const TUNING_FILE = "tuning.json";

/** 注入正文的落点：head=系统提示词最前；tail=宿主段之后、尾部锚点之前；both=两头各钉一份。 */
export const INJECT_POSITIONS = Object.freeze(["head", "tail", "both"]);

/**
 * 默认值。
 *   boost —— 强化段默认开（移植过来的功能本身；关法见 boost.js）。
 *   inject —— 默认 **head**：注入正文照旧钉在系统提示词最前。这既是社区版
 *     `TUNING_DEFAULTS.injectPosition` 的默认，也是本 fork 移植前的实际观感；
 *     想试「尾部注入」（紧贴输出、多轮衰减更小）写成 `{"inject":"tail"}` 即可，
 *     两头都钉用 `both`。改默认值等于替用户换提示词形态，不做。
 *   refusalRetry / refusalDecompose / refusalSeed —— 与本 fork 现行行为一致（三臂全开）。
 *     注意：社区版 TUNING_DEFAULTS.refusalRetry 是 false（那边默认不重试）；本 fork 默认重试，
 *     这里写 true，否则「读到的默认值」会和「实际行为」相反。
 */
export const TUNING_DEFAULTS = Object.freeze({
  boost: true,
  inject: "head",
  refusalRetry: true,
  refusalDecompose: true,
  refusalSeed: true,
});

const BOOLEAN_KEYS = Object.freeze(["boost", "refusalRetry", "refusalDecompose", "refusalSeed"]);

function resolveHome(dshHome) {
  if (dshHome && String(dshHome).trim()) return String(dshHome).trim();
  try { return findDshHome() || ""; } catch { return ""; }
}

/** $DSH_HOME/dsh-purge/tuning.json；定位不到主目录时返回空串。 */
export function tuningPath(dshHome) {
  const home = resolveHome(dshHome);
  return home ? path.join(home, "dsh-purge", TUNING_FILE) : "";
}

/** 合法落点直接用；其余（含 undefined / null / 数字）回默认。 */
export function normalizeInjectPosition(value) {
  return INJECT_POSITIONS.includes(value) ? value : TUNING_DEFAULTS.inject;
}

/** 原样读出文件对象；读不到 / 坏 JSON / 非对象一律 null（调用方按默认处理）。 */
function readTuningRaw(dshHome) {
  const file = tuningPath(dshHome);
  if (!file) return null;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

/**
 * 读调参。永不抛：坏文件、坏字段一律回默认。
 * 兼容社区版的 `injectPosition`：`inject` 合法时优先，否则退回别名，两个都不合法用默认。
 */
export function readTuning(dshHome) {
  const out = { ...TUNING_DEFAULTS };
  const saved = readTuningRaw(dshHome);
  if (!saved) return out;
  for (const key of BOOLEAN_KEYS) {
    if (typeof saved[key] === "boolean") out[key] = saved[key];
  }
  const position = [saved.inject, saved.injectPosition].find((value) => INJECT_POSITIONS.includes(value));
  if (position) out.inject = position;
  return out;
}

/** 只把认识且合法的字段收进 patch：手写错值不落盘，别把状态带歪。 */
function sanitizePatch(patch) {
  const src = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const out = {};
  for (const key of BOOLEAN_KEYS) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  const position = [src.inject, src.injectPosition].find((value) => INJECT_POSITIONS.includes(value));
  if (position) out.inject = position;
  return out;
}

/**
 * 原子落盘：同目录临时文件 + rename 退避，实现统一在 lib/atomic-files.js。
 * 旧实现「rename 失败就直接覆盖目标」有两个问题：覆盖不是原子的（别人可能读到半个文件），
 * 而且失败时目标字节已经变了。现在被占用就退避重试，重试耗尽抛错、目标保持原样。
 */
function writeFileAtomic(file, text) {
  atomicWriteSync(file, text, "utf8", { mode: 0o600 });
}

/**
 * 合并写入并返回生效值（不是入参：坏值会被 readTuning 归一到默认）。
 * 未知字段（社区版留下的 permissionPatches / extraPatches 等）原样保留。
 */
export function writeTuning(patch = {}, dshHome) {
  const file = tuningPath(dshHome);
  if (!file) throw new Error("未定位 DSH 数据目录（$DSH_HOME），无法保存 tuning");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...(readTuningRaw(dshHome) || {}), ...sanitizePatch(patch) };
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return readTuning(dshHome);
}
