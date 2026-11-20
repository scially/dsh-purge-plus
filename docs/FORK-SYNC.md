# 本 fork 与上游的关系、保留清单、升级流程

本仓库 `scially/dsh-purge-plus` 是 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) 的 fork。
除下面「保留清单」里的改动外，其余代码一律跟随上游，**不自行发明轮子**。

- `upstream` → `git@github.com:YuJunZhiXue/dsh-purge.git`（只读，取上游）
- `origin` → `git@github.com:scially/dsh-purge-plus.git`（本 fork，可写）

> **第一条原则：先看上游做了什么，再决定要不要自己动手。**
> 2026-11 那次 `#32`/`#53` 就是教训：本地花了不少功夫适配 rc.5 的新布局，
> 结果上游 `af47342` 早就做了，而且更全（连 `LEGACY_` prefix 和
> `Current DeepSeek Harness ... URL` 都覆盖了）。重复劳动，最后整段丢弃。

---

## 1. 保留清单

这些是**有意的本地改动**，升级时不要被上游覆盖掉。

| commit | 内容 | 为什么必须保留 |
|---|---|---|
| `4506a9b` | 恢复「本地靶场」外部 IP 名单：`writeAllowText` 真正落盘、`permittedHost` 查名单、公网门禁先查名单再查私网、面板补回编辑框 | 上游 1.1.73「open-source local-lab only」把这块收成了空壳（`writeAllowText` 不写盘、`permittedHost` 恒 false），靶场只能填内网 IP |
| `a735867` | 把清洗面板注册进宿主「设置」菜单（`settings.section`） | 上游只提供 dock 浮层入口，没有设置页 |
| `5f98386` | `scripts/patch-dryrun.mjs`（只读诊断）、`build:client` 串上 `patch-settings-ui.mjs` | 诊断工具上游没有；`build:client` 必须重贴设置块，否则每次重建 `client.js` 都会丢 |
| `bf5ec0d` | `.gitattributes` 统一 LF | 跨平台一致 |
| 本地测试 | `test/net-scope.test.js`、`test/settings-section.test.js`、`test/restart-manual.test.js` + `package.json` 的 `test` 脚本 | 上游 1.1.87 把**整个 `test/` 目录和 test 脚本都删了**（理由：审计清理、删死代码）。本地这几个测试覆盖的是本地独有功能与已修的 bug，保留 |
| 本地 CI | `.github/workflows/ci.yml`、`.github/actions/verify/action.yml`、`.github/host-baseline.json`、`scripts/ci-verify.mjs`、`scripts/ci-host-anchor.mjs`、`package.json` 的 `check*` / `verify` 脚本 | 上游不留 CI，本 fork 的测试得有人跑：语法/模块图/构建一致性/打包产物 + 单元测试（矩阵 ubuntu/windows/macos），另有一条手动的真宿主锚点巡检。见 `docs/CI.md` |

**已下线的本地改动（2026-11-03，1.1.91）：**

自动重启整条链**已经删掉**，不要再捡回来：

- `b5a6e63`（重启全程写 `restart.log` + settle 等真实监听）——随 helper 一起删除；
- `c5b9a07`（EPIPE 对照实验 `scripts/verify-epipe.mjs`）——同上，脚本删除；
- `readRecordedUrl`（`lib/web.js` 导出，重启时把记录里的 token 地址传给 helper）——helper 没了，导出与测试一并删除。

`lib/restart-web.js` 只留了一个**过渡期兼容垫片**（1.1.91）：旧版内存代码点「重启」时仍会 detached 拉起它再自退，
垫片只负责把 `dsh web` 拉回来，不杀进程、不做交接判断。等用户都重启过一次（1.1.92）就可以整个删掉。

原因与失败模式见 `release-notes.md` 的 1.1.91：端口假空闲、假成功、helper 半路死掉，三条都无法在插件侧稳定兜底。
现在 `scheduleRestart()` 只回一份「需要手动重启」的说明，宿主进程原样不动。

