// 更新通道完整性：下载产物在「解包 / 覆盖安装」之前必须过 sha256 / 侧车校验。
// 全部用本地临时文件当「下载产物」，不联网、不触发真实更新。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrity = await import(pathToFileURL(path.join(repo, "lib", "update-integrity.js")).href);
const sidecars = await import(pathToFileURL(path.join(repo, "lib", "signed-sidecars.mjs")).href);
const update = await import(pathToFileURL(path.join(repo, "lib", "update.js")).href);
const { verifyArtifact, sha256Of, describeVerdict } = integrity;
const { parseSidecar, lookupPinnedDigest } = sidecars;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${name}-`));
}

/** 收集日志，避免测试往真实 $DSH_HOME 里写日志。 */
function collector() {
  const entries = [];
  return { entries, log: (entry) => entries.push(entry) };
}

test("update-integrity: 期望摘要匹配 → ok，未签名且写一条日志", async () => {
  const dir = tmpdir("integrity-ok");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "fake zip bytes 一份");
  const digest = sha256Of(file);
  const { entries, log } = collector();
  const verdict = await verifyArtifact(file, { expectedSha256: digest, log });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signed, false);
  assert.equal(verdict.sha256, digest);
  assert.equal(verdict.reason, "");
  assert.equal(verdict.method, "sha256");
  assert.equal(entries.length, 1, "每次校验都要落一条日志");
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].signed, false);
});

test("update-integrity: 期望摘要不匹配 → ok:false，不放过", async () => {
  const dir = tmpdir("integrity-bad-sha");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "fake zip bytes 另一份");
  const verdict = await verifyArtifact(file, { expectedSha256: SHA_A, log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sha256_mismatch");
  assert.equal(verdict.expected, SHA_A);
  assert.equal(verdict.sha256, sha256Of(file));
  assert.match(describeVerdict(verdict), /sha256_mismatch/);
});

test("update-integrity: 期望摘要写成 sha256: 前缀也能归一化", async () => {
  const dir = tmpdir("integrity-prefix");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "prefix");
  const verdict = await verifyArtifact(file, { expectedSha256: `sha256:${sha256Of(file)}`, log: () => {} });
  assert.equal(verdict.ok, true);
});

test("update-integrity: 期望摘要格式不对 → 判失败（不猜）", async () => {
  const dir = tmpdir("integrity-bad-expected");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "x");
  const verdict = await verifyArtifact(file, { expectedSha256: "zzzz", log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad_expected_sha256");
});

test("update-integrity: 没有侧车 → ok:true, signed:false 并记一条日志", async () => {
  const dir = tmpdir("integrity-unsigned");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "unsigned payload");
  const { entries, log } = collector();
  const verdict = await verifyArtifact(file, { log });
  assert.deepEqual({ ok: verdict.ok, signed: verdict.signed, method: verdict.method }, { ok: true, signed: false, method: "none" });
  assert.match(verdict.notes.join(" "), /没有侧车/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sidecar, "");
});

test("update-integrity: 产物读不到 → artifact_unreadable（不是抛异常）", async () => {
  const dir = tmpdir("integrity-missing");
  const verdict = await verifyArtifact(path.join(dir, "nope.zip"), { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "artifact_unreadable");
});

test("update-integrity: 显式指定的侧车不存在 → 失败，不静默降级成「未签名」", async () => {
  const dir = tmpdir("integrity-sidecar-missing");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "payload");
  const verdict = await verifyArtifact(file, { sidecarPath: path.join(dir, "ghost.sha256"), log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_missing");
});

test("update-integrity: 侧车摘要不一致（坏签名/被换过的字节）→ sidecar_mismatch", async () => {
  const dir = tmpdir("integrity-sidecar-bad");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "tampered payload");
  fs.writeFileSync(`${file}.sha256`, `${SHA_A}  plugin.zip\n`);
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_mismatch");
  assert.equal(verdict.sidecar.form, "sha256sum");
});

test("update-integrity: sha256sum 侧车匹配 → ok:true（摘要钉子，没有密码学签名）", async () => {
  const dir = tmpdir("integrity-sidecar-good");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "clean payload");
  fs.writeFileSync(`${file}.sha256`, `${sha256Of(file)} *plugin.zip\n`);
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signed, false);
  assert.equal(verdict.method, "sidecar-sha256sum");
});

test("update-integrity: 侧车带 signature 但本机无公钥 → signed:\"unsupported\"，不假装验过", async () => {
  const dir = tmpdir("integrity-signature");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "signed payload");
  fs.writeFileSync(
    `${file}.sidecar.json`,
    JSON.stringify({ sha256: sha256Of(file), algorithm: "ed25519", signature: "AAAA" }, null, 2),
  );
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signed, "unsupported");
  assert.equal(verdict.method, "sidecar-digest-json");
  assert.match(verdict.notes.join(" "), /没有钉死的可信公钥/);
});

test("update-integrity: 只有签名没有摘要的侧车 → 判失败（没有可核验的东西）", async () => {
  const dir = tmpdir("integrity-signature-only");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "payload");
  fs.writeFileSync(`${file}.sidecar.json`, JSON.stringify({ signature: "AAAA", algorithm: "ed25519" }));
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_no_digest");
});

test("update-integrity: 侧车 JSON 坏了 → sidecar_invalid（fail closed）", async () => {
  const dir = tmpdir("integrity-sidecar-invalid");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "payload");
  fs.writeFileSync(`${file}.sidecar.json`, "{ 这不是 json");
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_invalid");
});

test("update-integrity: 上游 pinned-map 侧车逐条比对同目录文件", async () => {
  const dir = tmpdir("integrity-pinned");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "container bytes");
  fs.mkdirSync(path.join(dir, "lib"));
  const member = path.join(dir, "lib", "index.js");
  fs.writeFileSync(member, "member bytes");
  const root = sha256Of(file);
  const sidecar = `${file}.sidecar.json`;
  fs.writeFileSync(sidecar, JSON.stringify({ [root]: { "lib/index.js": sha256Of(member) } }, null, 2));
  const good = await verifyArtifact(file, { log: () => {} });
  assert.equal(good.ok, true);
  assert.equal(good.method, "sidecar-pinned-map");
  assert.equal(good.sidecar.entries.length, 1);
  assert.equal(good.sidecar.entries[0].ok, true);
  // 成员文件被改 → 必须失败
  fs.writeFileSync(member, "member bytes 被改过");
  const bad = await verifyArtifact(file, { log: () => {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "sidecar_entry_mismatch");
  // 成员文件被删 → 也必须失败
  fs.unlinkSync(member);
  const gone = await verifyArtifact(file, { log: () => {} });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, "sidecar_entry_mismatch");
});

test("update-integrity: pinned-map 的根摘要不覆盖这个产物 → sidecar_root_mismatch", async () => {
  const dir = tmpdir("integrity-pinned-root");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "container bytes");
  fs.writeFileSync(`${file}.sidecar.json`, JSON.stringify({ [SHA_B]: { "lib/index.js": SHA_A } }));
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_root_mismatch");
});

test("update-integrity: pinned-map 条目路径越界 → 判失败，不读目录外的文件", async () => {
  const dir = tmpdir("integrity-pinned-escape");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "container bytes");
  const outside = path.join(dir, "..", "outside.txt");
  fs.writeFileSync(outside, "outside");
  fs.writeFileSync(`${file}.sidecar.json`, JSON.stringify({ [sha256Of(file)]: { "../outside.txt": sha256Of(outside) } }));
  const verdict = await verifyArtifact(file, { log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sidecar_entry_mismatch");
  assert.equal(verdict.sidecar.entries[0].ok, false);
  assert.match(verdict.notes.join(" "), /路径越界/);
  fs.rmSync(outside, { force: true });
});

test("update-integrity: 期望摘要与侧车声明打架 → sidecar_expected_conflict", async () => {
  const dir = tmpdir("integrity-conflict");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "payload");
  fs.writeFileSync(`${file}.sidecar.json`, JSON.stringify({ sha256: sha256Of(file) }));
  const verdict = await verifyArtifact(file, { expectedSha256: sha256Of(file), sidecarPath: "" , log: () => {} });
  assert.equal(verdict.ok, true, "两者一致时应当通过");
  fs.writeFileSync(`${file}.sidecar.json`, JSON.stringify({ sha256: SHA_B }));
  const clash = await verifyArtifact(file, { expectedSha256: sha256Of(file), log: () => {} });
  assert.equal(clash.ok, false);
  assert.equal(clash.reason, "sidecar_expected_conflict");
});

test("update-integrity: 文件损坏（截断）→ 摘要对不上", async () => {
  const dir = tmpdir("integrity-truncated");
  const file = path.join(dir, "plugin.zip");
  fs.writeFileSync(file, "完整的一包字节内容");
  const digest = sha256Of(file);
  fs.writeFileSync(file, "完整的一包"); // 截断
  const verdict = await verifyArtifact(file, { expectedSha256: digest, log: () => {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sha256_mismatch");
});

test("update-integrity: 内存字节也能校验", async () => {
  const buf = Buffer.from("in-memory payload");
  const verdict = await verifyArtifact(buf, { expectedSha256: sha256Of(buf), log: () => {} });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.notes.join(" ").includes("没有侧车"), true);
});

test("signed-sidecars: sha256sum / digest-json / pinned-map 三种形式都能解析", () => {
  assert.equal(parseSidecar(`${SHA_A}  a.zip`).form, "sha256sum");
  assert.equal(parseSidecar(JSON.stringify({ sha256: SHA_A })).form, "digest-json");
  assert.equal(parseSidecar(JSON.stringify({ [SHA_A]: { "a.js": SHA_B } })).form, "pinned-map");
  assert.equal(parseSidecar(JSON.stringify({ signature: "x" })).form, "signature-only");
  assert.equal(parseSidecar("not a sidecar").ok, false);
  const roots = parseSidecar(JSON.stringify({ [SHA_A]: { "a.js": SHA_B } })).roots;
  assert.equal(lookupPinnedDigest(roots, SHA_A, "a.js"), SHA_B);
  assert.equal(lookupPinnedDigest(roots, SHA_B, "a.js"), "");
});

test("update.js: 校验闸门在解包之前（源码顺序），失败时抛错且不动目标目录", async () => {
  const source = fs.readFileSync(path.join(repo, "lib", "update.js"), "utf8");
  const gate = source.indexOf("await verifyDownloadedArtifact(zip, integrity)");
  const extract = source.indexOf("extractZip(zip, tmp)");
  assert.ok(gate > 0 && extract > gate, "校验必须排在解包之前");

  const dir = tmpdir("wire");
  const artifact = path.join(dir, "plugin.zip");
  fs.writeFileSync(artifact, "下载产物");
  const dest = path.join(dir, "dest");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "client.js"), "旧文件");
  await assert.rejects(
    () => update.verifyDownloadedArtifact(artifact, { expectedSha256: SHA_A }, () => {}),
    /下载产物完整性校验失败/,
  );
  assert.equal(fs.readFileSync(path.join(dest, "client.js"), "utf8"), "旧文件", "校验失败不许碰目标目录");
  const verdict = await update.verifyDownloadedArtifact(artifact, { expectedSha256: sha256Of(artifact) }, () => {});
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sha256, sha256Of(artifact));
});
