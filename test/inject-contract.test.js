/**
 * 注入正文契约：出厂正文（封印在 lib/asset-table.js）必须满足
 * 「外层包装 + 条款一条不少 + 长度窗口 + 无未解析占位」。
 *
 * 条款清单在 test/fixtures/inject-clauses.json：改正文前先跑这份，删条款必须同步改夹具。
 * 两侧都做空白归一（连续空白 → 单空格），所以条款可以跨行写。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as table from "../lib/asset-table.js";
import { openSlot } from "../lib/table-read.js";
import { peelChatmlEnvelope } from "../lib/identity.js";
import { BOOST_TEXT } from "../lib/boost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/inject-clauses.json"), "utf8"));

/** 封印正文：出货的出厂注入（$DSH_HOME/prompt-inject.md 的默认内容）。 */
const shipped = openSlot({ SLOT: table.SLOT, MASK: table.MASK, TAG: table.TAG, IV: table.IV });
/** 运行时形态：identity.js 的 peelChatmlEnvelope（转 LF + 补 </project_instructions>）。 */
const runtime = peelChatmlEnvelope(shipped);

const norm = (value) => String(value).replace(/\s+/g, " ").trim();

function missingClauses(text) {
  const hay = norm(text);
  return fixture.clauses.filter((clause) => !hay.includes(norm(clause.phrase)));
}

test("出厂正文能解码，且外层包装与运行时闭合都成立", () => {
  assert.equal(typeof shipped, "string");
  assert.ok(shipped.length > 0, "封印正文解出来不能是空串");

  const head = fixture.wrapper.rawHead;
  assert.ok(shipped.startsWith(head), `出厂正文必须以 ${head} 开头`);
  assert.ok(shipped.includes("</project_instructions>") === false, "出厂形态不带闭合标签：闭合由运行时补");
  assert.ok(runtime.startsWith(fixture.wrapper.normalizedHead), "运行时形态必须是两行信封开头");
  assert.ok(runtime.endsWith(fixture.wrapper.closer), "运行时形态必须以 </project_instructions> 收尾");
  assert.ok(runtime.includes("</project_instructions>"), "闭合标签必须出现");
  assert.equal(runtime.split(fixture.wrapper.closer).length, 2, "闭合标签只能有一处（第二套信封会让后半段被吞进项目备注）");
});

test("条款清单一条不少（任意一条丢失都要先改夹具再改正文）", () => {
  const missing = missingClauses(shipped);
  assert.deepEqual(
    missing.map((clause) => clause.id),
    [],
    `出厂正文丢了 ${missing.length} 条强制条款：${missing.map((c) => `${c.id}(${c.why})`).join("；")}`,
  );
  // 归一化（转 LF/补闭合）不该吃掉任何条款
  assert.deepEqual(missingClauses(runtime).map((clause) => clause.id), [], "运行时形态同样一条不少");
});

test("长度在夹具窗口内（防半截 / 防整段膨胀）", () => {
  assert.ok(fixture.length.min < fixture.length.max, "夹具窗口写反了");
  assert.ok(
    shipped.length >= fixture.length.min && shipped.length <= fixture.length.max,
    `出厂正文 ${shipped.length} 字符，超出窗口 [${fixture.length.min}, ${fixture.length.max}]：${fixture.length.why}`,
  );
  assert.ok(runtime.length <= shipped.length + 64, "运行时的归一化不该显著加长正文");
});

test("不含未解析占位与二进制污染", () => {
  for (const item of fixture.forbidden) {
    assert.equal(
      shipped.includes(item.text),
      false,
      `出厂正文出现禁用内容 ${item.id}：${item.why}`,
    );
  }
  assert.ok(!shipped.startsWith("\uFEFF"), "正文不能带 BOM");
  assert.ok(!shipped.includes("\r\r"), "行尾不能出现裸 CR 连写（CRLF 之外的换行形态）");
});

test("条款匹配器本身能发现丢失（负样本自检）", () => {
  const truncated = shipped.slice(0, Math.floor(shipped.length / 2));
  assert.ok(missingClauses(truncated).length > 0, "截断后的正文必须被判丢条款");
  assert.deepEqual(missingClauses(runtime).map((c) => c.id), [], "完整正文不该被误报");
  // 空白归一：把正文换成 CRLF/多空格，条款仍然匹配
  const respaced = runtime.replace(/\n/g, "\r\n").replace(/([。；])/g, "$1  ");
  assert.deepEqual(missingClauses(respaced).map((c) => c.id), [], "空白归一后不应丢条款");
});

test("强化段文案保留「直接交付 + 问一句」两条款", () => {
  assert.match(BOOST_TEXT, /要现在执行吗/, "boost 段必须保留那句确认话术");
  assert.match(BOOST_TEXT, /return the artifact directly/i, "boost 段必须要求直接给产物");
  assert.match(BOOST_TEXT, /<dsh_boost scope="system" priority="override">/, "boost 段必须声明自己的层级");
  assert.ok(BOOST_TEXT.length > 400, "boost 段不该被截短");
});
