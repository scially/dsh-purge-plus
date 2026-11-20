/** 文件系统包含关系判定（含 junction 与"尚未创建的后代"）。
 *
 * 来源：社区版 `lib/path-boundary.js`（1.7.x）。本 fork 原先没有这个模块，
 * zip 解压只做了条目名检查；这个模块补上"祖先里有没有符号链接/联接点"这一层。
 */
import fs from "node:fs";
import path from "node:path";

/** target 是否落在 root 之内（按词法比较，不解析链接）。 */
export function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep));
}

/** 把 target 解析成"真实路径 + 还不存在的尾巴"；中途遇到链接就按真实目标走。 */
export function realDestination(target, io = fs) {
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    let stat;
    try {
      stat = io.lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    // 悬空链接不是"缺失目录"：realpath 必须显式失败，不能当成空目录放过去。
    if (missing.length && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw Object.assign(new Error(`Not a directory: ${cursor}`), { code: "ENOTDIR" });
    }
    return path.resolve(io.realpathSync(cursor), ...missing);
  }
}

/** target 的**真实**位置必须落在任一允许根之下。 */
export function assertWithinRoots(target, allowedRoots, io = fs) {
  if (typeof target !== "string" || !target.trim() || target.includes("\0")) throw new Error("Invalid resource path");
  const abs = path.resolve(target);
  const roots = (allowedRoots || []).filter((r) => typeof r === "string" && r.trim()).map((r) => path.resolve(r));
  const candidates = roots.filter((root) => within(root, abs));
  if (candidates.length) {
    const real = realDestination(abs, io);
    if (candidates.some((root) => within(realDestination(root, io), real))) return abs;
  }
  throw new Error(`path outside allowed roots: ${abs}`);
}

/**
 * 解压前逐级检查：root → target 路径上的每一段都不能是符号链接。
 * 解压必须经过已存在的链接（哪怕链接目标也在 root 内）也一律拒绝 ——
 * 攻击者可以先放一个 `pkg/esc -> ../../outside` 再往里写文件。
 */
export function assertNoLinkedDescendants(root, target, io = fs) {
  root = path.resolve(root);
  target = path.resolve(target);
  if (!within(root, target)) throw new Error(`Extraction path outside destination: ${target}`);
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i <= parts.length; i++) {
    if (i) cursor = path.join(cursor, parts[i - 1]);
    try {
      if (io.lstatSync(cursor).isSymbolicLink()) throw new Error(`Extraction path is a symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
