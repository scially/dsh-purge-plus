/**
 * boost / tuning 两个数据模块：默认值、读写、坏文件容错、段位覆盖优先级。
 * 一律用临时 DSH_HOME + 显式 env，不碰真宿主、也不碰本机真实主目录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BOOST_ENV,
  BOOST_ORDER_ENV,
  BOOST_SECTION,
  BOOST_STATE,
  BOOST_TEXT,
  DEFAULT_BOOST_ORDER,
  readBoost,
  readBoostOrder,
  writeBoost,
} from "../lib/boost.js";
import {
  INJECT_POSITIONS,
  TUNING_DEFAULTS,
  readTuning,
  tuningPath,
  writeTuning,
} from "../lib/tuning.js";

/** 每个用例一份隔离主目录，结束后删掉。 */
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-boost-"));
  t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
  });
  return home;
}

/** env 一律显式传入：本机环境里真设了这两个变量也不该影响断言。 */
const NO_ENV = Object.freeze({});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function purgeDir(home) {
  return path.join(home, "dsh-purge");
}

test("tuning: 没有文件时读出来就是默认值（boost 开、inject head）", (t) => {
  const home = tempHome(t);
  assert.deepEqual(readTuning(home), { ...TUNING_DEFAULTS });
  assert.equal(TUNING_DEFAULTS.boost, true);
  // 默认 head = 社区版默认值，也是本 fork 移植前的观感；tail/both 是可选形态。
  assert.equal(TUNING_DEFAULTS.inject, "head");
  assert.deepEqual([...INJECT_POSITIONS], ["head", "tail", "both"]);
});

test("tuning: 合法字段被采纳，未知字段不参与合并", (t) => {
  const home = tempHome(t);
  writeJson(tuningPath(home), {
    boost: false,
    inject: "both",
    refusalRetry: false,
    refusalSeed: false,
    // 社区版字段：本 fork 不认识，读的时候不能掺进结果。
    permissionPatches: false,
    extraPatches: [18],
  });
  const tuning = readTuning(home);
  assert.equal(tuning.boost, false);
  assert.equal(tuning.inject, "both");
  assert.equal(tuning.refusalRetry, false);
  assert.equal(tuning.refusalSeed, false);
  assert.equal(tuning.refusalDecompose, true, "没写的字段走默认");
  assert.equal(Object.hasOwn(tuning, "permissionPatches"), false);
  assert.equal(Object.hasOwn(tuning, "extraPatches"), false);
});

test("tuning: 坏 JSON / 坏类型 / 非对象都回默认，不抛", (t) => {
  const home = tempHome(t);
  fs.mkdirSync(purgeDir(home), { recursive: true });
  fs.writeFileSync(tuningPath(home), "{ this is not json", "utf8");
  assert.deepEqual(readTuning(home), { ...TUNING_DEFAULTS }, "坏 JSON 整份走默认");

  writeJson(tuningPath(home), { boost: "no", inject: 5, refusalRetry: "yes", refusalDecompose: null });
  const tuning = readTuning(home);
  assert.equal(tuning.boost, true, "坏类型走默认");
  assert.equal(tuning.inject, "head", "坏类型走默认（head）");
  assert.equal(tuning.refusalRetry, true);
  assert.equal(tuning.refusalDecompose, true);

  fs.writeFileSync(tuningPath(home), JSON.stringify([1, 2, 3]), "utf8");
  assert.deepEqual(readTuning(home), { ...TUNING_DEFAULTS }, "数组不是配置对象");
});

test("tuning: 兼容社区版 injectPosition 别名", (t) => {
  const home = tempHome(t);
  writeJson(tuningPath(home), { injectPosition: "head" });
  assert.equal(readTuning(home).inject, "head");

  writeJson(tuningPath(home), { inject: "nope", injectPosition: "both" });
  assert.equal(readTuning(home).inject, "both", "inject 非法时退回别名");

  writeJson(tuningPath(home), { inject: "head", injectPosition: "tail" });
  assert.equal(readTuning(home).inject, "head", "两个都合法时以 inject 为准");

  writeJson(tuningPath(home), { inject: "nope", injectPosition: "nope" });
  assert.equal(readTuning(home).inject, "head", "两个都不合法用默认");
});

