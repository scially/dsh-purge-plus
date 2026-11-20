// 更新通道完整性：下载产物在「解包 / 覆盖安装」之前先过这一关。
//
// 语义来源：
//   - 上游 lib/update-integrity.js：先钉死上游身份（commit/tree 摘要），再逐文件校验字节；
//   - 上游 lib/signed-sidecars.mjs：把「容器摘要 → 相对路径 → sha256」的固定摘要钉子当签名用。
// 本 fork 的下载链路是 codeload 直连 zip（没有发布 SHA256SUMS），所以这里收敛成一个入口：
//
//   verifyArtifact(file, { expectedSha256, sidecarPath }) -> verdict
//
// 约定（fail closed）：
//   ok:true  可以继续解包；signed:false 表示「只有未签名摘要」，signed:"unsupported" 表示
//            「侧车声明了签名，但本机没有钉死的可信公钥，无法做密码学验签」——如实上报，绝不假装验过。
//   ok:false 必须中止：不落盘、不解包、不执行安装。reason 说明具体原因。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";
import { normalizeDigest, parseSidecar } from "./signed-sidecars.mjs";

// 未显式指定 sidecarPath 时，按顺序找这些同目录候选（都不存在 = 没有侧车）。
const DEFAULT_SIDECAR_SUFFIXES = [".sha256", ".sidecar.json", ".sig"];

/** 摘要算法固定 sha256：与上游 signed-sidecars 的值域一致。 */
export function sha256Of(input) {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    hash.update(input);
    return hash.digest("hex");
  }
  const file = String(input || "");
  if (!file) throw new Error("空路径");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function integrityLogPath() {
  return path.join(findDshHome(), "dsh-purge", "update-integrity.log");
}

/** 一条 JSON 行。写不进去不能挡住更新流程，所以吞掉所有异常。 */
export function appendIntegrityLog(entry) {
  try {
    const file = integrityLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
    return file;
  } catch {
    return "";
  }
}

function emit(log, entry) {
  try {
    if (typeof log === "function") log(entry);
    else appendIntegrityLog(entry);
  } catch {
    // 记日志失败是次要问题，绝不能改变校验结论。
  }
}

/** 一句话结论，给错误信息用。 */
export function describeVerdict(verdict) {
  const parts = [`ok=${verdict.ok}`, `signed=${String(verdict.signed)}`, `method=${verdict.method}`];
  if (verdict.expected) parts.push(`expected=${verdict.expected}`);
  if (verdict.sha256) parts.push(`actual=${verdict.sha256}`);
  if (verdict.reason) parts.push(`reason=${verdict.reason}`);
  return parts.join(" ");
}

function sidecarCandidates(file) {
  return DEFAULT_SIDECAR_SUFFIXES.map((suffix) => `${file}${suffix}`);
}

/**
 * 校验一个下载产物。
 * @param {string|Buffer} file 产物路径（或内存字节）。
 * @param {object} [options]
 * @param {string} [options.expectedSha256] 期望摘要：有值时必须逐字节匹配，否则 ok:false。
 * @param {string} [options.sidecarPath] 侧车路径：显式指定但不存在 → ok:false（不静默降级为「未签名」）。
 * @param {Function} [options.log] 日志接收器；缺省写 $DSH_HOME/dsh-purge/update-integrity.log。
 */