**已撤回的本地偏离：**

- `dshTarget`（曾改成 `0.2.1-rc.5`）。上游 1.1.88 改用
  `dshTarget: "0.2.1-rc.2"` + `dshTargets: ["0.2.1-rc.2", "0.2.1-rc.5"]`，
  且 `hostCompat` 变成 `targets.some(...)`，多版本声明更准确。
  **本地已改回跟随上游**，不要再单独改 `dshTarget`。

**有意与上游保持一致、不做的改动：**

- `#71 LIANGSHEN_IDENTITY_LINE` 的 `optional: true` —— 上游没加，本地也不加。
  未安装 `@linxin666/dsh-liangshen` 时它会显示 `missing_file`（内部状态，界面归到 `skipped`），
  不影响「已就绪」判定（`patchStatusReady("missing_file")` 返回 `true`）。
  真正的隐患是**装了梁神且其预设模板改版**时 `strictFiles` 会硬失败，届时再议。

---

## 2. 升级流程

历史血缘已在 `5f98386` 这一次接回上游（旧历史原本 clone 自
`JeffKeeping/dsh-purge-plus`，与上游无共同祖先，只能 reset + cherry-pick 重建）。
**现在 `main` 的祖先是上游 commit，普通 merge 即可，不需要再 force push。**

```powershell
git fetch upstream
git log --oneline HEAD..upstream/master        # 看这次带了什么
git merge upstream/master                      # 有共同祖先，能直接 merge
```

### 冲突高发文件

按历史经验，这几个文件必需要人工看一眼：

| 文件 | 原因 |
|---|---|
| `lib/core.js` | 补丁定义区（`PATCHES` / `targetFiles`）几乎每次发版都动；**冲突时优先上游** |
| `client.js` | 上游改 UI 文案/CSS 的高发区；本地只在 `apply()` 末尾有一段标记块 |
| `lib/web.js` / `lib/host.js` | 本地把 `scheduleRestart` 改成「只回手动重启说明」；上游若继续改自动重启，**保留本地版本**（理由见 1.1.91 release notes） |

### 冲突处理原则

1. **上游优先**。只有在「保留清单」里明确列出的行为才坚持本地版本。
2. `client.js` 里本地的设置页注册块被冲掉时，直接拿上游版本再跑一次：
   ```powershell
   git checkout --theirs client.js
   node scripts/patch-settings-ui.mjs        # 幂等，重复跑只替换不重复插入
   ```
   该脚本带作用域自检：注册块若被插到 `apply(ctx)` 外面（`ctx` 未定义、会被 try/catch 静默吞掉）会直接拒绝写入。
3. 上游若又往 `scheduleRestart` 里塞 spawn/杀进程，**不要合**：本地只允许返回 `manualRestartPlan()`。

---

## 3. 升级后的验证

```powershell
node --test                                   # 本地测试（上游已删自己的 test 目录）
node scripts/patch-dryrun.mjs                 # 只读：逐 pattern 在宿主上试匹配，不写宿主
node scripts/build-client.mjs                 # 重嵌红队面板片段（改过 lib/redteam/client.js 时）
node scripts/patch-settings-ui.mjs            # 重贴设置页注册块（幂等）
```

CI 上跑的是同一套东西，另加打包产物断言与真宿主锚点巡检 —— 详见 `docs/CI.md`；
本地一条命令等价：`npm run verify`（= `npm run check` + `node --test`）。

### 3.1 维护命令（1.1.92）

宿主一升级、锚点一漂移，先跑诊断，别急着改源码：

