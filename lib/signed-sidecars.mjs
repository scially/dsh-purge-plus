// 侧车（sidecar）摘要钉子：从上游 lib/signed-sidecars.mjs 移植过来的最小语义。
//
// 上游的形状是 Map<容器摘要, Map<相对路径, sha256>>：
//   键 = 容器（安装包 / asar 头）的摘要；内层键 = 精确相对路径；内层值 = 该文件完整字节的 sha256。
// 上游既没有公钥也没有验签代码 —— 它所谓的「签名」= 随插件一起发布、无法被下载通道篡改的固定摘要。
//
// 本模块保留同样的形状与查找语义（纯函数，不碰文件系统），并额外识别两种单文件侧车：
//   1) digest-json : {"sha256":"<hex>","signature":"...","algorithm":"..."}
//   2) sha256sum   : "<hex>  <文件名>"（sha256sum 的输出格式）
// 真密码学验签需要「钉死的可信公钥 + 签名格式」，本 fork 没有可信锚点：
// 遇到签名只回报 signed:"unsupported"，绝不假装验过（判定逻辑在 update-integrity.js）。

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 随本 fork 发布的固定摘要钉子。
 * 当前为空 Map：我们还没有任何一条 release 用它发布侧车（更新通道走 codeload zip，
 * 没有发布过 SHA256SUMS）。保留结构，发布侧车时往这里加即可。
 */
export const signedSidecars = new Map();

/** 归一化摘要写法：去掉 sha256: / SHA256( ) 包装与空白，只认 64 位小写十六进制。 */
export function normalizeDigest(value) {
  if (typeof value !== "string") return "";
  const text = value.trim().toLowerCase().replace(/^sha256[:(]\s*/, "").replace(/[)\]]+$/, "");
  return HEX64.test(text) ? text : "";
}

/** 把「上游 Map 形状」与「JSON 普通对象形状」统一成 Map<rootDigest, Map<relPath, digest>>。 */
export function normalizeRoots(raw) {
  const roots = raw instanceof Map ? raw : new Map(Object.entries(raw || {}));
  const out = new Map();
  for (const [rootDigest, entries] of roots) {
    const root = normalizeDigest(String(rootDigest));
    if (!root) continue;
    const inner = entries instanceof Map ? entries : new Map(Object.entries(entries || {}));
    const map = new Map();
    for (const [relPath, digest] of inner) {
      const value = normalizeDigest(typeof digest === "string" ? digest : digest?.sha256);
      if (value) map.set(String(relPath).replace(/\\/g, "/"), value);
    }
    if (map.size) out.set(root, map);
  }
  return out;
}

/** 上游同形状的查找：先按根摘要命中，再取精确相对路径；任一步落空都返回 ""。 */
export function lookupPinnedDigest(roots, rootDigest, relPath) {
  const root = normalizeDigest(String(rootDigest || ""));
  const rel = String(relPath || "").replace(/\\/g, "/");
  if (!root || !rel) return "";
  const entries = normalizeRoots(roots).get(root);
  return entries ? (entries.get(rel) || "") : "";
}

/**
 * 解析一份侧车文本。
 * @returns {{ok:boolean, form:string, roots:Map, sha256:string, signature:string, algorithm:string, reason:string, name:string}}
 *   form: pinned-map | digest-json | sha256sum | signature-only | invalid
 */
export function parseSidecar(text, name = "") {
  const base = { ok: false, form: "invalid", roots: new Map(), sha256: "", signature: "", algorithm: "", reason: "", name: String(name || "") };
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { ...base, reason: "sidecar_empty" };
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ...base, reason: `sidecar_json_invalid: ${e.message}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...base, reason: "sidecar_json_not_object" };
    }
    // 签名/算法字段在两种 JSON 形式里都可能出现，先取出来。
    const signature = String(parsed.signature || parsed.sig || parsed.ed25519 || "").trim();
    const algorithm = String(parsed.algorithm || parsed.algo || "").trim();
    const declared = normalizeDigest(parsed.sha256 || parsed.digest || parsed.hash || "");
    const values = Object.values(parsed);
    const looksPinned = values.length > 0 && values.every((v) => v && typeof v === "object" && !Array.isArray(v));
    if (looksPinned) {
      const roots = normalizeRoots(parsed);
      if (!roots.size) return { ...base, reason: "sidecar_pinned_map_empty" };
      return { ...base, ok: true, form: "pinned-map", roots, signature, algorithm };
    }
    if (declared) return { ...base, ok: true, form: "digest-json", sha256: declared, signature, algorithm };
    if (signature) return { ...base, ok: true, form: "signature-only", signature, algorithm };
    return { ...base, reason: "sidecar_no_digest_field" };
  }
  // sha256sum 形式：第一行 "<hex>  <name>"（第二个字段的前导 * 是二进制模式标记）。
  const line = raw.split("\n").find((item) => item.trim());
  const hit = line && line.match(/^([0-9a-fA-F]{64})\s+\*?(.*)$/);
  if (hit) return { ...base, ok: true, form: "sha256sum", sha256: hit[1].toLowerCase(), name: hit[2].trim() || base.name };
  return { ...base, reason: "sidecar_unrecognized" };
}