export function verifyArtifact(file, { expectedSha256 = "", sidecarPath = "", log = null } = {}) {
  const notes = [];
  const isBuffer = Buffer.isBuffer(file) || file instanceof Uint8Array;
  const fileLabel = isBuffer ? "<buffer>" : String(file || "");
  let sidecarFile = "";
  let sidecarInfo = null;

  const done = (partial) => {
    const verdict = {
      ok: false,
      signed: false,
      sha256: "",
      expected: "",
      method: "none",
      reason: "",
      sidecar: null,
      notes,
      ...partial,
    };
    emit(log, {
      file: fileLabel,
      sidecar: sidecarFile,
      ok: verdict.ok,
      signed: verdict.signed,
      method: verdict.method,
      reason: verdict.reason,
      sha256: verdict.sha256,
      expected: verdict.expected,
    });
    return verdict;
  };

  let actual = "";
  try {
    actual = sha256Of(file);
  } catch (e) {
    return done({
      ok: false,
      reason: "artifact_unreadable",
      notes: [...notes, `读不到下载产物：${e && e.message ? e.message : e}`],
    });
  }

  const rawExpected = String(expectedSha256 || "").trim();
  const expected = normalizeDigest(rawExpected);
  if (rawExpected && !expected) {
    return done({
      ok: false,
      sha256: actual,
      reason: "bad_expected_sha256",
      notes: [...notes, `期望摘要不是 64 位 sha256：${rawExpected.slice(0, 80)}`],
    });
  }
  if (expected && expected !== actual) {
    return done({ ok: false, sha256: actual, expected, method: "sha256", reason: "sha256_mismatch" });
  }

  const explicit = String(sidecarPath || "").trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      return done({
        ok: false,
        sha256: actual,
        expected,
        reason: "sidecar_missing",
        notes: [...notes, `调用方指定了侧车但文件不存在：${explicit}`],
      });
    }
    sidecarFile = explicit;
  } else if (!isBuffer) {
    sidecarFile = sidecarCandidates(String(file || "")).find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) || "";
  }

  if (!sidecarFile) {
    // 常态：codeload zip 没有发布摘要。按「未签名」放行，但留一条日志当证据。
    return done({
      ok: true,
      signed: false,
      sha256: actual,
      expected,
      method: expected ? "sha256" : "none",
      notes: [...notes, "没有侧车：只记录了未签名的字节摘要，未做密码学验签"],
    });
  }

  let text = "";
  try {
    text = fs.readFileSync(sidecarFile, "utf8");
  } catch (e) {
    return done({
      ok: false,
      sha256: actual,
      expected,
      reason: "sidecar_unreadable",
      notes: [...notes, `侧车读不到：${e && e.message ? e.message : e}`],
    });
  }

  const parsed = parseSidecar(text, sidecarFile);
  sidecarInfo = {
    path: sidecarFile,
    form: parsed.form,
    algorithm: parsed.algorithm,
    signature: Boolean(parsed.signature),
    entries: [],
  };
  if (!parsed.ok) {
    return done({
      ok: false,
      sha256: actual,
      expected,
      reason: "sidecar_invalid",
      sidecar: sidecarInfo,
      notes: [...notes, `侧车无法解析：${parsed.reason}`],
    });
  }

  // 1) 单文件摘要侧车：侧车给出这个产物的 sha256。
  if (parsed.form === "digest-json" || parsed.form === "sha256sum") {
    const method = `sidecar-${parsed.form}`;
    if (expected && parsed.sha256 !== expected) {
      return done({
        ok: false,
        sha256: actual,
        expected,
        method,
        reason: "sidecar_expected_conflict",
        sidecar: sidecarInfo,
        notes: [...notes, `调用方期望 ${expected}，侧车声明 ${parsed.sha256}：两个来源打架，判定失败`],
      });
    }
    if (parsed.sha256 !== actual) {
      return done({
        ok: false,
        sha256: actual,
        expected: parsed.sha256,
        method,
        reason: "sidecar_mismatch",
        sidecar: sidecarInfo,
      });
    }
    if (parsed.signature) {
      return done({
        ok: true,
        signed: "unsupported",
        sha256: actual,
        expected: parsed.sha256,
        method,
        sidecar: sidecarInfo,
        notes: [...notes, `侧车带 signature（算法 ${parsed.algorithm || "未标注"}），但本机没有钉死的可信公钥：不做密码学验签，只按摘要比对`],
      });
    }
    return done({
      ok: true,
      signed: false,
      sha256: actual,
      expected: parsed.sha256,
      method,
      sidecar: sidecarInfo,
      notes: [...notes, "侧车只是摘要钉子（与上游 signed-sidecars 同性质），没有密码学签名"],
    });
  }

  // 2) 只有签名、没有任何摘要：没有任何可核验的东西，不能当「没问题」。
  if (parsed.form === "signature-only") {
    return done({
      ok: false,
      sha256: actual,
      expected,
      reason: "sidecar_no_digest",
      sidecar: sidecarInfo,
      notes: [...notes, "侧车只有签名没有摘要：无法核验字节，按失败处理"],
    });
  }

  // 3) 上游 pinned-map 形式：根摘要 → { 相对路径 → sha256 }，逐条比对同目录文件。
  const rootDigest = expected || actual;
  const table = parsed.roots.get(rootDigest);
  if (!table || !table.size) {
    return done({
      ok: false,
      sha256: actual,
      expected: rootDigest,
      reason: "sidecar_root_mismatch",
      sidecar: sidecarInfo,
      notes: [...notes, `侧车钉子覆盖不到这个产物（根摘要 ${rootDigest}）`],
    });
  }
  const baseDir = path.dirname(path.resolve(sidecarFile));
  const mismatches = [];
  for (const [rel, want] of table) {
    const row = { rel, want, got: "", ok: false };
    sidecarInfo.entries.push(row);
    const abs = path.resolve(baseDir, rel);
    if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) {
      mismatches.push({ rel, error: "路径越界" });
      continue;
    }
    try {
      row.got = sha256Of(abs);
    } catch {
      mismatches.push({ rel, error: "缺失或读不到" });
      continue;
    }
    if (row.got !== want) {
      mismatches.push({ rel, error: "摘要不一致" });
      continue;
    }
    row.ok = true;
  }
  if (mismatches.length) {
    return done({
      ok: false,
      sha256: actual,
      expected: rootDigest,
      method: "sidecar-pinned-map",
      reason: "sidecar_entry_mismatch",
      sidecar: sidecarInfo,
      notes: [...notes, `钉子条目不一致：${mismatches.slice(0, 5).map((m) => `${m.rel}(${m.error})`).join(", ")}`],
    });
  }
  return done({
    ok: true,
    signed: parsed.signature ? "unsupported" : false,
    sha256: actual,
    expected: rootDigest,
    method: "sidecar-pinned-map",
    sidecar: sidecarInfo,
    notes: [...notes, `侧车钉子 ${table.size} 条全部匹配（固定摘要，不是密码学签名）`],
  });
}