```powershell
dsh-purge diagnose --detail                  # 失配补丁 + 候选落点（文件:行号）
dsh-purge diagnose --host <另一个 @deepseek-ai 目录>   # 直接对一份没装的宿主树做评估
dsh-purge reanchor <id> --index <n> --text "<从宿主取出的真实片段>"
dsh-purge reanchor <id> --clear              # 撤销
dsh-purge probe --new / --check / --end      # 证明注入真的到达模型（扫会话日志）
dsh-purge backup --label 说明 ; dsh-purge rollback [<id>] ; dsh-purge snapshots --prune 3
dsh-purge exclude roleplay,minimal           # 这些预设不注入（命令/面板/工具照常）
dsh-purge groups [permission=off,context=on] # 补丁组开关（关掉组＝不应用、状态记 off）
node scripts/exec-proof.mjs new              # 命令执行证据：要求目标侧算 SHA256(nonce)
```

**1.1.94 从社区版搬了四块**（对方 1.6.87→1.7.18）：

| 能力 | 本地落点 | 说明 |
|---|---|---|
| 回退备份保护（#211） | `core.backupAll()` | 已打过补丁的文件不再被当成原件备份；没有原件就不建 `.bak` |
| 中文拒绝检测 + 两段重试 | `lib/refusal-retry.js` + `llm/stream` 钩子 | 默认开启；`config.refusalRetry:false` 关；审计在 `$DSH_HOME/dsh-purge/audit.log` |
| Inspector 超限帧加固（#95/#96） | `lib/extra-patches.js` | 只丢超限帧不杀宿主；rc.2/rc.3 缺锚点 → `silentWhenMissing` 跳过 |
| 补丁组开关 + 分组统计 | `lib/patch-groups.js` | `groups.json`；`apply` 跳过、状态 `off`、`summarizeByGroup()` |

**1.1.95 从社区版搬了五块**（对方 1.7.18→HEAD `e519253`）：

| 能力 | 本地落点 | 说明 |
|---|---|---|
| 拒绝重试四段化（1.7.19/1.7.20） | `lib/refusal-retry.js` + `lib/index.js` 钩子 | fail-open（重试流挂了就放行上一轮缓冲）、重试改走 `ctx.llm.stream()` 新 waterfall（`next` 只能调一次）+ `__dshPurgeRefusalRetry` 重入标记、seed 臂（并进最后一条 user 消息，**content 必须是块数组**）、`empty_after_retry` / `partial_refused` 诚实结局 |
| identity disposer 复用（PR #249） | `lib/identity.js` `bindSlot()` | 同一 `(slot, rewriteFn)` 返回同一 disposer，堵住 400ms 心跳往 `wrapDisposers` 无限塞闭包；**保留本 fork 的 noop 语义**，不跟社区的 `slot.rewrite = null` |
| `/status` 逐补丁计数（bd3d487） | `lib/index.js` HTTP payload | 不再用分组级 `display_*` 当条数，避免与 `patch_status` 对不上、把 skipped/drifted 算进 ready |
| 梁神候选路径枚举（0729f10 的小切片） | `lib/core.js` `listLiangshenPresetYmlFiles()` | `profiles/` 下所有 profile × 三种 node_modules 布局，不再硬编码 web/desktop |
| 拒绝语料回归 | `test/refusal-corpus.test.js` | 49 正样本 / 12 负样本；`KNOWN_BROAD` 记录已知误伤，不接受以此收窄动词表 |
| **ZIP 解压单读取器**（安全） | `lib/zip-extract.js` + 新 `lib/path-boundary.js` | 删掉 tar/unzip/python3/Expand-Archive 回退链（它会如实创建链接条目 ⇒ 可写到解压目录之外），补 `maxEntries` / `maxBytes`（`maxOutputLength` 截断解压炸弹）/ `verifyCrc` / 链接条目与链接祖先拒绝 / 重复路径拒绝 / EOCD 歧义拒绝 / `wx` 落盘 |

> `fileOptional`（0.2.2 上「陈旧目标副本」不算漂移）是本 fork 的实现，对应社区 1.7.20 的同名机制
> （他们用 `fileOptional` + `fileAllRequired`，见其 `test/partial-status.test.mjs`）。本 fork 不开
> 整条补丁的 `softSettle`：那会把真漂移一起藏绿，`test/file-optional.test.js` 钉了反例。