test("tuning: writeTuning 合并写入、保留未知字段、坏值不落盘", (t) => {
  const home = tempHome(t);
  writeJson(tuningPath(home), { refusalSeed: false, extraPatches: [18] });
  const effective = writeTuning({ inject: "both", boost: false, refusalRetry: "x" }, home);
  assert.equal(effective.inject, "both");
  assert.equal(effective.boost, false);
  assert.equal(effective.refusalSeed, false, "已有字段应被保留");
  assert.equal(effective.refusalRetry, true, "坏值不落盘 → 读回默认");

  const raw = JSON.parse(fs.readFileSync(tuningPath(home), "utf8"));
  assert.equal(raw.extraPatches[0], 18, "未知字段原样保留");
  assert.equal(Object.hasOwn(raw, "refusalRetry"), false, "坏值不写进文件");
  assert.ok(fs.readFileSync(tuningPath(home), "utf8").endsWith("\n"));

  // 别名也能写：writeTuning({injectPosition}) 与 inject 同义。
  assert.equal(writeTuning({ injectPosition: "head" }, home).inject, "head");
});

test("boost: 默认开；tuning.json 与环境变量都能关", (t) => {
  const home = tempHome(t);
  assert.equal(readBoost(home, NO_ENV), true, "没有文件时默认开");

  writeJson(tuningPath(home), { boost: false });
  assert.equal(readBoost(home, NO_ENV), false);
  assert.equal(readBoost(home, { [BOOST_ENV]: "1" }), true, "环境变量可以反向打开");

  writeJson(tuningPath(home), { boost: true });
  assert.equal(readBoost(home, { [BOOST_ENV]: "0" }), false);
  assert.equal(readBoost(home, { [BOOST_ENV]: "off" }), false);
  assert.equal(readBoost(home, { [BOOST_ENV]: "??" }), true, "认不出来的值不覆盖 tuning");
});

test("boost: 社区旧文件 boost.json 只在没有 tuning.json 时生效", (t) => {
  const home = tempHome(t);
  writeJson(path.join(purgeDir(home), BOOST_STATE), { enabled: false });
  assert.equal(readBoost(home, NO_ENV), false);

  writeJson(tuningPath(home), { boost: true });
  assert.equal(readBoost(home, NO_ENV), true, "tuning.json 存在时旧文件不再作数");

  writeJson(tuningPath(home), {});
  assert.equal(readBoost(home, NO_ENV), true, "tuning.json 里没写 boost 也走默认开");
});

test("boost: writeBoost 落盘到 tuning.json 并能读回", (t) => {
  const home = tempHome(t);
  assert.equal(writeBoost(false, home), false);
  assert.equal(readBoost(home, NO_ENV), false);
  assert.equal(JSON.parse(fs.readFileSync(tuningPath(home), "utf8")).boost, false);
  assert.equal(writeBoost(true, home), true);
  assert.equal(readBoost(home, NO_ENV), true);
});

test("boost-order: 默认 -50000，文件覆盖，环境变量优先，坏值忽略", (t) => {
  const home = tempHome(t);
  assert.equal(DEFAULT_BOOST_ORDER, -50000, "默认段位写死 -50000（GLOBAL_PROMPT_ORDER + 50000）");
  assert.equal(readBoostOrder(home, NO_ENV), DEFAULT_BOOST_ORDER);

  const orderFile = path.join(purgeDir(home), "boost-order.json");
  writeJson(orderFile, { order: 9500 });
  assert.equal(readBoostOrder(home, NO_ENV), 9500);
  assert.equal(readBoostOrder(home, { [BOOST_ORDER_ENV]: "12345" }), 12345, "env 优先于文件");
  assert.equal(readBoostOrder(home, { [BOOST_ORDER_ENV]: "abc" }), 9500, "env 认不出来 → 退回文件");

  writeJson(orderFile, { order: 0 });
  assert.equal(readBoostOrder(home, NO_ENV), DEFAULT_BOOST_ORDER, "0 按未写处理");
  fs.writeFileSync(orderFile, "{ not json", "utf8");
  assert.equal(readBoostOrder(home, NO_ENV), DEFAULT_BOOST_ORDER, "坏文件回默认");
});

test("boost: 段名与文案是移植版原文", () => {
  // 段名有意偏离上游的 "dsh-purge:boost"：宿主补丁会提权 dsh-purge* 段，段位会被抵消。
  assert.equal(BOOST_SECTION, "dshpg-boost");
  assert.ok(BOOST_TEXT.includes('<dsh_boost scope="system" priority="override">'));
  assert.ok(BOOST_TEXT.includes("</dsh_boost>"));
  assert.ok(BOOST_TEXT.includes("要现在执行吗？"));
  assert.ok(BOOST_TEXT.length > 400, "整段文案不该被截短");
});
