// ZIP 解压只走 Node 读取器：外部工具分支已移除，几层保护不能被绕过。
//
// 背景（1.1.95 修）：本 fork 曾有 tar/unzip/python3/Expand-Archive 的回退链，
// 那条路径只做条目名检查，没有 maxEntries / maxBytes / CRC / 链接层级检查。
// 回退一旦生效（例如 tar 从 PATH 命中），保护会静默失效；而 tar/unzip 会把
// zip 里的符号链接如实建出来，"先建链接再往里写"就能写到 dest 之外。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const zipModule = await import(pathToFileURL(path.join(repo, "lib/zip-extract.js")).href);
const { extractZipArchive, extractZipBuffer } = zipModule;

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();
function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

/** 手搓一个 zip：只支持 store（method 0），够用来构造各种坏样本。 */
function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
		const crc = entry.crcOverride ?? crc32(data);
		const mode = entry.mode ?? 0o100644;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(0, 8); // store
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + data.length;
	}
	const centralBuf = Buffer.concat(centrals);
	const localBuf = Buffer.concat(locals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(localBuf.length, 16);
	return Buffer.concat([localBuf, centralBuf, eocd]);
}

function tmpdir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-zip-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("zip-extract: 外部解压工具回退已移除", () => {
	// 这个符号若被重新引入，多半说明 tar/unzip 回退链又回来了（那三层保护会失效）。
	assert.equal(typeof zipModule.unzipTools, "undefined", "unzipTools 应已删除");
	assert.equal(typeof extractZipArchive, "function");
	assert.equal(typeof extractZipBuffer, "function");
	assert.equal(typeof zipModule.safeArchiveName, "function");
});

test("zip-extract: extractZipArchive 始终返回 node，且与目录结构一致", (t) => {
	const dir = tmpdir(t);
	const zip = path.join(dir, "a.zip");
	fs.writeFileSync(zip, buildZip([
		{ name: "pkg/SKILL.md", data: "---\nname: p\n---\n" },
		{ name: "pkg/sub/a.txt", data: "a" },
	]));
	const dest = path.join(dir, "out");
	assert.equal(extractZipArchive(zip, dest), "node");
	assert.ok(fs.existsSync(path.join(dest, "pkg", "SKILL.md")));
	assert.ok(fs.existsSync(path.join(dest, "pkg", "sub", "a.txt")));
});

test("zip-extract: 链接条目被拒绝，且不会先建出链接", (t) => {
	const dir = tmpdir(t);
	const zip = path.join(dir, "link.zip");
	fs.writeFileSync(zip, buildZip([
		{ name: "pkg/esc", data: "../../outside", mode: 0o120777 },
		{ name: "pkg/esc/x", data: "pwn" },
	]));
	const dest = path.join(dir, "out");
	assert.throws(() => extractZipArchive(zip, dest), /链接条目/);
	assert.equal(fs.existsSync(path.join(dest, "pkg", "esc")), false);
});

test("zip-extract: 已经存在的链接祖先也被拒绝（不穿链接写）", (t) => {
	const dir = tmpdir(t);
	const dest = path.join(dir, "out");
	const outside = path.join(dir, "outside");
	fs.mkdirSync(path.join(dest, "pkg"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	// dest/pkg/esc 预先是一个指向 dest 之外的链接
	try {
		fs.symlinkSync(outside, path.join(dest, "pkg", "esc"), "junction");
	} catch {
		t.skip("当前环境不允许创建链接");
		return;
	}
	const zip = path.join(dir, "pre.zip");
	fs.writeFileSync(zip, buildZip([{ name: "pkg/esc/x.txt", data: "pwn" }]));
	assert.throws(() => extractZipArchive(zip, dest), /symbolic link|链接/);
	assert.equal(fs.existsSync(path.join(outside, "x.txt")), false, "不能写到 dest 之外");
});

test("zip-extract: maxEntries 生效", (t) => {
	const dir = tmpdir(t);
	const zip = path.join(dir, "many.zip");
	fs.writeFileSync(zip, buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))));
	assert.throws(() => extractZipArchive(zip, path.join(dir, "out"), { maxEntries: 3 }), /文件太多/);
});

test("zip-extract: maxBytes 生效（解压炸弹在这里被截断）", (t) => {
	const dir = tmpdir(t);
	const zip = path.join(dir, "big.zip");
	fs.writeFileSync(zip, buildZip([{ name: "a.bin", data: Buffer.alloc(4096, 0x41) }]));
	assert.throws(() => extractZipArchive(zip, path.join(dir, "out"), { maxBytes: 1024 }), /超出大小上限/);
});

test("zip-extract: verifyCrc 是可选项", (t) => {
	const dir = tmpdir(t);
	const zip = path.join(dir, "badcrc.zip");
	fs.writeFileSync(zip, buildZip([{ name: "pkg/a.txt", data: "hello", crcOverride: 0xdeadbeef }]));
	assert.throws(() => extractZipArchive(zip, path.join(dir, "out"), { verifyCrc: true }), /CRC 校验失败/);
	assert.doesNotThrow(() => extractZipArchive(zip, path.join(dir, "out2"), { verifyCrc: false }));
});

test("zip-extract: 重复路径被拒绝", (t) => {
	const dir = tmpdir(t);
	const bytes = buildZip([
		{ name: "pkg/a.txt", data: "1" },
		{ name: "pkg/a.txt", data: "2" },
	]);
	fs.writeFileSync(path.join(dir, "dup.zip"), bytes);
	assert.throws(() => extractZipArchive(path.join(dir, "dup.zip"), path.join(dir, "out")), /重复路径/);
	assert.throws(() => extractZipBuffer(bytes, path.join(dir, "out2")), /重复路径/);
});

test("zip-extract: 危险条目名（zip-slip / ADS / Windows 保留名）被拒绝", (t) => {
	const dir = tmpdir(t);
	for (const name of ["../evil.txt", "pkg/../evil.txt", "/abs.txt", "C:/abs.txt", "pkg/a.txt:ads", "con.txt", "pkg/trail."]) {
		const bytes = buildZip([{ name, data: "x" }]);
		assert.throws(() => extractZipBuffer(bytes, path.join(dir, `o-${Math.random().toString(16).slice(2)}`)), /不合法/, `应拒绝：${name}`);
	}
});