**明确不跟的（1.7.18→HEAD）**：patch 18 双布局（本 fork 出厂 pattern + `host-variants` 已等价）、
patch 71 整套文件证据（本 fork 没有 `preset-presence`/`selfcheck` 消费者）、`verifyRemovedFromBackup`
（本 fork #54 仍写 marker）、社区 #90 steering 那半（本 fork 没有对应补丁）、面板/评测脚手架/CI 全部跳过。

---

## 3.2 审计轮（1.1.96）：拿社区当镜子找自己的 bug

做法（可复用）：**同名模块按 blob 级 diff**（社区工作树是 CRLF，比较一律用 `git cat-file blob`）、
**补丁表按 `name` 对齐**（id 全错位：我们 #89=社区 #93、#90=社区 #94、社区 #90≈我们 #85+#86）、
**把上游测试当规格跑**（`git show HEAD:test/<x>.test.mjs` 改 import 指向我们的 lib）。

三条反馈线各一条 P1（都已修）：

| 来源 | 问题 | 修法 |
|---|---|---|
| 同名模块对比 | `reapply.hostCleanEnoughToKeep()` 只排 `pending`，`unmatched` 被当成「宿主已清洗」→ 盖已应用戳、永不重打（上游 `b0ac3fa`） | 抽 `patchRowsKeepHostDirty()`，两种状态都算「还有活」 |
| 新代码复核 | `filePatchOutcome()` 先看 markers、后看 forbid，而 `patchApplied()` 相反 → 半回滚态显示 applied | forbid 提前；`test/status-forbid.test.js` 钉住 |
| 补丁表对比 | #17 在 0.2.2 上漏 `requirePresent`（编辑/删除仍要「先读」）、#92/#93 每次 Apply 重复插入 | 补 `requirePresent` 变体 + marker；两条加 `skipIfMarked`；新增全表幂等契约测试 |

另外这轮自查（Lead）修掉：ZIP 解压回退链（符号链接逃逸/无上限）、`fileOptional` 取代整条 `softSettle`
（避免把真漂移藏绿）、`RETRY_MARK` 就地删除（cordis `next()` 忽略实参，实测）、`restartArgv` 识别
`--profile`/裸 profile、探针过期清理。

**下次接新宿主/新上游时**：先跑这三条线，别只看功能盘点。已知未跟项（递归删除 no-follow、
原子写 rename 退避、community #89 ask-user 等待上限）都在 1.1.96 的 release-notes 里写明了理由。

---

## 3.3 补齐轮（1.1.97）：把 3.2 列出的差距落地

| 差距 | 落地 | 备注 |
|---|---|---|
| 技能库（23 个） | `skills/redteam/` 从旧 tag 取回 + `package.json#files` 收进 | 合主线时丢过；`unauth-exploit` 并入社区的「复核命令执行」节（配合 `scripts/exec-proof.mjs`） |
| 补丁表三条 | 我们 **#97**≈社区 #89（ask_user 等待上限）、**#98**≈社区 #91（cookie 名忽略端口）、**#99**≈社区 #92（host 请求头上限） | 新增文件键 `client-connection` / `tool-ask-user`；#97 带迁移条 + `forbid` |
| `remove-tree.js` / `atomic-files.js` | `lib/remove-tree.js`（no-follow + 有界重试）、`lib/atomic-files.js`（原子写 + EPERM 退避） | 接进 `skills.js` 6 处递归删、`clearStaleExtractedApps`、`writeHostFileAtomic` |
| `boost.js` / `tuning.js` | `lib/boost.js`（段位 -50000）、`lib/tuning.js`（`tuning.json`） | **默认 `inject: "head"`**（= 社区默认 = 本 fork 移植前观感）；段名 `dshpg-*` 躲避宿主对 `dsh-purge*` 的带头提权 |
| 更新通道完整性 | `lib/update-integrity.js` + `lib/signed-sidecars.mjs`，闸门在 `overlayFromZip()` 的「写完 zip、还没解包」之间 | 真验签缺钉死公钥 → 明确 `unsupported`，不假装 |
| 自检证据链 | `lib/patch-state.mjs` + `lib/selfcheck.js` + `dsh-purge selfcheck [--json]` | 五分类；`missing_file` 归「不适用」；unknown/broken 非零退出 |

**仍然不跟（子系统级）**：插件市场 / 安装器 / 多实例登记、`locale/` i18n、`next-host`（dsh-go/NEXT）、
其余 `update-*`（镜像 / SOCKS / 系统代理 / 密钥）。这些要单独排期，别按「一条补丁」的粒度混进日常移植。

---

## 3.4 清扫轮（1.1.98）：把两个加固模块铺满 + 段序真机取证

**安全清扫**（`_scratch/fixall/safety.md` §8 的候选清单，本轮全部落地）：

| 组 | 落点 |
|---|---|
| 原子写退避 | `lib/core.js` 四个 helper（影响面最大：所有宿主/状态文件写入）借 `atomic-files` 抽出的 `renameSyncWithRetry`/`renameWithRetry`，仍走 `hostFs`；`snapshot`/`tuning`/`drill-grant`/`hooks-deny`/`index` 日志轮转 |
| no-follow 删除 | `extract-asar`（`discardDir`/`restoreExtractedDir`）、`desktop`（删链接）、`preset-default`、`snapshot`、`update`、`uninstall`、`core.js`（解包半成品 `side.next`） |
| 换目录/换 asar 退避 | `extract-asar` 的 `renameAsarAside`/`restoreFromPrev`/`commitExtractedDir`/`restoreExtractedDir` |
| 自包含副本 | `restart-desktop.js` / `uninstall-restart.js` / `bin/dsh-purge.js` 内联一份（**零 import**，三份逐字节一致）——包被卸载后仍要能跑，所以不能 import 模块 |

**段序真机取证**（新增只读脚本 `scripts/verify-section-order.mjs`）：

- 宿主侧那条提权规则（我们自己的补丁装进 `dsh-system-prompt` 的 `[...dshPurgeSections, ...dshPurgeRest]`）
  在 **0.2.1-rc.5** 上生效、在 0.2.2 上不重排；它把**非空 `dsh-purge*` 段整体提前**。
- 结论：段名**必须**按「宿主会不会动它」来选 —— 要留在原位的段（锚点、尾部注入、cap、boost）一律
  `dshpg-` 前缀；要钉在最前的注入正文段才叫 `dsh-purge`。改名后两个宿主版本上锚点都真在最后。
- 以后接新宿主：先跑 `node scripts/verify-section-order.mjs --ai-base <aiBase> --strict-host`，
  再谈适配 —— 段序不对时「注入贴尾/锚点 recency」这类设计会静默失效。

**没跟的**：社区版把设置搬成了侧栏整页、设置页共享、回退按钮默认隐藏——那是面板架构差异，
本 fork 仍是「设置页 section + dock」，要跟得单独重排面板。dsh-go / NEXT 换包、签名 sidecar 校验与 web 场景无关。

**上游现状（2026-11-19 复核）**：原仓库 `YuJunZhiXue/dsh-purge` 已经 404，账号下公开仓库为 0。
社区接续版 `kingcharleslzy-ai/dsh-purge`（HEAD `e519253` = 1.7.20，★5.6k+）与我们**不是同一套历史**
（我们的 `217d60d`/`c63ba4a` 在那边查不到），**不能 merge**，只能按功能移植。
到 1.1.95 为止，已移植：diagnose/reanchor、probe、backup/rollback、excludePresets、exec-proof、
备份保护、拒绝重试（含 1.7.19/1.7.20 的四段升级）、identity disposer 复用、`/status` 逐补丁计数、
梁神 profile 枚举；对方的面板整页化、插件市场索引、独立安装器、`preset-presence`/`selfcheck`
那套证据链没有跟进（本 fork 没有对应消费者）。

移植时**按 name 对齐，不按 id**：社区 #90 = `RESTORE_NATIVE_STEERING`，本 fork #90 = `SKILL_BADGE`
（= 社区 #94）。另外社区 HEAD 的 `withNudge` 对字符串 content 会**静默丢掉 nudge**，本 fork 两种形态都覆盖 ——
merge 冲突时保留本 fork 版本，别抄回去。

**0.2.2 适配（1.1.93→1.1.95）**：新增 `lib/host-variants.js` —— 新宿主的锚点变体全部集中在那个文件，
加载时追加到补丁的 `replacements`，`core.js` 里的上游原文保持不动（merge 冲突面最小）。
- 已实测：0.2.2-rc.1 / 0.2.2-rc.3 / **0.2.2-rc.4 / rc.5** 各装一份隔离目录跑引擎；
  rc.4 与 rc.5 的会话客户端是同一份字节，所以 rc.3 实测覆盖 rc.4。
- 1.1.95 起 rc.5 干净树 `pending 67 / applied 5 / drifted 1`（只剩 `#88`，自标记续作），
  Apply 一轮 `failed 0`，应用后 `applied 73 / 0 pending / 0 drifted`，**再 Apply 一轮 0 写盘**。
  `dshTargets` 因此是 `0.2.1-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.1 / rc.3 / rc.4 / rc.5`（rc.2 未单独实测，不声明）。
- 1.1.95 补的三块（都在 `host-variants.js`，`core.js` 只多了一个合并循环）：
  1. `#77` 的**压缩客户端变体**：0.2.2-rc.2 起会话客户端压成一行，出厂缩进式 pattern 一条不中，
     以前只能标 `na`。压缩锚点在整份产物里唯一，`isRewindMarker` 用 `typeof` 守卫调 #56 注入的那份；
     模式一次即消费 ⇒ 天然幂等。`HOST_VARIANTS_SKIP` 随之清空。
  2. `#62` 的**重复注入**：两条变体的 `replace` 自带 `pattern`，而 `skipIfMarked` 只管出厂 replacement，
     于是每轮 Apply 各再插一遍（30 轮仍在长）。变体补 `insertProbe` 后二次 Apply 零写盘。
  3. `HOST_VARIANT_FLAGS`（`markersAny` / `addMarkers` / `softSettle`）：新宿主把同一段逻辑搬了家，
     出厂 marker 永远凑不齐 → Apply 成功后状态页反而报漂移（rc.5 上 4 条）。只给确实搬家的
     #17/#40/#54/#60/#62 打口径补丁，实测应用后 0 漂移。
- 以后再接新宿主：把变体写进 `lib/host-variants.js`（需要时加 `HOST_VARIANT_FLAGS`），
  别去改 `core.js` 的 PATCHES 字面量。
- **上游（社区版）现状 2026-11-19**：`kingcharleslzy-ai/dsh-purge` HEAD `e519253` = 1.7.20，
  `QUALIFIED_HOST_VERSIONS` 到 `0.2.2-rc.3` 为止；rc.4 明确 `unknown`，**rc.5 没有任何记录** ⇒
  rc.4/rc.5 的适配是我们自己做的，不是跟上游。

`patch-dryrun.mjs` 的读法：

- `compat: OK` —— 宿主版本命中 `dshTargets` 列表里的任意一项
- **`pending`** —— pattern 能命中，只是还没 apply，点一次 Apply 即可
- **`drifted`** —— 一条 pattern 都命中不了，上游改文案了，需要更新 pattern
- `missing_file` —— 目标组件没装（如梁神），一般无需处理

> 上游每次发版常会为新宿主版本**追加 pattern**，所以刚 merge 完出现几条 `pending` 是正常的
> （例：1.1.88 为 rc.5 补了 `#36`/`#50`/`#53`/`#57`/`#62`）。点一次 Apply 即可。

---

## 4. 自动重启为什么整条下线（别再捡回来）

2026-11-03（1.1.91）之前，`scheduleRestart()` 会 detached 拉起 `lib/restart-web.js`：helper 等旧 server
退出（等不到就 `taskkill`），再在同端口 `spawn` 新的 `dsh web`。日志与 EPIPE、静默失败这些坑都修过，
但**失败模式本身消不掉**，而且都出现在用户机器上：

1. **端口假空闲**：判定「端口空了」用的是 `net.connect()`。宿主的 accept 队列被堵住时，Windows 会
   直接回 RST，`connect` 报 ECONNREFUSED/超时 → 代码认为端口空了 → 不等旧进程退干净就 `spawn`
   → 新进程 `EADDRINUSE` 秒退。实测复现：日志里同时出现 `new process exited early: code=1` 和
   `new process listening on :PORT`。
2. **假成功**：上一条里「有人监听」其实是还没退出的旧进程。helper 看到端口有人就 `exit(0) handoff done`，
   旧进程 200ms 后退出 → 端口彻底没人。用户看到的就是「重启完 web 没了，只能手动 `dsh web`」。
3. **helper 半路死掉**：`killOldServer` 之后一行日志都没有，进程消失，端口上什么都不剩
   （2026-11-02 16:01 UTC 的 `restart.log` 就是现场）。没有任何插件侧手段能在它死后接管。

三条都指向同一个结论：**进程交接不该由插件在一台看不见的 Windows 上做**。所以现在：
`scheduleRestart()` 只写一行日志并返回 `{ restarting:false, needsManualRestart:true, command, note }`，
前端弹「需要手动重启」并显示 `dsh web --port <当前端口>`；宿主进程、端口、helper 全都不碰。

`scripts/verify-epipe.mjs`、`scripts/verify-restart.mjs`、`test/restart-url.test.js` 也一起删了 ——
它们测的对象已经不存在。

> 仍然保留 `lib/web-reclaim.js` + 注入宿主 `bin.js` 的启动前回收：那不是重启，
> 而是清掉**旧版本**遗留的 detached server，避免下次 `dsh web` 撞 `EADDRINUSE` 起不来（#197）。

---

## 5. 已知的上游问题

### 5.1 `info.url` 死代码 —— 随自动重启一并作废

上游在 `restart-web.js` 的 `waitFree` 失败分支里调 `openBrowser(info.url || "")`，但 payload 从来没有
`url` 字段，那段是空操作；本地曾用 `readRecordedUrl()` 修过。`restart-web.js` 删除后，
`readRecordedUrl`、`web-server-<port>.json` 的写入方与 `test/restart-url.test.js` 一起移除。
`lib/web-reclaim.js` 仍会读这份记录做启动前回收，只是不再有人往里写 url。

### 5.2 上游删掉了整个 `test/` 目录

1.1.87 的「审计加固与死代码清理」把 `test/` 和 `package.json` 的 `test` 脚本一并移除
（`patch-status` / `profile-insert` / `score-rules` / `settle-policy` / `zip-extract` /
`web-reclaim` 等用例都没了）。本地保留了自己的测试与 `test` 脚本；
以后再 merge 时，若上游又动 `test/`，注意别把自己的测试一起删掉。

---

## 6. 回退

合入上游那次做过历史重建，旧历史完整保存在远端备份分支：

```powershell
git fetch origin
git reset --hard origin/backup/pre-upstream-1.1.86   # 回到合入上游前的状态
```

要撤回**某一次**本地改动，按上面的「保留清单」逐个 `git revert <commit>` 即可，
不必回退整个历史。
