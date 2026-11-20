# 1.1.98

## 中文

- 版本 **1.1.98**：**安全清扫第二轮 + 段序真机复核**。1.1.97 只把两个加固模块落地并接了 6 处线，这轮把仓库里剩下的调用点铺完，并把「锚点到底在不在最后」用真机验了一遍。
- **`lib/core.js` 的四个原子写/拷补上退避（影响面最大的一处）**：`atomicWriteSync` / `atomicWriteFile` / `atomicCopyFile` / `atomicCopyFileSync` 此前只是「写临时文件 → rename」，**没有** EPERM/EACCES/EBUSY 退避 —— 而这四个函数是所有宿主文件与状态文件写入的必经之路。现在退避实现从 `lib/atomic-files.js` 抽成「吃 fs 面」的助手（`renameSyncWithRetry` / `renameWithRetry`，两边同一份、不复制），core 仍然走 `hostFs`（app.asar 还在时要写进真实 resources/app），fsync 与权限位保留。实测：普通读句柄占用目标时 rename **真**抛 EPERM，退避后写入成功；句柄一直不放 → 抛错、目标字节不变、无临时残留。
- **装/卸官方桌面版的主链路铺满**：`lib/extract-asar.js` 的 `discardDir` / `restoreExtractedDir` 删坏目录改 no-follow；`renameAsarAside` / `restoreFromPrev` / `commitExtractedDir`（2 处）/ `restoreExtractedDir`（3 处）换目录改走内联的 `renameWithRetrySync`（5 次、5→60ms 抖动、非占用类错误立即抛）。失败语义一字未变：占用时 `renameAsarAside` 仍返回 `{busy:true}` 且 asar 原样在位，`recover.json` 兜底逻辑未动。`lib/desktop.js` 删链接改 no-follow。
- **零散点收尾**：`preset-default`（陈旧预设目录）、`snapshot`（prune）、`update`（覆盖前 + finally）、`uninstall` 的递归删改 no-follow；`snapshot` / `tuning` / `drill-grant` / `hooks-deny`（保留 fsync）/ `index` 日志轮转的 rename 改退避。**一处行为变化**：`tuning` 去掉了「rename 失败就直接覆盖目标」的兜底 —— 现在占用时退避 5 次后抛错，目标字节不变（调用方只有设置面板与 `setBoost`）。
- **三份「卸载后仍要能跑」的自包含副本**（`lib/restart-desktop.js`、`lib/uninstall-restart.js`、`bin/dsh-purge.js`）：内联 no-follow 递归删除（三份**逐字节一致**、零 `import`/`require`），语义 = lstat 优先 / 链接只摘不跟进 / 逐层非递归 rmdir / `ENOENT` 幂等 / `EBUSY` 等有界退避 8×120ms / Windows 只读先补写位 / 拒删文件系统根 / 空目标直接返回。
- **锚点段名 `dsh-purge:anchor` → `dshpg-anchor`（真机复核的修复）**：只读观测脚本在**本机 0.2.1-rc.5** 上发现，宿主侧那条提权规则（我们自己的补丁装进 `dsh-system-prompt` 的 `[...dshPurgeSections, ...dshPurgeRest]`）会把**非空 `dsh-purge*` 段整体提前** → 锚点被挪到第一段，**recency 设计失效**（0.2.2 不重排，锚点本来就在最后）。改名后两个宿主版本上锚点都真在最后。顺带修掉 `injectTail` 诊断正则（原来只认 `dsh-purge*`，改名后会永远为假）与两处过期注释。
- **新增只读观测脚本 `scripts/verify-section-order.mjs`**：用迷你 ctx 桩真跑 `registerPromptSections → rewritePromptAssembly → arrangeInjectedSections` 算出我们侧的有序段列表，静态扫宿主里所有 `startsWith("dsh-purge"|"dshpg-")` 片段（函数名 + 行号），再按扫到的规则模拟宿主重排给出预测顺序。`--strict-host` 时把宿主侧判定计入退出码 —— 以后宿主或补丁再动段序，一条命令就能发现。
- **测试**：`node --test` **233 条全绿**（本轮 +46：`asar-safe-fs` 15、`misc-safe-fs` 9、`self-contained-remove` 9、`section-order` 8、`atomic-write-core` 5）；`scripts/ci-verify.mjs` 四项全通过；本机 0.2.1-rc.5 与隔离 0.2.2-rc.5 都 0 drifted。

## English

- **1.1.98**: second hardening sweep plus a real-host section-order audit. 1.1.97 landed the two hardening modules and wired six call sites; this release covers the rest of the repository and verifies where the operator anchor actually ends up.
- **The four atomic write/copy helpers in `lib/core.js` now retry**: they were plain "write tmp → rename" with **no** EPERM/EACCES/EBUSY backoff, and every host-file and state-file write goes through them. The retry helper is now shared with `lib/atomic-files.js` (extracted as fs-surface-agnostic `renameSyncWithRetry` / `renameWithRetry`), core keeps using `hostFs` (sealed-asar routing) and keeps fsync plus permission preservation. Measured: a plain read handle really does make rename fail with EPERM, and the write now succeeds after backoff; a never-released handle throws with the target unchanged and no temp leftovers.
- **The desktop install/uninstall main path is fully covered**: no-follow deletes in `extract-asar.js`, and `renameWithRetrySync` (5 tries, 5→60 ms jitter) for every directory/asar swap. Failure semantics unchanged (`{busy:true}` with the asar untouched, `recover.json` untouched).
- **Remaining call sites**: no-follow deletes in `preset-default`, `snapshot`, `update`, `uninstall`; rename backoff in `snapshot`, `tuning`, `drill-grant`, `hooks-deny`, and the log-rotation rename in `index.js`. One behaviour change: `tuning` no longer silently overwrites the target when the rename fails — it now backs off and throws.
- **The three self-contained copies** (`restart-desktop.js`, `uninstall-restart.js`, `bin/dsh-purge.js`) inline the no-follow delete (byte-identical, zero imports) because they must still run after the package is uninstalled.
- **The anchor section is renamed `dsh-purge:anchor` → `dshpg-anchor`**: the read-only script showed that on the local **0.2.1-rc.5** host our own injected hoisting rule (`[...dshPurgeSections, ...dshPurgeRest]`) moves every non-empty `dsh-purge*` section to the front, which pushed the anchor to index 0 and defeated its recency design (0.2.2 does not reorder). With the rename the anchor is genuinely last on both hosts; the `injectTail` diagnostic and two stale comments were fixed along the way.
- **New read-only tool `scripts/verify-section-order.mjs`**: computes our section order through the real assembly functions, statically scans the host for `dsh-purge`/`dshpg-` filter fragments, simulates the host reorder, and (with `--strict-host`) fails the exit code when the anchor would move.
- Tests: `node --test` **233 green** (+46 this round), `scripts/ci-verify.mjs` fully green, 0 drifted on both the local 0.2.1-rc.5 host and the isolated 0.2.2-rc.5 tree.

# 1.1.97

## 中文

- 版本 **1.1.97**：**把与社区版（HEAD `e519253`，1.7.20）对比后确认的差距补齐**（补齐项按「上游有而我们没有」清单逐条落地，仍有明确不跟的，见文末）。
- **红队技能库回到仓库（最重要的一条）**：`skills/redteam/` 的 **23 个技能**（active-scan、fofa-recon、fscan/gogo-intranet、suo5/chisel/frp 隧道、webshell-toolkit、credential-attack、lateral-movement、vps-reverse-shell、kimi-webbridge…）以前只活在旧 tag `v1.3.1`–`v1.4.4` 和已装机器的 `$DSH_HOME/redteam/skills` 里 —— 合入上游主线时丢了，新机器装完「技能库」页签会全缺。现在从旧 tag 取回并写进 `package.json#files`（不给 `files` 白名单，npm 包里也会没有）。`unauth-exploit` 另并入社区那节「如何复核命令执行」（配合本包的 `scripts/exec-proof.mjs`：落盘 ≠ 能执行，要用一次性 nonce 验收）。
- **移植社区三条补丁**（我们的 id 与社区不同，按 `name` 对齐）：
  - **#97 `ASK_USER_WAIT_CAPPED`**（社区 #89）：0.2.2 起宿主把 `ask_user` 的默认等待写成 `timeout: -1` = **无限等待**，无人值守或子代理走到这里会一直挂着。现在只把「-1」收成 300 秒，模型显式给的其它等待时间与默认值完全不动；旧版硬写 1 秒的形态由迁移条自动换掉。
  - **#98 `BROWSER_COOKIE_NAME_IGNORE_PORT`**（社区 #91，仅桌面端）：桌面每次随机端口、官方按 `host:port` 派生会话 cookie 名，攒到把请求头撑过 Node 默认 16KB 上限后本地 web 直接回 431，主进程判成 "Web authentication failed"，应用打不开。cookie 名改为只看主机名。
  - **#99 `HOST_MAX_HTTP_HEADER_SIZE`**（社区 #92，仅桌面端，可选）：给 host 子进程加 `--max-http-header-size=262144`，兜住历史累积的 cookie（#98 只能止住继续增长，旧 cookie 要等 30 天过期）。
  - 新增 `client-connection` / `tool-ask-user` 两个目标文件键（npm 扁平、npm 嵌套、monorepo `packages/…` 三种布局都覆盖）。
- **测试**：`test/skills-inventory.test.js`（23 个技能都在、frontmatter 合法、`files` 收进 skills、与面板修复文案表双向一致）+ `test/upstream-ports.test.js`（三条补丁的名字/marker/可选性与幂等契约，含「旧版 1 秒形态能迁移」与「-1 才收口、其它时间不动」）。
- **移植安全加固件**（社区 `remove-tree.js` / `atomic-files.js`）：
  - 新增 `lib/remove-tree.js`（123 行）：递归删除**不跟随**符号链接/junction —— 链接只 `unlink` 本身，目录逐层 `rmdir`，`ENOENT` 幂等，`EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM` 有界退避，拒删文件系统根；Windows 只读条目先补写位再删。
  - 新增 `lib/atomic-files.js`（111 行）：原子写/复制（临时文件 + rename），`EPERM/EACCES/EBUSY` 退避重试，保留原权限位，失败清临时文件。
  - 接线：`lib/skills.js` **6 处**递归删目录（卸官方技能 ×2、备份还原、bundle 安装失败清理、两个导入 `finally`）、`lib/official-update.js` 的 `clearStaleExtractedApps`、`lib/hide-console.js` 的 `writeHostFileAtomic`。
  - 实测口径：本机 Node 26 的 `fs.rmSync(recursive:)` 本身已不跟随链接，所以 no-follow 是「对齐上游 + 补重试/只读处理」；而**普通读句柄占用目标时 rename 真会抛 EPERM**，原子写那条是真修好的。
- **移植上下文工程**（社区 `boost.js` / `tuning.js`）：新增 `lib/boost.js`（逐字 `BOOST_TEXT`，段位默认 `-50000`，`PURGE_BOOST_ORDER` > `boost-order.json` > 默认）与 `lib/tuning.js`（`tuning.json`：`boost` / `inject` / `refusalRetry` / `refusalDecompose` / `refusalSeed`，坏文件一律回默认不抛，兼容社区字段名 `injectPosition`）。接线在 `lib/index.js` 的提示词装配：强化段进头部组、`inject: head|tail|both` 决定注入正文落点、锚点永远最后。
  - **默认值取 `head`**：这既是社区 `TUNING_DEFAULTS.injectPosition` 的默认，也是本 fork 移植前的实际观感 —— 换默认值等于替用户换提示词形态，不做；想试尾部注入写 `{"inject":"tail"}` 一行即可。
  - **段名用 `dshpg-boost` / `dshpg-inject-tail` 而非 `dsh-purge*`**：宿主侧补丁会把「非空的 `dsh-purge*` 段」整体提前，沿用原名会让段位与尾部落点双双失效（cap/角色段早就是这个理由改的名）。
- **移植更新通道完整性 + 精简自检**：
  - 新增 `lib/update-integrity.js`：`verifyArtifact(file, {expectedSha256, sidecarPath})`，13 种判定 reason；无侧车 → `{ok:true, signed:false}` + 落一行日志（`$DSH_HOME/dsh-purge/update-integrity.log`）；**接在 `lib/update.js` 的 `overlayFromZip()` 里 `writeFile(zip)` 之后、`extractZip` 之前** —— 校验不过直接抛错，不解包、不覆盖任何插件文件。
  - 新增 `lib/signed-sidecars.mjs`（保留上游「根摘要 → 相对路径 → sha256」钉子语义 + `digest-json` / `sha256sum` 两种单文件侧车）；**真密码学验签明确标 `unsupported`**（没有钉死公钥就不假装验过）。
  - 新增 `lib/patch-state.mjs` + `lib/selfcheck.js` + `bin/dsh-purge.js selfcheck [--json]`：状态词 → 五分类（已应用/待应用/不适用/未知/异常），`unknown`/`broken` 非零退出；`missing_file` 归「不适用」（与 `patchStatusReady` 一致）。
- **本轮全量验证**：`node --test` **187 条全绿**；本机 0.2.1-rc.5 与隔离 0.2.2-rc.5 都 `0 drifted`（隔离树 74 applied / 0 pending）；`selfcheck` 退出码 0。
- **仍未跟的（有意）**：插件市场/安装器/多实例登记（`market/`、`official-installer*`、`install-registry`）、i18n `locale/`、`next-host`（dsh-go/NEXT 宿主族）、整套 `update-*` 模块（镜像/SOCKS/系统代理/密钥）—— 这些是子系统级工程，不是「一条补丁」，需要单独排期；`atomic-files`/`remove-tree` 在本仓已接线，剩下 20+ 处 `rmSync(recursive)`/`renameSync` 候选清单在 `_scratch/fixall/safety.md`。

## English

- **1.1.97**: closes the gaps found against the community tree (HEAD `e519253`, 1.7.20).
- **The red-team skill library is back in the repo** (`skills/redteam/`, 23 skills) and listed in `package.json#files` — it had only survived in the old `v1.3.1`–`v1.4.4` tags and in already-installed `$DSH_HOME/redteam/skills`, so fresh installs showed an empty skill page. `unauth-exploit` also picks up the community's "how to verify command execution" section (pairing with this repo's `scripts/exec-proof.mjs`: a dropped file is not proof of execution).
- **Three ports from the community table** (ids differ; aligned by `name`): `ASK_USER_WAIT_CAPPED` (the host's new `timeout: -1` infinite wait is capped at 300 s, everything else untouched), `BROWSER_COOKIE_NAME_IGNORE_PORT` (desktop: cookie name ignores the random port, preventing the 431 "Web authentication failed" startup failure), `HOST_MAX_HTTP_HEADER_SIZE` (desktop: `--max-http-header-size=262144` for machines that already accumulated cookies). Two new target-file keys (`client-connection`, `tool-ask-user`) cover flat, nested and monorepo layouts.
- **Safety hardening ported** (`remove-tree.js` / `atomic-files.js`): no-follow recursive delete (links are unlinked, never traversed; bounded retries; read-only handling; refuses filesystem roots) and atomic write/copy with `EPERM/EACCES/EBUSY` backoff. Wired into six recursive-delete sites in `lib/skills.js`, `clearStaleExtractedApps`, and `writeHostFileAtomic`. Measured: Node 26's `rmSync(recursive:)` already avoids following links, so that half is parity + retries, while the rename-EPERM case reproduces on a plain read handle and is a real fix.
- **Context engineering ported** (`boost.js` / `tuning.js`): the boost paragraph (order `-50000`, overridable via `PURGE_BOOST_ORDER` / `boost-order.json`) plus a `tuning.json` for `boost`, `inject: head|tail|both` and the three refusal arms. **Default is `head`** — both the community default and this fork's pre-port behaviour; `{"inject":"tail"}` opts into tail placement. The new sections are named `dshpg-*` on purpose: host-side patches promote non-empty `dsh-purge*` sections to the front, which would silently defeat both the boost order and the tail position.
- **Update-channel integrity + a lean selfcheck**: `verifyArtifact()` now runs between "zip written" and "zip extracted" in `overlayFromZip()` (a failure throws before anything is unpacked or overwritten), with a sidecar-digest lookup; real cryptographic verification is reported as `unsupported` rather than faked. `dsh-purge selfcheck [--json]` classifies every patch into applied/pending/inactive/unknown/broken and exits non-zero on unknown/broken.
- Verification: `node --test` **187 green**; local 0.2.1-rc.5 and the isolated 0.2.2-rc.5 tree both report **0 drifted** (isolated: 74 applied / 0 pending); `selfcheck` exits 0.
- **Still deliberately not ported**: plugin market / installers / instance registry, `locale/` i18n, `next-host` (dsh-go/NEXT host family), and the rest of the `update-*` stack (mirrors, SOCKS, system proxy, secrets) — those are subsystem-scale programmes, not single patches.

# 1.1.96

## 中文

- 版本 **1.1.96**：**与社区版（HEAD `e519253`，1.7.20）做了一轮逐模块 + 逐补丁的对比审计**，把审计出来的问题修掉。审计口径：11 个同名模块做 blob 级 diff（另复核 4 个文件逐字节相同）、88 条补丁按 `name` 对齐逐条比内容、本轮新移植代码单独复核；上游测试当规格跑（拒绝重试/语料/fixtures 31/31、rc.2 rewind 客户端、zip、probe，含据此发现的问题）。
- **ZIP 解压安全加固（P1）**：旧实现有一条 tar / unzip / python3 / Expand-Archive 回退链，那条路径只检查条目名 —— tar/unzip 会把 zip 里的**符号链接**如实建出来，「先建链接再往里写」就能写到解压目录之外；此外没有条目数上限、没有解压后大小上限（压缩炸弹）、不认重复路径、不挡 NTFS 备用数据流与 Windows 保留名。现在所有平台、所有调用（skill 归档导入、update 换包）都走同一个受限读取器：条目名校验 → 拒绝链接条目 → 拒绝链接祖先（新增 `lib/path-boundary.js`）→ 拒绝重复路径 → 条目数/大小上限（`maxOutputLength` 直接截断，不先解出来）→ 与目录声明比对大小 → 可选 CRC → `wx` 落盘。上游 7 条 zip 回归用例中 6 条在本地直接通过（第 7 条是上游「删掉列目录导出」的仓库卫生断言；本地 skills 导入仍用 `listZipFile` 做预检，故保留该导出）。
- **0.2.2 状态口径改精确（P1）**：把上一版的整条 `softSettle` 换成**逐文件**的 `fileOptional`（对齐社区同名机制）——只有「已知整体搬走的那份副本」算中性，真正负责该行为的副本被上游改写时**仍然报 drifted**；`test/file-optional.test.js` 里钉了反例（把 live 副本锚点改掉 → 必须 drifted）。
- **`filePatchOutcome` 的 forbid 判定提到 markers 之前（P1）**：`patchApplied()` 一直是 forbid 优先，状态路径却先看 markers，于是「官方原句回来了 + 旧 marker 还在」的半回滚态会显示 `applied`，而 apply 路径还要改 —— 同一文件两条路径结论相反。带 forbid 的 #40/#60/#61/#69/#85/#86 都受影响（`test/status-forbid.test.js`）。
- **`hostCleanEnoughToKeep()` 补上 `unmatched`（P1，对齐上游 b0ac3fa）**：以前只排 `pending`，`strictFiles` 补丁锚点失配（`unmatched`）会被当成「宿主已清洗」，启动分支直接盖已应用戳 → 那条补丁永不自动重打，状态页却仍显示 ✗（"never report an unreadable patch state as all-green"）。抽成可测的 `patchRowsKeepHostDirty()`（`test/reapply-unmatched.test.js`）。
- **重试标记不再泄漏给 adapter（P2）**：cordis 的 `next()` **忽略实参**（4.0.5 实测，`next(clean)` 下游收到的还是原对象），所以 `next(clean)` 去键无效，`__dshPurgeRefusalRetry` 会一路走到 provider 适配层。现在改为就地 `delete`（`stripRetryMark()`），并把这个实测结论写进注释 —— 注释原先声称的「第二次 next() 会抛」只对 cordis ≥4.1 成立，4.0.5 上是**静默重跑下游**（terminal ×2），两条都不能要，所以重试必须走 `ctx.llm.stream()`。
- **卸载重启不再改坏命令行（P2）**：`restartArgv()` 现在识别 `--profile X` / `--profile=X` / 裸 profile 名 / 其它子命令（上游同款 `hasProfile` 修复）——以前会把 `dsh --profile X` 改写成 `dsh web --port 3080 --profile X`（丢端口）或把 `dsh headless` 拼成 `dsh web … headless`。
- **探针过期即清理（P2，对齐上游 21264c6）**：`readProbe()` 读到过期探针时顺手删掉 `probe.json`，不再长期挂在 `$DSH_HOME/dsh-purge/` 下。
- **两处小修**：拒绝重试的审计帧在 attempt 0 写 `"none"`（以前误写 `decompose`，上游同错）；`deliveryIsThin()` 的围栏正则认 CRLF（Windows 上模型回的代码块以前会被算成 0 行）。
- **审计里另外两条 P1（补丁表逐条对比发现）**：
  - **#17 在 0.2.2 上只挡了一半**：宿主把「先读后写」闸门抽成了 `requirePresent()`，`editIntent`/`deleteIntent` 都只转发它；我们只有 0.2.1 那种内联 `editIntent` 的锚点，于是 0.2.2 上**编辑/删除仍然要先读一遍**（`FS_NOT_OBSERVED`），而 `markersAny` 让状态页全绿。现在补上 `requirePresent` 变体（照抄社区同名 replacement）并把它写入的 marker 加进列表 —— 隔离 rc.5 树上补打 1 个文件、二次 apply 0 写盘。
  - **#92/#93 桌面退出留痕每次 Apply 都再插一遍**（本地补丁，`surfaces:["desktop"]`，web 面实测覆盖不到）：两条都是「replace 以 pattern 原文开口」的插入型替换，却没有 `skipIfMarked`/`insertProbe` —— 实测 #92 `+514 B/次`、#93 `+1633 B/次`（对照 #46 有 `skipIfMarked` → 263→263→263）。两条都加上 `skipIfMarked: true`。
  - 新增**幂等契约测试** `test/patch-idempotency.test.js`：全表扫描「自匹配的插入型 replacement 必须有 `insertProbe` 或补丁级 `skipIfMarked`」+ 用补丁自己的替换表在内存里跑两遍断言字节不变（#62/#92/#93 都是这条规则抓出来的）。
- **审计里明确「不跟/待排期」的**：`skills.js` / `official-update.js` 递归删除缺 no-follow + 重试（上游 `4df2175`/`249d28b`，本地复现不出目标被删；解压侧的限额已由 zip 加固覆盖）、原子写 rename 的 EPERM 退避（上游 `atomic-files.js`；本机用 `FileShare.None` 抢占后仍未复现）、`identity.js` 的 noop dispose（本 fork 有意：清了会让 inject 中途失效）、`#77` 与 `#56` 的状态联动（设计如此：`typeof` 守卫让 #77 单独存在时是空操作）、`refusal-retry` 的 `|| yielded`（本 fork 有意偏离：宁可整轮报错，也不把「上一轮的拒绝文本」拼在半段新回答后面）。
- **补丁表对比的其它结论（已复核，非 bug）**：两边各 88 条、按 `name` 对齐 84 条；id 全错位（我们 #89=社区 #93、#90=社区 #94、社区 #90 `RESTORE_NATIVE_STEERING` ≈ 我们 #85+#86 的终态）；仅我们新增 #85/#86/#92/#93，仅他们 #89/#90/#91/#92。#50 去掉 `untrusted` 守卫、#32/#53 整句删除并改写宿主 `LEGACY_*` 提示词常量 —— 都是本 fork 的**本意**（身份清洗 + 让模型照做注入指令）；#40 有一条 `pattern === replace` 的空操作死条目（1114 B，无害，待清理）；缺少社区的 **#89 `ASK_USER_WAIT_CAPPED`**（0.2.2 的 `ask_user` 默认 `timeout:-1` = 无限等待；两边宿主锚点一致，可 10 分钟移植）—— 属**产品取舍**（会限制交互等待上限，默认不强加），未跟。
- 测试：`node --test` **106 条全绿**（新增 zip 9、fileOptional 2、reapply 1、restartArgv 5、forbid 顺序 2、stripRetryMark 1、probe TTL 1）；本机 0.2.1-rc.5 与隔离 rc.5 均无回归（73 applied / 0 drifted）。

## English

- **1.1.96**: a **module-by-module and patch-by-patch audit against the community tree (HEAD `e519253`, 1.7.20)**, with everything it found fixed. Scope: blob-level diffs of 11 shared modules (plus four files confirmed byte-identical), all 88 patches compared by `name`, the freshly ported code re-reviewed, and upstream tests used as specs (refusal retry/corpus/fixtures 31/31, rc.2 rewind client, zip, probe).
- **ZIP extraction hardening (P1)**: the old code kept a tar / unzip / python3 / Expand-Archive fallback that only validated entry names — those tools materialise symlink entries, so "plant a link, then write through it" escaped the destination; there was also no entry cap, no post-inflate size cap (decompression bomb), no duplicate-path rejection and no ADS/Windows-reserved-name filtering. All platforms and callers (skill import, update packages) now share one restricted reader: name validation → symlink entries rejected → linked ancestors rejected (new `lib/path-boundary.js`) → duplicate paths rejected → entry/size caps (`maxOutputLength` truncates instead of inflating) → declared-size check → optional CRC → `wx` writes.
- **Precise 0.2.2 status accounting (P1)**: the blunt patch-level `softSettle` is replaced by per-file `fileOptional` (the community's own mechanism) — only the copy that is known to have moved away counts as neutral, while the copy that actually carries the behaviour still reports `drifted` when upstream rewrites it (`test/file-optional.test.js` pins that counterexample).
- **`filePatchOutcome` now checks `forbid` before `markers` (P1)**: `patchApplied()` always checked forbid first, but the status path looked at markers first, so a half-rolled-back file (official sentence back + an old marker present) showed `applied` while the apply path still wanted to rewrite it. Affects the patches that carry forbid lists (#40/#60/#61/#69/#85/#86) — see `test/status-forbid.test.js`.
- **`hostCleanEnoughToKeep()` now counts `unmatched` (P1, upstream b0ac3fa)**: it only excluded `pending`, so a `strictFiles` patch whose anchors no longer match was treated as "host already clean" and the boot branch stamped the install as applied — that patch could never be re-applied automatically while the status page still showed ✗. Extracted into the testable `patchRowsKeepHostDirty()` (`test/reapply-unmatched.test.js`).
- **The retry marker no longer leaks into adapter options (P2)**: cordis' `next()` **ignores its argument** (verified on 4.0.5: the downstream listener receives the original object), so `next(clean)` never stripped anything and `__dshPurgeRefusalRetry` travelled all the way to the provider layer. It is now deleted in place (`stripRetryMark()`), and the comment records the measured truth: the "second next() throws" contract holds only on cordis ≥4.1 — on 4.0.5 it silently re-runs the downstream (terminal ×2), so retries must go through `ctx.llm.stream()`.
- **Uninstall restart no longer mangles the command line (P2)**: `restartArgv()` now recognises `--profile X`, `--profile=X`, a bare profile name and other subcommands (same `hasProfile` fix as upstream) — it used to rewrite `dsh --profile X` into `dsh web --port 3080 --profile X` (losing the port) or turn `dsh headless` into `dsh web … headless`.
- **Expired probes are cleaned up (P2, upstream 21264c6)**: `readProbe()` removes `probe.json` once it has expired instead of leaving it in `$DSH_HOME/dsh-purge/` forever.
- **Two small fixes**: the attempt-0 refusal audit frame now says `"none"` (it used to say `decompose`; upstream has the same wrong label); `deliveryIsThin()`'s fence regex accepts CRLF (Windows answers used to count as zero code lines).
- **Two more P1s from the patch-table comparison**: **#17 only covered half of 0.2.2** (the host extracted the read-before-write gate into `requirePresent()`, which `editIntent`/`deleteIntent` merely forward, so edits/deletes still required a prior read while `markersAny` showed green) — the `requirePresent` variant is now ported and its marker added (one extra file patched on the isolated rc.5 tree, 0 writes on the second Apply); and **#92/#93 (our desktop exit-trace patches) re-inserted themselves on every Apply** (`+514 B` / `+1633 B` per run, desktop surface only) because they are insertion-type replacements without `skipIfMarked`/`insertProbe` — both fixed, plus a new **idempotency contract test** (`test/patch-idempotency.test.js`) that scans the whole table for self-matching insertion replacements and re-runs each patch's own replacements twice in memory.
- **Explicitly not followed / deferred**: recursive-delete no-follow + retries in `skills.js` / `official-update.js` (upstream `4df2175`/`249d28b`; the deletion could not be reproduced locally, and the extraction limits are covered by the zip hardening), atomic-write rename EPERM backoff (`atomic-files.js`; not reproducible locally even with the target held by `FileShare.None`), `identity.js`'s noop dispose (deliberate: clearing it would break injection mid-session), the `#77`/`#56` status linkage (by design: the `typeof` guard makes #77 inert on its own), and `refusal-retry`'s `|| yielded` (deliberate: fail the turn rather than splice the previous refusal text behind half an answer).
- **Other patch-table conclusions (reviewed, not bugs)**: 88 patches on each side, 84 aligned by `name`; ids are fully shuffled (#89↔#93, #90↔#94, community #90 `RESTORE_NATIVE_STEERING` ≈ our #85+#86 end state); #85/#86/#92/#93 are ours only, #89/#90/#91/#92 theirs only. #50 dropping the `untrusted` guard and #32/#53 deleting whole sentences plus rewriting the host's `LEGACY_*` prompt constants are **intentional** for this fork (identity stripping + injected instructions must be followed); #40 carries one `pattern === replace` no-op dead entry (1114 B, harmless, cleanup pending); the community's **#89 `ASK_USER_WAIT_CAPPED`** is missing (0.2.2's `ask_user` defaults to `timeout:-1` = infinite; anchors are identical on both hosts, a 10-minute port) — a product decision, so not applied by default.
- Tests: `node --test` **106 green** (9 zip, 2 fileOptional, 1 reapply, 5 restartArgv, 2 forbid ordering, 1 stripRetryMark, 1 probe TTL). No regression on the local 0.2.1-rc.5 host or the isolated rc.5 tree (73 applied / 0 drifted).

# 1.1.95

## 中文

- 版本 **1.1.95**：**适配 DSH 0.2.2-rc.4 / rc.5**（`latest`/`next` 现在都指 0.2.2-rc.5），并把社区版 1.7.19/1.7.20 那批拒绝重试升级搬过来。
- **0.2.2-rc.4 / rc.5 适配（实测）**：`dshTargets` 增加这两个版本。隔离装一份 `@deepseek-ai/dsh@0.2.2-rc.5` 全量跑引擎：干净树 `pending 67 / applied 5 / drifted 1`（只剩 `#88`，是 #87 的自标记续作，应用一次即 applied）；Apply 一轮 `applied 67 / already 6`、**失败 0**；应用后 `applied 73 / na 13 / missing_file 1 / skipped 1`，**0 待应用、0 漂移**；再应用一轮 **0 个文件被写**（逐文件 sha256 比对），48 个被改动的 `.js` 全部 `node --check` 通过。rc.4 与 rc.5 的 `dsh-client-ui-conversation/lib/client.js` 是同一份字节（SHA256 前缀 `3d166eab…`），rc.3 实测覆盖 rc.4。
- **`#77` 压缩客户端变体（补掉老缺口）**：0.2.2-rc.2 起会话客户端被压成一行，出厂那条缩进式 pattern 一条都不命中，以前只能标 `na`。新增的变体锚在压缩后的 `append(record){…}` 上（整份产物里唯一一处），语义与出厂 replace 一致：命中 rewind 标记就把「当前窗口 + 这条」交给 `replaceWindow` 重建。`isRewindMarker` 由 #56 的变体注入，用 `typeof` 守卫，没装 #56 时退化成空操作。应用一次即消费掉 pattern，因此**天然幂等**。`HOST_VARIANTS_SKIP` 因此清空。
- **`#62` 每次 Apply 都再插一遍（真 bug）**：`HOST_VARIANT_FILES[62]` 的两条变体 `replace` 自带 `pattern`，而该补丁的 `skipIfMarked` 只覆盖出厂 replacement，管不到追加变体 —— 结果是每轮 Apply 往 `dsh-tools/lib/pipeline.js`、`lib/types/pipeline.js` 各再写一遍（30 轮实测仍在长）。两条变体补上 `insertProbe`，重复 Apply 零写盘；`#62` 的 marker 也补了变体实际写入的那句。
- **0.2.2 上「Apply 成功后反而报漂移」修掉**：`patchApplied()` 默认要求 markers **全部**命中，而新宿主把同一段逻辑搬了家（或只剩两个替换点里的一个），出厂 marker 永远凑不齐 → 状态页翻红。新增 `HOST_VARIANT_FLAGS`（`markersAny` / `addMarkers` / `fileOptional`）与 `patch.fileOptional`：
  - `markersAny` + `addMarkers` 解决「变体写进去的内容认不出」（#17 / #40 / #60 / #62）；
  - `fileOptional` 解决「**某个目标副本**在新宿主上已经整体搬走」（#54 的 `deliverables-prompt`、#60 的 `dsh-tools*`、#62 的 `dsh-tools*`）——这些副本一条锚点都不剩时算中性，**其余副本照旧按漂移口径判**。
  - 为什么不直接给整条补丁开 `softSettle`：那会把「上游真把这段删了」一起藏成绿色。`test/file-optional.test.js` 里就钉了这个反例（把 live 副本的锚点改掉 → 必须报 `drifted`）。rc.5 实测应用后 0 漂移（修前 4 条）。
- **ZIP 解压按上游的单读取器重构（安全修复）**：旧实现有一条 tar / unzip / python3 / Expand-Archive 回退链，那条路径只检查条目名 —— tar/unzip 会把 zip 里的**符号链接**如实建出来，「先建链接再往里写」就能写到解压目录之外；另外没有条目数上限、没有解压后大小上限（解压炸弹）、不认重复路径、不挡 NTFS 备用数据流与 Windows 保留名。现在所有平台、所有调用（skill 归档导入、update 换包）都走同一个受限读取器：路径校验（含 `:`/结尾点空格/保留名）→ 拒绝链接条目 → 拒绝链接祖先（新 `lib/path-boundary.js`）→ 重复路径 → 条目数/大小上限（`maxOutputLength` 直接截断炸弹）→ 与目录声明比对大小 → 可选 CRC 校验 → `wx` 落盘。上游 7 条 zip 回归用例里 6 条在本地直接通过（第 7 条是上游「删掉列目录导出」的仓库卫生断言，本地 skills 导入仍用 `listZipFile` 做预检，故保留该导出）。
- **拒绝重试升级到四段（对齐社区 1.7.19 / 1.7.20）**：
  - **fail-open**：重试流建不起来或中途报错，就把上一轮缓冲的拒绝文本原样放行 —— 宁可给用户看一句拒绝，也不能因为「重试机制自己出错」把整轮打成会话失败；
  - **换新 waterfall**：Cordis 的 `next` 只能调用一次，旧实现第二次调用会抛 `next() called multiple times`。重试改走 `ctx.llm.stream()`（`reflect.get("llm")` 取，拿不到就 fail-open），并用 `__dshPurgeRefusalRetry` 标记让重入那一次直通；
  - **seed 臂**：在 fiction 与 decompose 之间加一段「让回答从已经在交付的位置继续」。community 早期是真的追加 assistant 预填消息，DSH 要求它带 `source.replayState`，伪消息会抛 `Cannot read properties of undefined (reading 'replayState')` 整轮失败 —— 这里只把骨架并进最后一条 user 消息，且 **content 一律产出文本块数组**（宿主 adapter 对字符串 content 直接 `.some()/.flatMap()`，会 TypeError）；最后一条不是 user（工具结果等）时退回 system 级提示，不伪造消息；
  - **诚实结局**：`empty_after_retry`（重试后只吐十几个字不算救回来）、`partial_refused`（先给一堆背景、最后把请求推掉）；
  - **语料加宽**：`不接 / 不答 / 配合 / 回复 / 处理 / 展开 / 碰 / 办`、能愿式、英文必须带拒绝对象。
- **identity：assembleGuard disposer 按 `(slot, rewriteFn)` 复用（对齐社区 PR #249）**：Cordis 每次读服务方法都给新 Proxy，`index.js` 里按 prompt 去重命中不了，400ms 心跳 + 每 pre-step 都会往 `wrapDisposers` 塞新闭包（两小时上万条）。现在同一个 `(slot, rewriteFn)` 返回同一个 disposer；**本 fork 的 noop 语义保留**（社区会 `slot.rewrite = null`，那正是本 fork「任务到一半苏醒」的成因），停用仍走 `clearAssembleGuard()`。
- **`/status` 计数改逐补丁真值（对齐社区 1.7.20 的 bd3d487）**：以前优先用 `display_*`（按分组聚合），会和 `patch_status` 对不上、并把 skipped/drifted 算进 ready。面板自己按 `patch_status` 现算，不受影响。
- **梁神预设候选路径不再硬编码 web/desktop**：`profiles/` 下每个 profile × 三种 node_modules 布局都查，自定义 profile 名装了梁神不会再报 `missing_file`。
- 测试：`node --test` 85 条（新增拒绝语料回归 49 正样本 / 12 负样本、identity guard、seed 臂、retryStream、语料加宽）。本机 0.2.1-rc.5 无回归（73 applied / 0 pending / 0 drifted）。
- **上游现状（2026-11-19 复核）**：原仓库 `YuJunZhiXue/dsh-purge` 仍是 404；社区接续版 `kingcharleslzy-ai/dsh-purge` HEAD `e519253`（1.7.20）**已适配到 0.2.2-rc.3**（`QUALIFIED_HOST_VERSIONS` 到 rc.3；rc.4 标 `unknown`，rc.5 没有任何记录），所以 rc.4/rc.5 只能自己适配 —— 本版就是这件事。见 `docs/FORK-SYNC.md`。

## English

- **1.1.95**: **DSH 0.2.2-rc.4 / rc.5 support** (`latest`/`next` both point at 0.2.2-rc.5 now) plus the community's 1.7.19 / 1.7.20 refusal-retry work.
- **0.2.2-rc.4 / rc.5 (measured)**: `dshTargets` extended. An isolated `@deepseek-ai/dsh@0.2.2-rc.5` tree: clean status `pending 67 / applied 5 / drifted 1` (only `#88`, the self-marked follow-up of #87 — one Apply turns it applied); first Apply `applied 67 / already 6`, **0 failures**; post-Apply `applied 73 / na 13 / missing_file 1 / skipped 1` with **0 pending, 0 drifted**; a second Apply wrote **0 files** (per-file sha256 comparison); all 48 modified `.js` files pass `node --check`. rc.4 and rc.5 ship byte-identical conversation clients, so the rc.3 measurement covers rc.4.
- **`#77` minified variant (old gap closed)**: from 0.2.2-rc.2 the conversation client is minified to one line and the shipped indented pattern never matches, which used to be reported as `na`. The new variant anchors on the minified `append(record){…}` (unique in the bundle) and mirrors the shipped replacement: a rewind marker routes the current window plus that record through `replaceWindow`. `isRewindMarker` comes from #56's variant and is called behind a `typeof` guard, so the line is a no-op when #56 is absent. The pattern is consumed on first apply, so it is idempotent by construction. `HOST_VARIANTS_SKIP` is now empty.
- **`#62` re-inserted on every Apply (real bug)**: both variants' `replace` contained their own `pattern`, and the patch's `skipIfMarked` only covered the shipped replacements — every Apply added another copy to `dsh-tools/lib/pipeline.js` and `lib/types/pipeline.js` (still growing after 30 rounds). Both variants now carry `insertProbe`; a second Apply writes nothing. `#62` also gained the marker text the variant actually writes.
- **"Apply succeeded but the status says drifted" fixed on 0.2.2**: `patchApplied()` requires *all* markers by default, but the new host moved that code (or kept one of two replacement sites), so the shipped markers could never all appear. New `HOST_VARIANT_FLAGS` (`markersAny` / `addMarkers` / `fileOptional`) plus `patch.fileOptional`: `markersAny`+`addMarkers` cover "we wrote different text than the shipped markers" (#17/#40/#60/#62); `fileOptional` covers "this one target copy moved away entirely" (#54 `deliverables-prompt`, #60/#62 `dsh-tools*`) — such a copy counts as neutral while every other copy keeps full drift semantics. A blunt patch-level `softSettle` was rejected because it would also hide a genuine upstream rewrite; `test/file-optional.test.js` pins that counterexample. Measured 0 drifted after Apply on rc.5 (was 4).
- **ZIP extraction rebuilt on the single restricted reader (security fix)**: the old implementation kept a tar / unzip / python3 / Expand-Archive fallback chain that only checked entry names — those tools happily create the symlink entries a zip can carry, so "plant a link, then write through it" escaped the destination; there was also no entry-count cap, no post-inflate size cap (decompression bomb), no duplicate-path rejection, and no NTFS-ADS/Windows-reserved-name filtering. Now every platform and every caller (skill archive import, update packages) goes through one restricted reader: name validation (incl. `:`, trailing dot/space, reserved names) → symlink entries rejected → linked ancestors rejected (new `lib/path-boundary.js`) → duplicate paths rejected → entry/size caps (`maxOutputLength` truncates bombs rather than inflating first) → declared-size comparison → optional CRC → `wx` writes. Six of the seven upstream zip regression tests pass as-is; the seventh is upstream's own policy assertion that the listing exports are gone (our skills import still uses `listZipFile` for pre-checks, so that export stays).
- **Refusal retry, four arms (community 1.7.19 / 1.7.20)**: **fail-open** (if the retry stream cannot be built or dies mid-flight, release the previously buffered refusal instead of failing the turn); **fresh waterfall** (Cordis `next` is single-use, so retries go through `ctx.llm.stream()` via `reflect.get("llm")`, marked with `__dshPurgeRefusalRetry` so the re-entry passes straight through); **seed arm** (between fiction and decompose; the community's early version appended a fabricated assistant message, which DSH rejects because it lacks `source.replayState` — here the skeleton is merged into the last *user* message and content is always a text-block array, since the host adapter calls `.some()/.flatMap()` on it; when the last message is not a user message the arm falls back to a system-level hint); **honest outcomes** (`empty_after_retry`, `partial_refused`); **wider corpus** (不接/不答/配合/回复/处理/展开/碰/办, ability forms, English patterns that require an object).
- **identity: assembleGuard disposer reuse keyed by `(slot, rewriteFn)` (PR #249)**: Cordis hands out a fresh Proxy per service read, so the fork's prompt-keyed dedup missed and the 400 ms heartbeat plus every pre-step pushed a new closure into `wrapDisposers`. The fork's noop-dispose semantics are preserved (the community clears `slot.rewrite`, which is exactly this fork's "wakes up mid-task" bug); deactivation still goes through `clearAssembleGuard()`.
- **`/status` counts now report per-patch truth (community bd3d487)**: it used to prefer the group-level `display_*` tallies, which disagree with `patch_status` and count skipped/drifted as ready. The panel computes its own tally from `patch_status`, so rendering is unaffected.
- **Liangshen preset candidates no longer hardcode web/desktop**: every profile under `profiles/` is enumerated across the three node_modules layouts.
- Tests: `node --test` 85 (new refusal corpus 49 positives / 12 negatives, identity guard, seed arm, retryStream, wider patterns). No regression on the local 0.2.1-rc.5 host (73 applied / 0 pending / 0 drifted).
- **Upstream status (checked 2026-11-19)**: `YuJunZhiXue/dsh-purge` is still 404; the community continuation `kingcharleslzy-ai/dsh-purge` (HEAD `e519253`, 1.7.20) **stops at 0.2.2-rc.3** (`QUALIFIED_HOST_VERSIONS` ends at rc.3, rc.4 is `unknown`, rc.5 is absent), so rc.4/rc.5 had to be adapted here. See `docs/FORK-SYNC.md`.

# 1.1.94

## 中文

- 版本 **1.1.94**：把社区版 1.6.87→1.7.18 里真正有用的四块搬过来。
- **回退备份保护（对齐社区 #211）**：`backupAll()` 在建立 `.dshpurge.bak` 前先看补丁锚点——文件已经处于「已应用」状态时，**不再把打过补丁的内容当成原件备份**（以前这种情况回退等于没退）。没有原件就宁可不建 bak，并在返回里记 `skippedPatched`。
- **中文拒绝检测 + 两段重试（对齐 1.7.12 / 1.7.17）**：新增 `lib/refusal-retry.js`，挂 `llm/stream` 钩子。先缓冲回答开头（400 字符 / 首个 tool-call / finish），命中推脱句式就丢弃这一段，换成加固语气重发；第二段换成本地合成夹具/小说口吻；`refusalDecompose`（默认开）再加一段「只给最小可交付组件」。默认开启，`config.refusalRetry:false` 关闭。命中规则包含 `这条我不做`、`结论：…我不出`、`我不会提供` 等 0.2.2 实测句式。审计写 `$DSH_HOME/dsh-purge/audit.log`（`refusal_retry` / `refusal_retry_outcome`，带 attempt/frame）。
- **Inspector 超限帧加固（对齐 #95/#96）**：新增 `lib/extra-patches.js`，两条可选补丁给 Cordis 树记录预留 1 KiB；单帧仍超限时只丢这一帧、保留上一帧，其它 topic 与异常继续抛出（以前会把宿主带走）。0.2.2 客户端是压缩单行，补了 minified 锚点；rc.2/rc.3 官方已预留外壳，锚点缺失用 `silentWhenMissing` 标成跳过而不是漂移。
- **补丁组开关（对齐 1.7.18 的组化）**：`lib/patch-groups.js` + `dsh-purge groups [permission=off,context=on]`。关掉的组在 `apply` 阶段直接跳过、状态记 `off`（不进分母、不刷失败）；`summarizeByGroup()` 供面板按组统计。两组默认开启，保持既有行为。
- 面板整页化、侧栏设置共享、回退按钮默认隐藏这三项是社区版的**架构差异**（他们已把设置搬成侧栏整页），本 fork 沿用设置页 section，没有照搬；要做需要单独一轮重排面板。
- 实测：88 条补丁（86 + inspector 2）；本机 rc.5 `patch-dryrun` 为 71 applied / 2 pending（新加的两条）/ 0 drifted；`node --test` 全绿。

## English

- **1.1.94**: ports the four genuinely useful items from the community project (1.6.87→1.7.18).
- **Revert-backup protection (#211)**: `backupAll()` now checks the patch anchors first — when a file is already in the "applied" state it **no longer snapshots patched bytes as the original** (that made revert a no-op). If no pristine original exists, no `.bak` is created and the file is reported in `skippedPatched`.
- **Chinese refusal detection + two-stage retry (1.7.12 / 1.7.17)**: new `lib/refusal-retry.js` hooked into `llm/stream`. It buffers the head of the answer (400 chars / first tool-call / finish); on a refusal it drops that attempt and re-sends with a firmer nudge, then a local-synthetic-fixture/fiction framing, then (with `refusalDecompose`, on by default) a smallest-deliverable-component frame. Enabled by default; `config.refusalRetry:false` disables. Patterns include `这条我不做`, `结论：…我不出`, `我不会提供`. Audited to `$DSH_HOME/dsh-purge/audit.log` with attempt/frame.
- **Inspector frame hardening (#95/#96)**: new `lib/extra-patches.js` with two optional patches that reserve 1 KiB of record overhead for the Cordis tree and drop only the oversized frame (previously it took the host down). Includes a minified anchor for the 0.2.2 single-line client bundle; hosts that already reserve the wrapper report `skipped` via `silentWhenMissing` instead of drifting.
- **Patch groups (1.7.18)**: `lib/patch-groups.js` + `dsh-purge groups [permission=off,context=on]`. Disabled groups are skipped during `apply` and reported as `off` (excluded from totals, not failures); `summarizeByGroup()` feeds per-group counters. Both groups default to on, preserving existing behaviour.
- The community's sidebar-page panel, shared settings page and default-hidden rewind button are architecture differences (their settings moved to a full sidebar page); this fork keeps the settings section, so those were not ported.
- Measured: 88 patches (86 + 2 inspector); local rc.5 dry-run 71 applied / 2 pending (the new ones) / 0 drifted; `node --test` green.

# 1.1.93

## 中文

- 版本 **1.1.93**：**适配 DSH 0.2.2-rc.3**（npm `next`，2026-11-13 发布；`latest` 仍指 rc.1），同时回补 0.2.2-rc.1。
- 新增 `lib/host-variants.js`：**新宿主的锚点变体集中在这一个文件**，加载时追加到对应补丁的 `replacements` 之后，`core.js` 里的上游原文不动（merge 冲突面最小）。同时补了三个搬家的目标文件键：
  - `ptc-tool` → `dsh-tool-executor-ptc/lib/index.js`（#60 的 run_code 文案）；
  - `dsh-tools-pipeline(-types)` → `dsh-tools/lib/pipeline.js`、`…/types/pipeline.js`（#62 的审批 fail-open）；
  - `deliverable-file-references` → `dsh-deliverable-file-references/lib/index.js`（#54）。
- 覆盖的变体：#13/#14/#35（0.2.2 把 escalation 三处 throw 换成带错误码的 `SandboxEscalationError`，包也从 `dsh-escalation` 并进 `dsh-sandbox`）、#40（assemble 返回值新增 `tools`，complete 预设要连 tools 一起保留注入）、#54（句子搬家且句首多一个空格）、#56（会话客户端被 minify 成单行，回退改成压缩版 `rewindVisibleEntries` 方案）、#62（审批判断搬进 pipeline，锚点收敛到一行 `ctx.get("approval")`）、#67（去固定缩进的正则）、#74（装配前挂钩改到 `claim`/`model.current()` 之间）。
- **实测（把 0.2.2-rc.1 / rc.3 各装一份到隔离目录，用本插件引擎逐条跑）**：
  - rc.3：86 条 → pending 64 / applied 5 / **na 14** / missing 1 / skipped 1 / **drifted 1**；唯一那条 `#88` 是 #87 的续作（自己的 marker，干净树上必然不命中，应用后即 applied）。
  - rc.1：同样只剩 `#88`，从原来的 8 条失配降到 1 条。
  - 本机 rc.5：`patch-dryrun` 仍是 71 applied / 0 pending / 0 drifted，无回归。
  - 因此 `dshTargets` 增加 **`0.2.2-rc.1`** 与 **`0.2.2-rc.3`**（这两个是实测过的）。rc.2 未单独验证，暂不声明——落在 rc.2 上只会出 MISMATCH 告警，不阻止 apply。
- **明确的缺口**：`#77`（回退时丢弃已发送项）在 0.2.2 的压缩客户端里没有对应锚点，`lib/host-variants.js` 的 `HOST_VARIANTS_SKIP` 把它在 rc.2/rc.3 上标成 `na`（比假装成功诚实）。下一版补 minified 变体后删掉这条。

## English

- **1.1.93**: **DSH 0.2.2-rc.3 support** (npm `next`, published 2026-11-13; `latest` still points at rc.1), plus 0.2.2-rc.1.
- New `lib/host-variants.js`: host-specific anchor variants live in one file and are appended to each patch's `replacements` at load time, leaving the upstream literals in `core.js` untouched (minimal merge conflict surface). Three relocated target-file keys were added: `ptc-tool`, `dsh-tools-pipeline(-types)` and `deliverable-file-references`.
- Variants cover #13/#14/#35 (0.2.2 moved escalation into `dsh-sandbox` and throws `SandboxEscalationError` with codes), #40 (`tools` added to the assemble result), #54 (sentence moved, leading space), #56 (minified conversation client — compressed `rewindVisibleEntries` approach), #62 (approval check moved into the pipeline), #67 (indentation-free regex) and #74 (prepare hook moved between `claim` and `model.current()`).
- **Measured** on isolated installs of 0.2.2-rc.1 and 0.2.2-rc.3 with our own engine: rc.3 → 86 patches, `drifted: 1` (only `#88`, the self-marked follow-up of #87); rc.1 → also down from 8 to 1. Local rc.5 unchanged (71 applied / 0 pending / 0 drifted).
- `dshTargets` now includes `0.2.2-rc.1` and `0.2.2-rc.3` (both measured). rc.2 is not declared; it would only raise the non-blocking MISMATCH warning.
- **Known gap**: `#77` (rewind drops sent inputs) has no anchor in the minified 0.2.2 client; `HOST_VARIANTS_SKIP` reports it as `na` on rc.2/rc.3 rather than pretending success.

# 1.1.92

## 中文

- 版本 **1.1.92**。本版没有合上游——原仓库 `YuJunZhiXue/dsh-purge` 已经 404（账号公开仓库为 0），社区接续版 `kingcharleslzy-ai/dsh-purge`（1.6.86）与我们**不同源**（我们的 commit 在那边不存在），只能按功能挑着移植。本版移植了其中五项，并补齐一项兼容性核查。
- **锚点漂移诊断与本地重锚**（`diagnose` / `reanchor`）：宿主一升级就整段失配，以前只能改源码等发版。现在 `dsh-purge diagnose [--detail] [--host <aiBase>]` 逐条列出失配的 pattern 和候选落点（文件:行号），`dsh-purge reanchor <id> --index <n> --text "<从宿主取出的真实片段>"` 把锚点钉进 `$DSH_HOME/dsh-purge/anchor-overrides.json`，`--clear` 撤销。覆盖会在 apply / status / dryrun 全链路生效。
- **运行时探针**（`probe`）：`probe --new` 生成一次性 nonce 并把 `<dsh_probe>` 段挂到注入正文末尾，模型回显后 `probe --check` 扫会话日志（zstd JSONL）确认——证明的是「注入真的到达模型」，而不是「文件写进去了」。`probe --end` 收尾，30 分钟自动过期。
- **宿主快照 / 回滚**（`backup` / `rollback` / `snapshots`）：按 `targetFiles()` 把宿主文件整组快照到 `$DSH_HOME/dsh-purge/snapshots/<id>/`（manifest 带 sha256），`rollback [<id>]` 校验后原子还原；默认保留 5 份，`snapshots --prune <n>` 手动清理。解决「逐条 revert 撤不掉手改/别的插件改动」。
- **按预设排除注入**（`excludePresets`）：`dsh-purge exclude roleplay,minimal` 会让这些预设不注入提示词（命令、面板、工具照常）。判断用**当前会话自己的预设**（`context.agent.session.header.agentPreset`），并行会话与子 Agent 各判各的；配了排除但解析不出预设时保守不注入。配置源：插件配置 `excludePresets` + `$DSH_HOME/dsh-purge/exclude-presets.json`（CLI 写）。
- **命令执行证据**（`scripts/exec-proof.mjs`）：一次性挑战，要求目标侧算出 `SHA256(nonce)` 而不是回显 nonce，用来区分「只能写文件」和「命令真的执行了」。POSIX / macOS / PowerShell 三套命令由脚本直接生成。
- **0.2.2-rc.1 兼容性核查（结论：暂不适配，不写进 dshTargets）**：把 `@deepseek-ai/dsh@0.2.2-rc.1` 完整装到隔离目录，用本插件的补丁引擎逐条跑：86 条里 **8 条失配** —— `#14`(escalation)、`#40`(system-prompt 注入保活)、`#54`(deliverables)、`#60`/`#62`(dsh-tools 审批)、`#67`/`#74`(agent-loop)、`#88`(自标记，属正常续作)。其中 `#40`/`#74`/`#67` 属于提示词注入与装配链路，**不能只改声明**。修法：`diagnose --host <rc.1 的 @deepseek-ai 目录> --detail` 取候选，`reanchor` 钉住；或者在下一版直接把 rc.1 变体写进 `core.js`。核实前 `dshTargets` 保持 `0.2.1-rc.2 / 0.2.1-rc.5`。
- 自动重启仍维持 1.1.91 的决定：只在面板提示手动重启，不动进程。

## English

- **1.1.92**. No upstream merge this time: `YuJunZhiXue/dsh-purge` is gone (404, zero public repos), and the community continuation `kingcharleslzy-ai/dsh-purge` (1.6.86) has an **unrelated history** (our commits do not exist there). Five of its features were ported, plus one compatibility audit.
- **Anchor drift diagnostics + local re-anchoring** (`diagnose` / `reanchor`): when a host upgrade breaks literal anchors you no longer have to edit sources and wait for a release. `dsh-purge diagnose [--detail] [--host <aiBase>]` lists every missed pattern with candidate hit sites (file:line); `dsh-purge reanchor <id> --index <n> --text "<real fragment from the host>"` pins it into `$DSH_HOME/dsh-purge/anchor-overrides.json`; `--clear` reverts. Overrides apply to apply/status/dryrun.
- **Runtime probe** (`probe`): `probe --new` creates a nonce and appends a `<dsh_probe>` block to the injected prompt; after the model echoes it, `probe --check` scans session logs (zstd JSONL) — proving the injection *reached the model*, not just that a file was written. `probe --end` cleans up; 30-minute TTL.
- **Host snapshots / rollback** (`backup` / `rollback` / `snapshots`): snapshots every `targetFiles()` entry into `$DSH_HOME/dsh-purge/snapshots/<id>/` with a sha256 manifest; `rollback [<id>]` verifies and atomically restores; keeps the newest 5, `snapshots --prune <n>` trims.
- **Per-preset injection exclusion** (`excludePresets`): `dsh-purge exclude roleplay,minimal` keeps those presets free of prompt injection (commands, panel and tools stay). The decision uses the session's own preset (`context.agent.session.header.agentPreset`), so parallel sessions and subagents decide independently; when a list exists but the preset cannot be resolved, injection is skipped conservatively.
- **Execution evidence** (`scripts/exec-proof.mjs`): a one-time challenge that requires the target side to compute `SHA256(nonce)` instead of echoing the nonce, distinguishing "can write files" from "can execute commands".
- **0.2.2-rc.1 audit (verdict: not compatible yet; not declared)**: a full `@deepseek-ai/dsh@0.2.2-rc.1` tree was installed in isolation and checked with our own engine: **8 of 86 patches miss** — `#14`, `#40`, `#54`, `#60`, `#62`, `#67`, `#74` (real drift) and `#88` (self-marked, expected). `#40`/`#74`/`#67` are on the prompt-assembly path, so this cannot be fixed by editing metadata. Use `diagnose --host … --detail` + `reanchor`, or add rc.1 variants to `core.js` in a follow-up. `dshTargets` stays at `0.2.1-rc.2 / 0.2.1-rc.5` until then.
- Automatic restart remains removed as of 1.1.91: the panel only tells you to restart manually.

# 1.1.91

## 中文

- 版本 **1.1.91**（fork 变更；上游 1.1.89 / 1.1.90 已合入）。
- **自动重启下线**：`应用` 之后不再由插件自己重启 `dsh web`。这条链（detached helper → 杀旧进程 → 同端口起新进程）在 Windows 上的失败模式太多，且都无法在插件侧稳定兜底：
  - 端口「假空闲」：`connect` 被 RST 时误判端口已空，新进程直接 `EADDRINUSE` 秒退；
  - 假成功：旧进程还占着端口的那 200ms 里，helper 看到「有人监听」就报交接完成，旧进程随后退出 —— 现象就是「重启后 web 没了，要手动 `dsh web`」；
  - helper 自己死在半路（杀完旧进程后没有任何日志），端口上什么都不剩。
  现在 `scheduleRestart` 只返回一份**手动重启说明**（`needsManualRestart` + `command` + `note`），宿主进程原样保留，页面不断。面板会弹「需要手动重启」并显示要执行的命令（带当前端口），提示词部分即时生效，代码补丁在重启后生效。
- **删掉的东西**：`scripts/verify-restart.mjs`、`scripts/verify-epipe.mjs`、`test/restart-url.test.js`。`/dsh-purge/restart` 在 web 端不再杀进程、不再 spawn。
- **过渡期垫片**：`lib/restart-web.js` 保留了一个几十行的兼容文件。原因只有一个 —— 用户机器上可能还跑着**旧版内存代码**，旧代码在点「重启」时会 detached 拉起这个文件再自退；文件不在就会把 web 弄死。垫片只「等端口释放 → 把 `dsh web` 拉回来」，不杀进程、不判断交接。下一版可删。
- **新增回归测试** `test/restart-manual.test.js`：守住「重启只能回说明、不能声明 restarting」。
- **保留**：`lib/web-reclaim.js` 与注入宿主 `bin.js` 的启动前回收脚本，用于清掉旧版本遗留的 detached server，避免 `EADDRINUSE` 起不来。
- 卸载流程不变（仍然退出 → 删目录 → 重新拉起），因为它必须等宿主退出才能删干净。

## English

- **1.1.91** (fork change; upstream 1.1.89 / 1.1.90 merged).
- **Automatic restart removed**: applying patches no longer restarts `dsh web` from inside the plugin. The handoff chain (detached helper → kill old process → spawn on the same port) had too many failure modes on Windows and no reliable plugin-side fallback:
  - false "port free": a RST on `connect` was read as "port is free", so the new process died immediately with `EADDRINUSE`;
  - false success: while the old process still held the port for ~200ms, the helper saw "something is listening" and reported a completed handoff; the old process then exited, leaving nothing behind — exactly "restart leaves web dead, I have to run `dsh web` myself";
  - the helper itself could die mid-handoff (no log line after killing the old server), leaving the port unserved.
  `scheduleRestart` now only returns a **manual restart plan** (`needsManualRestart` + `command` + `note`); the host process is left untouched and the page stays connected. The panel shows "manual restart needed" with the exact command (including the current port). Prompt changes are live immediately; code patches take effect after the restart.
- **Removed**: `scripts/verify-restart.mjs`, `scripts/verify-epipe.mjs`, `test/restart-url.test.js`. `/dsh-purge/restart` no longer kills or spawns anything on web.
- **Migration shim**: `lib/restart-web.js` stays as a ~40-line compatibility file, only because a machine may still be running the **previous version in memory**: that code detaches this file on "Restart" and then exits itself. The shim only waits for the port to free and spawns `dsh web` back — no killing, no handoff verification. Removable next release.
- **New regression test** `test/restart-manual.test.js` to keep the auto-restart from creeping back.
- **Kept**: `lib/web-reclaim.js` and the boot-time reclaim injected into the host `bin.js`, which still clears detached servers left by older versions.
- Uninstall is unchanged (exit → delete → relaunch), because it must wait for the host to exit before deleting its own files.

# 1.1.90

## 中文

- 版本 **1.1.90**。
- **#208 Android 切后台回来输入框整块消失**：撤销按钮原先注册在宿主的 `conversation.input.right` 槽位，这个槽位渲染在 composer 的 React 子树里。宿主在提交阶段只要抛一次错，React 会把整棵树卸载，症状就是输入框连带按钮一起没了。
  - 撤销按钮不再走任何槽位。改为在 `body` 上挂一个 `position: fixed` 的宿主节点，用 `createPortal` 把按钮传进去，渲染树完全脱离 composer；composer 内部再出错也牵连不到它。
  - 位置按最靠下的那组 `.standardControls`（就是 composer 底部工具条）的矩形实时对齐，并给它留 `padding-left` 空位，不遮住模型选择器；预留宽度跟着按钮实测宽度走。
  - 会话切换、窗口尺寸变化、页面滚动都会重新对齐；没有会话时按钮不显示、留白也一起归还。
  - 锚点查找带缓存和节流，只在锚点缺失或掉线时才扫一次 DOM，长会话滚动不受影响。
- **验证**：`client.js` 语法检查通过；`conversation.input.right` 在本插件中已无任何注册点；双宿主 `standardControls` 类名核对一致。

## English

- **1.1.90**.
- **#208 the whole composer vanished after switching apps**: the undo button was registered into the host's `conversation.input.right` slot, which renders inside the composer's React subtree. One throw during a commit phase makes React unmount that tree, and the input box goes with it.
  - The undo button no longer uses any slot. It renders through `createPortal` into a `position: fixed` host appended to `body`, fully outside the composer subtree, so a composer error can no longer take it down.
  - It aligns itself to the rectangle of the bottom-most `.standardControls` (the composer toolbar) and reserves `padding-left` there so the model picker is not covered; the reserved width follows the button's measured width.
  - It re-aligns on session change, resize and scroll, and releases both the button and the reserved space when there is no session.
  - Anchor lookup is cached and throttled: the DOM is scanned only when the anchor is missing or detached, so long chats keep scrolling smoothly.
- **Verification**: `client.js` passes the syntax check; no `conversation.input.right` registration remains in the plugin; the `standardControls` class name matches on both hosts.

# 1.1.89

## 中文

- 版本 **1.1.89**。
- **#204 工作目录提示恢复**：`deployment:persona-suffix` 优先写会话真实 cwd 字面量（`interpolate: false`），拿不到才退静态描述；同时把 `cwd` 补进 `assembly.variables`，用户自己模板里的 `{{cwd}}` 也能渲染。0.2.1 不再抛 `unknown prompt variable`，工作目录提示不再变成 `the current workspace`。
- **#207 桌面静默退出可诊断**：
  - 新增 #92：宿主每次退出都把 `code` / `signal` / stderr 尾巴写进 `%TEMP%\dsh-purge-desktop.log`（不再只记 signal 分支）。
  - 新增 #93：主进程记录 `boot` / `before-quit` / `will-quit` / `quit code` / `window-all-closed` / `render-process-gone`（附渲染进程最后几行 console）/ `child-process-gone` / 信号 / 每分钟心跳。只用 `uncaughtExceptionMonitor`，不改变崩溃行为。
  - asar 换包脚本：`Move-Item` 失败后改用 `.NET File.Move` 重试，成功/失败都 `Test-Path` 复核并记录真实错误；空闲改名脚本同样记录失败原因（限流，不刷屏）。
- **#202 原子写**：`atomicWriteFile` 保持 `writeFile + rename`（不依赖 hostFs 白名单里没有的 `open`）；CLI `--apply` 成功后补打应用戳，下次启动 settle 不会误判未对齐再重打。
- **修复重复标记**：#32 / #53 的 export 行锚点原来自我匹配，每点一次「应用」就多追加一行注释；改成带负向前瞻的正则，连续应用保持幂等。
- **验证**：web + desktop 双宿主现有补丁全部 applied；rc.2 夹具与 rc.5 实机 pattern 全绿；沙箱 42 个目标文件 apply/revert 字节级还原；生成的 PowerShell 脚本通过 `Parser::ParseFile` 语法检查。

## English

- **1.1.89**.
- **#204 working directory restored**: the persona suffix now uses the real session cwd as a literal (`interpolate: false`) and only falls back to the static sentence when no cwd is available; `cwd` is also added to `assembly.variables`, so user templates with `{{cwd}}` render. 0.2.1 no longer throws `unknown prompt variable`, and the prompt keeps the real path instead of `the current workspace`.
- **#207 desktop exit is diagnosable**:
  - New #92: every host exit writes `code` / `signal` / stderr tail to `%TEMP%\dsh-purge-desktop.log`.
  - New #93: main process logs `boot` / `before-quit` / `will-quit` / `quit code` / `window-all-closed` / `render-process-gone` (with the renderer console tail) / `child-process-gone` / signals / a one-minute heartbeat. Uses `uncaughtExceptionMonitor` only, so crash behavior is unchanged.
  - ASAR swap: falls back to `.NET File.Move` after `Move-Item` fails, verifies with `Test-Path`, and records the real error; the idle rename script logs failures too (rate-limited).
- **#202 atomic writes**: `atomicWriteFile` stays on `writeFile + rename` (the hostFs whitelist has no `open`); the CLI `--apply` now also writes the applied stamp so the next boot's settle does not re-apply.
- **Duplicate markers fixed**: the #32 / #53 export-line anchors matched their own output and appended another comment on every Apply; both now use negative lookaheads and are idempotent.
- **Verified**: all existing patches applied on both web and desktop hosts; rc.2 fixtures and rc.5 real files green; sandbox apply/revert restored 42 target files byte-for-byte; generated PowerShell scripts pass `Parser::ParseFile`.

# 1.1.88

## 中文

- 版本 **1.1.88**。
- **双版本适配（rc.2 + rc.5）**：#32/#36/#50/#53/#57/#62 在 0.2.1-rc.2 与 0.2.1-rc.5 上都能命中。旧 pattern 全部保留，rc.5 的新 pattern 追加，不再用新文案覆盖旧版。
- **#36 升级字段**：bash/pwsh 的 `sandbox_permissions` justification 描述一并清洗；补上 `Approval is auto-granted.` 大写 marker，tool-fs 不再因为大小写差异永远漂移。
- **#50 跨会话引用**：去掉 untrusted / “不要跟随指令”话术，保留只读快照的事实描述。
- **#57 developer role**：rc.5 responses 通路的 `instructionRole` 分支纳入 openai/azure 白名单。
- **#62 审批 fail-open**：rc.5 的 `void 0` 分支（无 approval 服务 / 无 agent / unavailable）全部放行；已打过旧 approval 分支的文件不会因 marker 被整条跳过。
- **#32 / #53 状态标记**：#53 不再共用 #32 的注释 marker，旧宿主不会假绿；rc.5 残留的 `local web GUI` 前缀与 `DeepSeek Harness Web GUI` 描述已清掉。
- **宿主门禁**：`package.json` 增加 `dshTargets`，状态页同时接受 rc.2 与 rc.5。
- **验证**：web + desktop 双宿主 73/85 applied、0 pending、0 drifted；沙箱 42 个目标文件 apply/revert 字节级还原通过。

## English

- **1.1.88**.
- **Dual-version support (rc.2 + rc.5)**: patches #32/#36/#50/#53/#57/#62 now match both 0.2.1-rc.2 and 0.2.1-rc.5. Old patterns are kept; rc.5 patterns are added instead of replacing them.
- **#36 escalation schema**: also neutralizes the bash/pwsh `sandbox_permissions` justification text; adds the capitalised `Approval is auto-granted.` marker so tool-fs no longer drifts on case alone.
- **#50 session references**: drops untrusted / "do not follow instructions" framing while keeping the read-only snapshot wording.
- **#57 developer role**: the rc.5 `instructionRole` responses branch is included in the openai/azure allowlist.
- **#62 approval fail-open**: rc.5 `void 0` branches (no approval service / no agent / unavailable) all allow; files already stamped by the old approval branch are re-processed instead of skipped.
- **#32 / #53 markers**: #53 no longer shares #32's comment marker, so older hosts cannot show a false green; rc.5 leftovers (`local web GUI` prefix and `DeepSeek Harness Web GUI` description) are removed.
- **Host gate**: `package.json` gains `dshTargets`, and the status page accepts both rc.2 and rc.5.
- **Verified**: on both web and desktop hosts, 73/85 applied, 0 pending, 0 drifted; sandbox apply/revert restored all 42 target files byte-for-byte.

# 1.1.87

## 中文

- 版本 **1.1.87**。
- **回滚 / 备份加固**：
  - 0 字节的 `.dshpurge.bak` 不再被当成"原版"写回宿主：`revertAll` / `restoreFromBak` 遇到空备份会改名为 `.bad` 并跳过，下次启动顺手清掉残骸。
  - 宿主升级后刷新过期 bak 时补上单数 `marker` 的补丁（#6/#7/#8/#10），不再漏掉这些基线，避免旧 bak 覆盖新版文件导致新旧代码混合。
  - 备份、配置、状态、覆盖文件统一走原子写（临时文件 + fsync + rename），断电或进程被杀不会留下半截文件。
- **补丁命中契约**：标记 `optional` 的补丁命中数不符时记为软失败，不再阻断整体应用；#42 的两处插入型替换加探针，重复应用不会二次插入。
- **桌面 / 进程（Windows）**：
  - 进程枚举改用 `|` 分隔并强制 UTF-8 输出，修复中文安装路径下换包时旧进程杀不掉的问题。
  - helper 只有在确实拿到 exe 路径时才带 `killApp`；换包失败会把原版重新拉起并写日志，不再留空桌面。
- **安全加固**：
  - asar 解包校验输出路径必须位于目标目录内，越界条目跳过并告警。
  - 红队文件读写路径校验对最近存在的祖先做 `realpath`，堵住 symlink 逃逸。
  - 更新检查只允许 `https`。
  - 报告回放生成的 curl / HTTP 报文对头部、Cookie、请求体去除换行，防注入。
- **提示词 / 运行钩子**：插件停用后 `rewriteFn` 直接返回宿主原始装配文本，不再残留注入；停用时清理 assemble guard；运行时缓存签名纳入红队设置、策略与 override 版本，状态变化立即生效。
- **红队演练台**：`listEngagements` 默认不再逐条统计；漏洞列表与报告支持 `evidenceLimit`，大证据不再拖慢面板。
- **子代理**：名额占位改为立即占用（`n+1`），append 失败时回退，避免并发派出超限。
- **CLI**：`--apply` 存在失败项时以退出码 1 结束，脚本调用能感知失败。
- **清理**：删除无引用的 `lib/mnemon-settings.js` 及 13 处死代码 / 未使用的 import；移除 `test/` 目录与 `test` 脚本，发布 CI 只做语法检查。

## English

- **1.1.87**.
- **Rollback / backup hardening**:
  - A zero-byte `.dshpurge.bak` is no longer treated as the original and written back to the host: `revertAll` / `restoreFromBak` rename it to `.bad` and skip it; leftovers are swept on the next start.
  - When refreshing stale backups after a host upgrade, patches that use the singular `marker` form (#6/#7/#8/#10) are now included, so their baseline is not missed and an old backup can no longer overwrite the new file.
  - Backups, config, state and override files are written atomically (temp file + fsync + rename), so a crash never leaves a half-written file.
- **Patch hit contract**: `optional` patches that miss their expected hit count are recorded as soft failures instead of blocking the whole apply; the two insert-type replacements in #42 gained probes so re-applying does not insert twice.
- **Desktop / processes (Windows)**:
  - Process enumeration now uses `|` separators and forces UTF-8 output, fixing the case where the old process survived an asar swap under a Chinese install path.
  - The helper passes `killApp` only when an exe path is known; a failed swap relaunches the original app and writes a log instead of leaving an empty desktop.
- **Security hardening**:
  - Asar extraction verifies each output path stays inside the destination directory; entries outside are skipped with a warning.
  - Red-team path validation resolves `realpath` for the nearest existing ancestor, closing the symlink escape.
  - Update checks accept `https` only.
  - Curl / HTTP replay text strips newlines from headers, cookies and body to prevent injection.
- **Prompt / runtime hooks**: after the plugin is disabled, `rewriteFn` returns the host's assembled prompt unchanged and the assemble guard is cleared; the runtime cache signature now includes red-team settings, policy and override revision so changes take effect immediately.
- **Red-team console**: `listEngagements` no longer computes per-row stats by default; vuln lists and reports accept `evidenceLimit` so large evidence no longer slows the panel.
- **Subagents**: slot reservation now takes effect immediately (`n+1`) and rolls back if the append fails, preventing over-limit dispatch under concurrency.
- **CLI**: `--apply` exits with code 1 when any item failed, so scripts can detect the failure.
- **Cleanup**: removed the unreferenced `lib/mnemon-settings.js` plus 13 dead functions / unused imports; dropped the `test/` directory and `test` script — release CI now runs syntax checks only.

# 1.1.86

## 中文

- 版本 **1.1.86**。
- **Web「应用 → 自动重启」后残留 server 导致 EADDRINUSE 起不来（#197，合并 PR #197）**：
  - `restart-web.js` 把后台 server 的 pid/url 记到 `$DSH_HOME/dsh-purge/web-server-<port>.json`；`killOldServer` 增加按端口兜底，清掉旧版本留下、没有记录的孤儿。
  - 新增 `lib/bin-preflight.js`：把回收钩子注入宿主 `bin.js` 顶部（跨平台），在 Cordis 激活、webserver 绑端口之前先回收残留；只杀命令行命中 `@deepseek-ai/dsh/lib/bin.js … web` 的进程。
  - 重启时打印「后台运行、关窗不会停」，避免把提示符返回误判成程序已退出。
  - 加固：记录里的 pid 拿不到命令行时，必须仍占着该端口才允许杀，防 PID 复用误杀；杀不掉就保留记录下次再试；杀完等待进程真正退出再绑端口。
- **桌面端点「应用」换包顺序（#198，合并 PR #198）**：
  - 先按安装根路径且不含 `--type=` 识别并杀掉 Electron main，再扫安装目录其余进程，避免 host 先死、main 还活着弹「host stopped」。
  - 挪包失败（asar 仍被占用）时补上 `Start-Process`，把原版应用拉起来并写入 `%TEMP%\dsh-purge-desktop.log`，不再留空桌面。
- 测试：96/96 通过。

## English

- **1.1.86**.
- **Stale web server after "Apply → auto restart" caused EADDRINUSE on boot (#197, merged PR #197)**:
  - `restart-web.js` records the background server pid/url in `$DSH_HOME/dsh-purge/web-server-<port>.json`; `killOldServer` now also reclaims by port, catching orphans left by older versions with no record.
  - New `lib/bin-preflight.js` injects a reclaim hook at the top of the host `bin.js` (cross-platform) so it runs before Cordis activates and before the webserver binds; only processes whose command line matches `@deepseek-ai/dsh/lib/bin.js … web` are killed.
  - The restart prints "running in the background; closing this window will NOT stop it" so the returned prompt is not mistaken for an exit.
  - Hardening: when the recorded pid's command line cannot be read, it is killed only if it still listens on that port (guards against PID reuse); a failed kill keeps the record for the next boot; boot waits for the killed process to actually exit before binding.
- **Desktop asar swap order (#198, merged PR #198)**:
  - Electron main is identified by install root plus "no `--type=`" and killed first, then the rest of the install tree is swept, so the host no longer dies while main stays alive showing a "host stopped" dialog.
  - If the asar move fails (still locked), the original app is relaunched and the reason is appended to `%TEMP%\dsh-purge-desktop.log` instead of leaving an empty desktop.
- Tests: 96/96 pass.

# 1.1.85

## 中文

- 版本 **1.1.85**。
- **#196**：修复深色模式下部分按钮白底白字、完全看不清的问题。
  - 根因：宿主暗色主题把 `--dsw-alias-brand-primary` 解析成近白色（`neutral-bluish-50` `#f9fafb`）。插件里凡是"品牌色作底 + 白字"的按钮（设置页的「应用」「保存注入」、演练台的「保存」「检索」「检测连通性」以及各类主按钮）在暗色下就变成一整块白。
  - 现在暗色（`body[data-ds-dark-theme]`、`[data-theme="dusk"]`）下主按钮统一用绿色实底 `#3d8f68` + 白字，悬停用更深的 `#347a59`；`-webkit-text-fill-color` 一并显式指定，避免宿主强制白字穿透。
  - 报告里的步骤序号圆点（`.rt-rep-step-no`）同样改为绿底白字。
  - 浅色模式表现不变；新增 `test/client-dark-theme.test.js` 静态守护这几条暗色规则。
- 测试：84/84 通过。

## English

- **1.1.85**.
- **#196**: fix buttons in dark mode rendering as a solid white block (white text on white background).
  - Root cause: the host dark theme resolves `--dsw-alias-brand-primary` to a near-white token (`neutral-bluish-50`, `#f9fafb`). Every plugin button that used "brand color as background + white text" (settings **Apply**, **Save injection**, drill console **Save**, **Search**, **Test connectivity**, and other primary buttons) turned into a white block in dark mode.
  - Primary buttons under dark themes (`body[data-ds-dark-theme]`, `[data-theme="dusk"]`) now use a solid green `#3d8f68` with white text, with `#347a59` on hover; `-webkit-text-fill-color` is set explicitly so host-forced white text cannot leak through.
  - The report step-number dots (`.rt-rep-step-no`) are switched to the same green/white pair.
  - Light mode is unchanged; added `test/client-dark-theme.test.js` to guard these dark-mode rules.
- Tests: 84/84 pass.

# 1.1.84

## 中文

- 版本 **1.1.84**。
- **尾部锚点与子代理审批接管**（接线 `anchor.js` / `subagent-control.js`）：
  - 锚点段物理追加到 system prompt 的 sections 数组末尾（waterfall 按数组顺序渲染，order 不参与排序），把身份与格式规则放回 recency 位；已有同名段先滤再追加，不会出现两份。
  - 锚点规则改为跟随操作者语言：中文请求回中文，锚点本身是英文不算语言指令；删掉写死的英文开头句（这是红队模式回答变英文的直接原因）。
  - 子会话被宿主写成 `approval/policy = "never"` 时改回 `ask`，并在 `approval/request` 瀑布放行，子代理不再"一直被拒"。
  - 回滚开关：`anchorMode: "off"`、`subagentControl: false`。
- **红队模式中文化**：模式名与描述、角色名、五阶段攻击链、25 项计分规则与 POC 分类、技能修复说明、环境适配提示、面板与服务端报错、成果报告与成果复现报告全部回中文。
- **#194**：desktop 端启动后窗口永不显示。
  - hung-operator 提示改为按内容变更缓存（home + mtime + 已提交修订号），内容没变不再每轮重算约 23KB。
  - 增加风暴熔断（10 秒 120 次）与慢调用熔断（1.5 秒触发、30 秒冷却），熔断期直接返回缓存文本，不挂死 desktop host。
  - 同一次 assemble 的重复改写用 WeakMap 去重。
  - 新增补丁 **#91**：宿主 `code === null || signal` 静默 resolve 前写一条 `[desktop.hostExit]` 到 `%TEMP%\dsh-purge-desktop.log`，保持不弹框但有据可查。
- **#188（0.2.1-rc.4 专属部分）**：新增 **#89** 沙箱策略去品牌、**#90** skill-badge 描述中文化，扩展 **#32/#53** 的 rc.3 变体与 marker；三条新补丁均为 optional，宿主没有对应文件时静默跳过。
- 测试：81/81 通过；新增锚点接线与红队文案测试。

## English

- **1.1.84**.
- **Tail anchor and subagent approval takeover** (wiring `anchor.js` / `subagent-control.js`):
  - The anchor section is physically appended to the end of the system-prompt sections array (the waterfall renders by array order, not by `order`), putting identity and format rules back in the recency slot; any existing same-named section is filtered first so there is never a duplicate.
  - Anchor rules now follow the operator's language: a Chinese request gets a Chinese answer, and the anchor being written in English is not a language instruction. The hard-coded English opener was removed (the direct cause of red-team mode answering in English).
  - When the host writes `approval/policy = "never"` for a child session, it is flipped back to `ask` and allowed in the `approval/request` waterfall, so subagents are no longer refused every time.
  - Rollback switches: `anchorMode: "off"`, `subagentControl: false`.
- **Red-team mode localized to Chinese**: mode name and description, role names, the five-stage attack chain, the 25-item scoring rules and POC categories, skill-fix guidance, environment-adaptation hints, panel and server messages, and both the results report and the replay report.
- **#194**: desktop window never appears after launch.
  - The hung-operator prompt is now cached by content change (home + mtime + committed revision); an unchanged prompt is no longer rebuilt (~23KB) on every refresh.
  - Storm breaker (120 calls / 10s) and slow-call breaker (trip at 1.5s, 30s cooldown) return the cached text instead of stalling the desktop host.
  - Duplicate rewrites within the same assemble call are deduped with a WeakMap.
  - New patch **#91**: before the host silently resolves `code === null || signal`, append a `[desktop.hostExit]` line to `%TEMP%\dsh-purge-desktop.log` — still no dialog, but no longer invisible.
- **#188 (0.2.1-rc.4-specific parts)**: new **#89** sandbox-policy brand neutralization and **#90** skill-badge description localization, plus rc.3 variants and markers for **#32/#53**; all three new patches are optional and are skipped silently when the host has no matching file.
- Tests: 81/81 pass; new coverage for anchor wiring and red-team copy.

# 1.1.83

## 中文

- 版本 **1.1.83**。修复 bug，修复稳定性。
- **#185**：修复 pnpm 11（DSH 内置 11.2.2）下 `pnpm install` 因 `allowBuilds` 崩溃的问题。
  - 之前 profile 的 `pnpm-workspace.yaml` 会写入 `dsh-purge@https://...` 这类 URL 键，pnpm 把它当版本联合解析，直接报 `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`。
  - 现在只写裸包名 `dsh-purge`：pnpm 的 `allowBuilds` 本来就按包名匹配，tarball / git / registry 三种安装形态都放行。
  - 自愈加强：所有 `dsh-purge@*` 历史键（URL 键、旧截断键 `dsh-purge@https`、`@1.1.81` 之类版本键）一律清掉，只保留裸包名；非 dsh-purge 的键原样保留。
- **#191**：修复 macOS DSH Desktop（0.2.1-rc.4）启动崩溃 `failed to parse overlay .../cordis.patch.yml`。
  - 宿主生成的 profile 层 `cordis.patch.yml` 可能整体只有一个空 flow 序列 `[]`，那本身就是一个完整 YAML 文档；再往文件尾追加 `- insert:` 会变成第二个文档，宿主解析直接失败。
  - 现在写之前先判断数据部分形态：空 flow 序列（`[]`，可带 `---` 前缀）→ **替换** `[]` 整行而不是追加；空文件 / 只有注释 → 直接写 insert 块；正常块序列 → 沿用原来的追加行为。
  - 非空 flow 序列（宿主或用户自己的内容）认不准就不动，返回 `{ ok: false, wrote: false }`，宁可留着也不写坏。

## English

- **1.1.83**. Bug fixes and stability.
- **#185**: fix `pnpm install` crashing under pnpm 11 (11.2.2, bundled with DSH) because of `allowBuilds`.
  - The profile `pnpm-workspace.yaml` used to get a `dsh-purge@https://...` URL key, which pnpm parses as a version union and rejects with `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`.
  - Now only the bare package name `dsh-purge` is written: pnpm matches `allowBuilds` by package name, so tarball / git / registry installs are all allowed.
  - Stronger self-healing: every `dsh-purge@*` legacy key (URL keys, truncated `dsh-purge@https`, `@1.1.81`-style version keys) is dropped and only the bare name is kept; non-dsh-purge keys are preserved as-is.
- **#191**: fix the macOS DSH Desktop (0.2.1-rc.4) startup crash `failed to parse overlay .../cordis.patch.yml`.
  - The host-generated profile `cordis.patch.yml` may consist of a single empty flow sequence `[]`, which is already a complete YAML document; appending `- insert:` after it creates a second document and the host fails to parse it.
  - The data shape is now detected before writing: an empty flow sequence (`[]`, optionally `---`-prefixed) → **replace** the `[]` line instead of appending; empty file / comments only → write the insert block; a normal block sequence → the previous append behaviour is kept.
  - A non-empty flow sequence (host or user content) is left alone and returns `{ ok: false, wrote: false }` — better to skip than to write something broken.

# 1.1.82

## 中文

- 版本 **1.1.82**。修复 bug，修复稳定性。
- **#180**：修复 profile 的 `pnpm-workspace.yaml` `allowBuilds` 被反复写坏（`dsh-purge@https: true` 畸形键 → `ERR_PNPM_INVALID_VERSION_UNION`，重复键 → `duplicated mapping key`）。
  - URL 键解析不再被冒号截断；写回含 `://` 的键自动加引号。
  - 重写只保留精确等于期望键的 `dsh-purge@*`，旧污染键（畸形的、过期的版本/commit URL）自动清掉，不用手工修。
  - 期望键优先从 profile 的 `pnpm-lock.yaml` 读实际解析的 tarball URL（固定 commit 安装也不再有双 URL 键），读不到才退回 `package.json`。
  - 重写结果先过最小 YAML 校验（键不重复、round-trip 无损），不过就不写盘；健康文件零写入，启动不再反复重写。

## English

- **1.1.82**. Bug fixes and stability.
- **#180**: stop rewriting the profile `pnpm-workspace.yaml` `allowBuilds` into garbage (`dsh-purge@https: true` malformed key → `ERR_PNPM_INVALID_VERSION_UNION`; duplicated keys → `duplicated mapping key`).
  - URL keys no longer truncate at the first colon; keys containing `://` are written back quoted.
  - Rewrites keep only `dsh-purge@*` keys exactly equal to the wanted set; stale polluted keys (malformed, old version/commit URLs) self-heal away on the next ensure.
  - The wanted key prefers the tarball URL actually resolved in the profile `pnpm-lock.yaml` (fixed-commit installs no longer get a duplicate URL key); falls back to `package.json`.
  - Rewritten output passes a minimal YAML check first (no duplicate keys, lossless round-trip); healthy files are never written again, so boot no longer rewrites each run.

# 1.1.81

## 中文

- 版本 **1.1.81**。修复 bug，修复稳定性。
- **#174**：识别 DSH NEXT 社区桌面（路径、进程、快捷方式、密封 asar）。`DSH_SURFACE=web` 也不再误报；不把任意 `app.asar` 当桌面。
- **#175**：补 ip / 计分 / settle 单测，删草稿文档和 `.bak`。`npm test` 23 条全过。
- **#171 / #173**：zip 目录条目和 skills `fs` 导入已在 1.1.80，本版用单测锁住。

## English

- **1.1.81**. Bug fixes and stability.
- **#174**: detect DSH NEXT desktop (paths, process, shortcuts, sealed asar). Still desktop when `DSH_SURFACE=web`. A random `app.asar` is not treated as the host.
- **#175**: add ip / score / settle tests; drop draft docs and `.bak`. `npm test` is 23/23 green.
- **#171 / #173**: zip directory entries and the skills `fs` import shipped in 1.1.80; this release locks them with tests.

# 1.1.80

## 中文

- 版本 **1.1.80**。修复 bug，修复稳定性。
- **#168**：pnpm 12 的 `allowBuilds` 把 `dsh-purge@codeload...` 也写成 `true`，装别的插件不再留下 `set this to true or false`。
- **#169**：芯片 / 应用按钮强制系统字体和实色字，不再被宿主图标字体吃掉。
- **#170**：纯 Node 解 zip 时目录条目建目录，不再写成同名空文件导致 EEXIST。
- **#172**：`lib/skills.js` 补上 `fs`，#54 软链重叠守卫重新生效。
- **#176**：写清 **不支持 DSH 0.2.1-rc.3 及更新的 rc**，请退回 **0.2.1-rc.2**。对不上的补丁待应用或跳过，不乱改文件。

## English

- **1.1.80**. Bug fixes and stability.
- **#168**: pnpm 12 `allowBuilds` also sets `dsh-purge@codeload...` to `true`, so installing other plugins no longer leaves `set this to true or false`.
- **#169**: chip / Apply buttons force a system font and solid text color so the host icon font cannot hide the label.
- **#170**: Node zip fallback creates directories for directory entries instead of empty files (no more EEXIST).
- **#172**: import `fs` in `lib/skills.js` so the #54 symlink overlap guard works again.
- **#176**: **DSH 0.2.1-rc.3 and newer RCs are not supported.** Stay on **0.2.1-rc.2**. Unmatched patches stay pending or skipped.

# 1.1.79

## 中文

- 版本 **1.1.79**。修复 bug，修复稳定性。
- **#165**：社区版 DS Bot / DeepSeek Bot 按桌面宿主识别（`ds-bot` profile、Electron asar），不再误报 `set DSH_BASE`。
- **#166**：pnpm 12 拦 `postinstall` 时补 `allowBuilds`，并写清 `--allow-build=dsh-purge` / `approve-builds`。
- **#167**：升级后补回 `bundles` + 本体 insert，空芯片不再把启动钮藏掉，1.1.74 有的按钮会回来。
- 应用/还原/卸载进度条跟 job 阶段；主智能体和子智能体同一份注入、权限和能力协议。
- 新建会话不再把 `dsh-purge` 芯片甩到行尾。

## English

- **1.1.79**. Bug fixes and stability.
- **#165**: community DS Bot / DeepSeek Bot is a desktop host (`ds-bot` profile, Electron asar); no more false `set DSH_BASE`.
- **#166**: pnpm 12 skipped `postinstall`; write `allowBuilds` and document `--allow-build=dsh-purge`.
- **#167**: restore `bundles` + body insert after upgrade so the 1.1.74 button comes back.
- Apply / revert / uninstall progress follows the job; main and subagents share inject, permission, and capability text.
- New-session no longer shoves the `dsh-purge` chip to the far right.

# 1.1.78

## 中文

- 版本 **1.1.78**。修复 bug：停用/卸载后无法新建会话。
- **#108**：停用或卸载时把 `agent-preset-registry.selectedDefault` 从 `redteam` 改回 `standard`，并清掉 `$DSH_HOME/.agent-presets/redteam`。热重载不会冲掉用户设的红队默认。
- 卸载同时处理 `dsh.profile.bundles` / `dsh.profile.plugins`，桌面 profile 不再残留 `dsh-purge`。

## English

- **1.1.78**. Bug fix: new sessions after disable/uninstall.
- **#108**: on disable or uninstall, reset `agent-preset-registry.selectedDefault` from `redteam` to `standard`, and remove `$DSH_HOME/.agent-presets/redteam`. Hot reload keeps a user-chosen redteam default.
- Uninstall also strips `dsh.profile.bundles` / `dsh.profile.plugins`.

# 1.1.77

## 中文

- 版本 **1.1.77**。修复 bug，修复稳定性。
- 修长红队任务仍打公网：`渗透测试` / `红队` / `打点` / `拿站` 纳入门禁；正文按窗扫到 256KB，目标写在后半段也能拦。
- 修后续步骤漏拦：每一步看工具参数，`tools/pre-execute` 遇到公网 IP/域名直接停轮。
- 长文正则按窗扫，避免整篇回溯把事件循环卡死。

## English

- **1.1.77**. Bug fixes and stability.
- Long red-team tasks no longer reach the public internet: `渗透测试` / red-team / 打点 / 拿站 are gated; the body is scanned in windows up to 256KB.
- Later steps are gated too: tool arguments are checked, and `tools/pre-execute` stops on a public IP or name.
- Long-text regex runs in windows so a huge paste cannot stall the event loop.

# 1.1.76

## 中文

- 版本 **1.1.76**。适配只走 pnpm 的机器：在 profile 目录 `pnpm add` codeload 压缩包即可，`postinstall` 自动把 `dsh-purge` 写进 `bundles`。
- 安装地址改成 `codeload.github.com`，避开 `github.com/archive` 的 302（pnpm 会 `fetch failed`）。不要 `pnpm add dsh-purge`（npm 仓库没有这个名字）。

## English

- **1.1.76**. pnpm-only hosts: `pnpm add` the codeload tarball inside the profile; `postinstall` writes `dsh-purge` into `bundles`.
- Install URL is `codeload.github.com` so pnpm does not die on the `github.com/archive` 302. Do not `pnpm add dsh-purge` — that name is not on the npm registry.

# 1.1.75

## 中文

- 版本 **1.1.75**。修 Hub 市场一键安装报 `already queued: dsh-purge`：`cordis.patch.yml` 不再把已经在 bundles 里的本体再 insert 一遍。
- README 把安装写成三步：只用 GitHub 压缩包命令，不走插件市场 / `github:` / npm。

## English

- **1.1.75**. Fix Hub one-click `already queued: dsh-purge`: the bundle patch no longer inserts the plugin that is already in `bundles`.
- README install is three steps: GitHub tarball only; skip the plugin market / `github:` / npm.

# 1.1.74

## 中文

- 版本 **1.1.74**，优化若干拦截与加载 bug。适配 DSH **0.2.1-rc.2**（0.2.0 仍可用）。
- 修靶场门禁：域名先解析再判 IP，不再靠 `.lab` / `.htb` 后缀放行；`hosts` 指到公网、解析失败、混有公网，一律拦。
- 修身份绕过：`169.254` 云元数据不再当靶场；`::ffff:公网` 拆开再判；攻击句不写目标不再放行。
- 修 DSH 0.2.1 预设加载：对象 schema 补 `additionalProperties`，装过的 redteam 预设清掉残留 `toolFilter`。
- 修演练台被改成英文：中文页签收回。
- 禁止制作外挂：会话门口硬拦，提示词 Rule 1 改为禁止。

## English

- **1.1.74**, bug-fix release. Target DSH **0.2.1-rc.2** (0.2.0 still works).
- Lab gate: resolve first, then allow only private IPs. Suffixes are not an allow list.
- Close identity holes: drop link-local metadata, unwrap IPv4-mapped IPv6, deny unnamed attack tasks.
- DSH 0.2.1 preset load: seal object schemas; strip leftover `toolFilter`.
- Restore Chinese drill-console tabs.
- Game cheats are forbidden at the session gate.

# 1.1.73

## 中文

- 版本 **1.1.73**，适配 DSH **0.2.1-rc.2**（0.2.0 仍可用）。
- 0.2.1 兼容已落地：`{{cwd}}` 静态回退、补丁 #40、`toolFilter` 删除、`dsh-tools` 解析、hostFs fd 直通、桌面换包不自杀、`file:` 归档更新、Ctrl+Enter steer。
- 界面操作文案补齐英文（演练台、清洗面板、补丁表、计分/技能指引）；`zh` 语言包与模型提示词保持中文。靶场默认拦截的 `own.hint` 仍按本仓库策略。
- 随包技能 `paper-autopilot` + `npm run install:skill`。
- 红队证据账本：`claimed → observed` 核实链、`ResidualUnknown`、8 个 `redteam_evidence_*` / `redteam_unknown_*` 工具。

## English

- **1.1.73**, target DSH **0.2.1-rc.2** (0.2.0 still works).
- 0.2.1 compatibility in-tree: `{{cwd}}` fallback, patch #40, drop `toolFilter`, host `dsh-tools` resolve, hostFs fd pass-through, desktop helper self-kill fix, `file:` archive update, Ctrl+Enter steer.
- Operator-facing UI copy is English; `zh` locale and model prompts stay Chinese. Lab default-deny `own.hint` is unchanged.
- Bundled `paper-autopilot` skill + `npm run install:skill`.
- Red-team evidence ledger: claimed→observed verification, ResidualUnknown, eight `redteam_evidence_*` / `redteam_unknown_*` tools.

# 1.1.71

## 中文

- 版本 **1.1.71**。
- 修复 1.1.70 的 `??` 混 `||`：插件启用时 `failed to import`（桌面 / Web 同一入口）。
- #86 只改 UI 队列 steer → followup；公共 `steer()` 收回 next-step，代理间 `send_message` 仍下一步插入。
- `installed-rev` 跨版本不再沿用旧 `apply:x.y.z`。#88 按现行 `renderedPrompt` / 旧 `system` 锚点打中的那条落标记。
- 发版前 `node --check` 主入口，避免再把语法错误打进 Release。

## English

- **1.1.71**.
- Fix 1.1.70 `??` mixed with `||`: enable failed to import on desktop and web.
- #86 keeps UI queue steer → followup. Public `steer()` is next-step again so `send_message` inserts at the next step.
- Stale `apply:x.y.z` in `installed-rev` refreshes across versions. #88 marks the host anchor that actually exists (`renderedPrompt` or `system`).
- Release CI syntax-checks the plugin entry.

# 1.1.70

## 中文

- 版本 **1.1.70**。
- Hub / 残装若给 `dsh-purge` 加上 `pluginPackages`，Cordis 会一直 pending，宿主退出码 1。本版把依赖钉回 `systemPrompt` + `tools`。
- 清洗页只合并升级链展示（免责、审批、挂全文、hooks 等），Apply 仍打全部补丁。
- 去掉已无用的 #81 / #89 清单行；挂全文并进 #87，官方 phase-1 走静默放行。
- 指挥端改为「按用户给的目标开工」。合并 #97 / #98 / #99。

## English

- **1.1.70**.
- Hub / incomplete installs that inject `pluginPackages` leave dsh-purge pending and kill the host. Dependencies are pinned to `systemPrompt` + `tools`.
- Clean page groups upgrade-chain patches for display only; Apply still writes every patch.
- Dropped dead #81 / #89 rows. Hang lives in #87. Official phase-1 keep is silent.
- Commander bind: start from the user's target. Includes #97 / #98 / #99.

# 1.1.69

## 中文

- 版本 **1.1.69**。
- 发送时剥掉 ChatML / `project_instructions`，框和磁盘不动。
- 应用 + 重启挂当前默认，不必再点保存；框里仍是插件旧默认会刷到加密槽。
- 红队只排不折：注入 → cap → 红队正文；目标卡/角色段改名 `dshpg-*`。
- 隔离 ctx 也注册 inject/cap；#86 steer 改 next-turn；#87 hang 用 LF 比对。
- 红队操作稿锁「上面的提示词作准」；指挥端去掉「给了单位名就授权」。

## English

- **1.1.69**.
- Peel ChatML / `project_instructions` on the wire; box and disk stay intact.
- Apply + restart hangs the current default; no extra Save. Stale plugin defaults refresh from the sealed slot.
- Redteam: inject → cap → ops only (no fold). Card/role sections renamed `dshpg-*`.
- Isolated ctx also registers inject/cap. #86 steer → next-turn. #87 hang needle uses LF.
- Redteam ops note: inject wins. Commander no longer says a company name means authorized.

# 1.1.68

## 中文

- 版本 **1.1.68**。
- **#92**：技能面板认 YAML 块标量 `description`（`|` / `>`），不再误报不可用。
- **#93**：红队「版本/更新」：`file://` 转成本地路径；Windows 用 `.cmd` + `shell` 起 npm/pnpm；npm 404 回落 GitHub tags。
- **#94**：官方桌面 CLI 入口补 `app.asar.unpacked` 回退。Hub 首次安装仍可能撞官方 asar 路径。
- **#95**：拆除 `refusal-recover`（读错字段永不触发；修好会无限复读）。
- **#96**：bash 前台等待从插件标过的 600s 迁回 60s，后续工具不再被堵 10 分钟。
- 注入置顶；capability 段改名 `dshpg-capabilities`；用户 prompt 一律 followup（#85）；默认关闭自动「继续」。

## English

- **1.1.68**.
- **#92**: Skill panel parses YAML block-scalar `description`.
- **#93**: Redteam update: `file://` → fs path; Windows npm/pnpm via `.cmd`; GitHub tags if registry 404.
- **#94**: Desktop CLI falls back to `app.asar.unpacked`. Hub first-install may still hit stock asar.
- **#95**: Removed `refusal-recover` (dead reader / unbounded nudge loop).
- **#96**: Restore marked bash foreground wait 600s → 60s.
- Inject leads; capability section renamed; user prompt always followup; autoContinue default off.

# 1.1.67

## 中文

- 版本 **1.1.67**。
- **#85**：continue 续跑在传输/429 连错时不再无限兜圈。`takeContinue` 加 failStreak 阈值；`refundContinue` 不清 `lastContinueSeq`，连错 ≥3 直接放弃。
- **#84**：区域拦截的空 Assistant 流改为单批 `text-chunks` 记录（带 `.length`），不再卡住宿主 UI。
- 启动种子：进程启动时若 `$DSH_HOME/prompt-inject.md` 为空或缺失，自动把加密默认稿写一次；用户改过的稿不动。清洗完点重启后，重启成功立刻就能用默认提示词。
- Windows 官方包重启：restart 脚本名改成 `pid+random`，首启不与并发实例打架；多余的 `.cmd` 中介删掉，直接 `wscript.exe //nologo //B` 起脚本；本机旧版无 pid 后缀的脚本/日志超过 24h 启动时自动清。
- 杀进程范围收紧：`ASAR_SWAP_PS1` 不再 `/IM` 杀全名同名进程，只按安装根下 pid 停，避免误伤第三方同名。
- 官方 CLI shim 原地改写之前先存一份 `.dsh-purge.bak`，并走原子写，断电/盘满可回退。
- 首装场景不卡：WScript 判 clean 时，两边都是 null（文件缺或读失败）放行启动，只有任一明确 dirty 才拦。
- 探测缓存：`runningExes` / `shortcutExes` 空结果不再缓存；点"应用"前 `clearDesktopLocateCache()` 仍可强刷。
- `scheduleAsarRenameWhenIdle` 的 `.rename-pending` 锁：时钟回拨或超过 30 分钟视为失效，清掉重做。
- `execFileSync` 三处 PowerShell 调用加 `maxBuffer: 8MB`，大结果不再静默 ENOBUFS 掉。
- 其他：net-scope region gate 指数退避 + IPv6 regex 收紧；identity `injectMatchers` 支持 >4096 分段匹配、`installAssembleGuard` 幂等；hooks-deny 删 R0 兜底规则改原子写；extract-asar commit 不删 `nextDir`，写 `.dshpurge-recover.json` 便回滚；client.js redteam preset 多路检测、shell.submit WeakMap 清理补齐。

## English

- **1.1.67**.
- **#85**: Continue loop no longer spins forever on TRANSPORT/429 streaks. `takeContinue` adds a failStreak gate; `refundContinue` leaves `lastContinueSeq` set; 3 consecutive failures abandon.
- **#84**: Region-gate empty-assistant stream becomes one batched `text-chunks` record (with `.length`), no longer hangs the host UI.
- Boot-time seeding: on startup, if `$DSH_HOME/prompt-inject.md` is empty or missing, the encrypted default is written once; a user-edited file is untouched. After the Apply → cleanup → restart cycle, the default prompt is active immediately.
- Windows official-build restart: restart script name now includes `pid+random`, so concurrent instances don't clobber each other; the `.cmd` intermediary is dropped — `wscript.exe //nologo //B` is spawned directly; legacy unsuffixed scripts/logs older than 24h are purged on each startup.
- Kill scope tightened: `ASAR_SWAP_PS1` no longer uses `/IM` to kill by full name — only pids under the install root are stopped, so same-named third-party processes aren't collateral.
- Official CLI shim repair now saves `.dsh-purge.bak` and uses atomic write before overwriting, so power loss / disk full is recoverable.
- First-install not blocked: when WScript checks for clean markers, two nulls (missing or unreadable) now pass through; only an explicit `false` blocks startup.
- Probe caches: `runningExes` / `shortcutExes` no longer cache empty results; `clearDesktopLocateCache()` on Apply still forces a refresh.
- `scheduleAsarRenameWhenIdle` `.rename-pending` lock: clock skew or ≥30-min-old lock is treated as stale and cleared.
- Three `execFileSync` PowerShell calls get `maxBuffer: 8MB` so large results no longer silent-fail with ENOBUFS.
- Also: net-scope region-gate exponential backoff + stricter IPv6 regex; identity `injectMatchers` segments >4096-char payloads, `installAssembleGuard` is idempotent; hooks-deny drops R0 fallback and uses atomic write for state; extract-asar commit no longer deletes `nextDir` and writes `.dshpurge-recover.json` for rollback; client.js redteam preset detection broadened; `shell.submit` WeakMap cleanup wired.

# 1.1.66

## 中文

- 版本 **1.1.66**。
- **#80**：清洗页可关掉 hooks deny / ask 旁路。关掉且文件干净显示跳过，不计入已应用；关掉后再打开，64/65 会按官方形态再打一次。
- **#81**：继续 / 拒答续跑的来源 kind 改为 `dsh-purge`；限流和传输失败不再自动续一轮。
- 重启后不用点保存也会挂上默认提示词；每一轮都补回全文。空的应用请求不再清空磁盘上的提示词。
- 声明过的 overlay 只剩 `.dshpurge.bak` 时，应用会先拷回再加载。
- 红队报告补上得分点短名。中文 README 恢复题图和预览图。

## English

- **1.1.66**.
- **#80**: The clean page can turn off the hooks deny/ask bypass. Off + clean files show skipped and are not counted as applied. Turning it back on reapplies 64/65 from the official form.
- **#81**: Continue / refusal-recover use source kind `dsh-purge`. RATE_LIMIT and TRANSPORT no longer start another continue turn.
- Restart hangs the default prompt without a Save click; every step puts the full text back. An empty Apply body no longer wipes the disk prompt.
- A declared overlay that exists only as `.dshpurge.bak` is copied back before load.
- Red-team reports get short score-point names. Chinese README restores the banner and preview images.

# 1.1.65

## 中文

- 版本 **1.1.65**。
- 默认提示词按 `lib/default-prompt-inject.md` 重新加密进槽。磁盘上仍是用户自己改过的稿时，不覆盖。
- 红队接入截图登记、得分点看图，以及报告六段。可把某次演练导出成目录。
- 技能正文缺工具路径、缺密钥或 VPS 还是占位符时，不再把整条技能标成不可用。缺口留在详情里。
- 打开页面或组装提示词时，会把当前默认稿同步到磁盘，不必先点保存。
- 删掉没有调用的桌面启动封装、旧迁移脚本，以及已经注释掉的手动继续入口。

## English

- **1.1.65**.
- The default prompt is sealed again from `lib/default-prompt-inject.md`. A prompt the user already edited on disk is left as-is.
- Red team gains shot registration, score-point images, and the six-part report. An engagement can be exported to a folder.
- A skill stays usable when a documented tool path, key, or VPS placeholder is missing. The gap stays on the skill detail.
- Opening the page or assembling the prompt writes the current default to disk, without a Save click first.
- Unused desktop launch helpers, the old migration script, and the commented manual-continue entry are removed.

# 1.1.64

## 中文

- 版本 **1.1.64**。
- 红队流程八项。角色稿只在**新建靶标**时播种；已经建好的靶标，要在演练台里把智能体同步一次才会换成新稿。
- **内网**改为叶子节点，自己按收集、梳理、发现、利用做，不再往下派活。
- 并发名额：不带 key 的 release 只放最早的一条。子智能体结束由服务端自动释放；手动释放必须带上 acquire 返回的 key。
- 预检带 `include` 时只体检点名的技能，不再被全局缺密钥拖成失败。缺项带上由用户执行的修复说明。
- IPv6 计分至少两个冒号，`dc01:389` 这类主机名不再 ×3。计分只留在 `score-rules.js`。
- 攻击链计分跳过已停用的得分点。
- `.env` 认 `export KEY=value`。未加引号的行内注释会剥掉，引号里的 `#` 保留。
- 内网计分 code 改为 `central-system`、`boundary-logical`、`boundary-strong` 等，以 `redteam_score_list` 实际返回为准。
- 漏洞发现和利用从 `priority=high` 打起。优先级为空时，先回报指挥补一轮评估。
- 删掉没有调用的代码。设置页里过期的 `legacyApplyPath(...)` 调用改为 `applyPathOp`。

## English

- **1.1.64**.
- Eight red-team flow fixes. Role prompts seed **new** engagements only; sync agents on an existing engagement to pick them up.
- The internal role is a leaf and does collect, assess, scan, and exploit itself.
- A release without a key drops only the oldest reservation. Ending a subagent auto-releases; a manual release must carry the acquire key.
- Preflight `include` checks only the named skills. Broken items include fixes for the user to run.
- IPv6 scoring needs at least two colons, so `dc01:389` is no longer ×3. Scoring lives only in `score-rules.js`.
- Attack-chain scoring skips disabled score points.
- `.env` accepts `export KEY=value` and strips unquoted inline comments. A `#` inside quotes stays.
- Internal score codes match the live list (`central-system`, `boundary-logical`, `boundary-strong`, and the rest), taken from `redteam_score_list`.
- Vuln-scan and exploit start at `priority=high`. If priority is empty, report back and run another assess first.
- Unused code removed. Stale settings calls to `legacyApplyPath` now call `applyPathOp`.

# 1.1.63

## 中文

- 版本 **1.1.63**。
- 官方更新脚本去掉中文注释，避免 `official update script is not ASCII`。

## English

- **1.1.63**.
- Official update script is ASCII only, so the handoff no longer fails the ASCII check.

# 1.1.62

## 中文

- 版本 **1.1.62**。
- 继续/重试重新打开。
- 锚点门：首轮输出上限 1024→8192，最多 2 步；已调工具即放开，英文思考过不了 we 锚也不再卡住。
- 已有预设的锚点配置与包内不一致时同步，不整份覆盖。

## English

- **1.1.62**.
- Continue/retry is on again.
- Anchor gate: bootstrap cap 8192, max 2 steps; promote after the first tool call.
- Existing presets sync the anchor-gate block when it differs from the package.

# 1.1.61

## 中文

- 版本 **1.1.61**。
- **多宿主 Apply**：npm-global 与桌面 `resources/app` 一并补丁（#72 类路径问题）。
- **#73**：代理 / IP / DNS 等 benign 话题不再误触攻击闸门（`net-scope.js`）。
- **#74**：自定义提示词持久化——`resolveInjectText` 读 `prompt-inject.md`，UI 保存走 `saveOverrideContent`，启动 `ensureOperatorBody`。
- **极简**：#80 保持官方 persistent-shell；UI 选 minimal 以 `agent-preset/selected` 为准（不再被会话头 `standard` 误导）；`adaptInjectForMinimalPreset` 对齐 shell-only 工具表。
- **拒答续跑**：`refusal-recover` 识别「我不做 / 不参与」等句式。
- 注入链：`injectMatchers` 防重复段；默认提示词重加密进 `asset-table.js`。

## English

- **1.1.61**.
- **Multi-host Apply**: patch npm-global and desktop `resources/app` together.
- **#73**: Benign proxy/IP/DNS topics no longer trip the attack gate.
- **#74**: Custom prompt persists via `prompt-inject.md` + `saveOverrideContent`.
- **Minimal**: #80 official shell-only preset; preset from `agent-preset/selected`; runtime `adaptInjectForMinimalPreset`.
- **Refusal recover**: broader Chinese refusal phrasing.
- Inject assembly dedupe; default prompt re-sealed.

# 1.1.60

## 中文

- 版本 **1.1.60**。
- **极简 / PTC**：与标准同一任务却被拦，多半是 preset 里 `run_code`、沙箱、plan 文案未洗净，或内置 minimal 缺 `agent-instructions`。本版反转 #60/#61/#63，minimal 补插件（#26）。**完全退出 → 应用 → 重启 → 新开对话** 后再测。
- **回退 → 重新发送**：「回退一次 / 回退上一轮」留在当前对话；已发送句回到输入框，本轮助手输出与 todo 撤掉。**1.1.60** 起按**当前轮**定位，多轮后不会又退到第一条用户消息（#74/#75 + `lib/rewind.js`）。
- **应用 / 重启**：用户点应用、重启时写入 client 包，避免误报「清洗没有完成，已取消重启」。
- 默认提示词从 `default-prompt-inject.md` **重新加密**进 `asset-table.js`；运行时只读加密槽。
- **#66** Windows `app.asar` 无 JScript 时 PowerShell 换包；**#67** `dsh.cmd` 解包路径；**#69** 演练台 `position:fixed`；**#71** assemble 守卫幂等；**#70** 技能路径按本机 OS 判定；**#68** 文档改为 `desktop` profile + `.tar.gz`（Hub 一键仍走 git，见 README）。

## English

- **1.1.60**.
- **Minimal / PTC**: Same task blocked while standard works → uncleared `run_code`, sandbox, or plan text, or minimal preset missing `agent-instructions`. This release flips #60/#61/#63 and adds the plugin on minimal (#26). **Quit fully → Apply → Restart → new chat** before retesting.
- **Rewind → resend**: Rewind buttons stay in the same chat; your last user line returns to the composer and this round’s assistant output/todos drop. From **1.1.60**, bounds follow the **current turn**, not the first user message (#74/#75 + `lib/rewind.js`).
- **Apply / restart**: User Apply/Restart writes client bundles so restart is not cancelled as “clean incomplete”.
- Default prompt **re-sealed** into `asset-table.js`; runtime reads the encrypted slot only.
- **#66** asar swap PS fallback; **#67** `dsh.cmd`; **#69** dock fixed; **#71** idempotent assemble guard; **#70** skill paths per host OS; **#68** docs: `desktop` + `.tar.gz` (Hub one-click still git — see README).

# 1.1.59

## 中文

- 版本升级到 1.1.59。
- 点应用后不再因为宿主路径或旧标记对不上，就报「清洗没有写进当前宿主」（#65）。
- `resources\app\node_modules` 和 `resources\app\dsh\node_modules` 都认。原文里已经没有官方身份句、也没有丢掉注入的写法时，不再要求那两条标记。
- complete 段补丁同时认 tab 和空格。

## English

- Version 1.1.59.
- Apply no longer reports that the clean missed the current host just because the package path or the old markers do not match (#65).
- Both `resources/app/node_modules` and `resources/app/dsh/node_modules` count. If the official identity sentence and the inject-dropping return are already gone, those two markers are not required.
- The complete-prompt patch matches both tab and space indentation.

# 1.1.58

## 中文

- 版本升级到 1.1.58。
- 打开、应用、重启都会挂上提示词。磁盘上有正文就用磁盘，没有就用规则集，再没有就用内置默认，不用再点保存。
- 启动不再在页面发出之后改写前端 client.js，避免输入框因模块版本号对不上而消失（#63）。
- macOS / Linux 已解包桌面端点应用后会退出并重新打开；清洗标记两种写法都认（#64）。

## English

- Version 1.1.58.
- Open, Apply, and restart all hang the prompt. A saved file wins, then the active rule set, then the built-in default. Save is not required.
- Startup no longer rewrites frontend client.js after the page has taken a module revision, so the composer does not disappear (#63).
- Unpacked macOS and Linux desktop builds quit and relaunch after Apply. Both inject markers count as clean (#64).

# 1.1.57

## 中文

- 版本升级到 1.1.57。
- 应用并重启后，设置框里的提示词直接挂到系统段；框空则用当前规则集。两者都空就停下来要求输入。
- 创造、PTC、极简、unrestricted、梁神与标准模式一样清掉拦截和禁止，并保住各自的工具流程。
- 演练授权按本机目录保存，更新后不用重授权；卸载成功后才清掉。空的环境初始化不再当成已配置。
- 官方 Messages 请求的 system 字段改用当前系统提示，不再钉住第一条。

## English

- Version 1.1.57.
- After Apply and restart, the settings-box prompt is hung on the system section. An empty box uses the active rule set. If both are empty, Apply stops and asks for a prompt.
- Cordis, PTC, minimal, unrestricted, and Liangshen clear intercepts and bans the same way standard does, and keep their own tools.
- Drill authorization is stored in this install and survives updates. It is cleared only after uninstall succeeds. An empty environment init is no longer treated as configured.
- The official Messages request system field uses the current system prompt instead of the first snapshot.

# 1.1.56

## 中文

- 版本升级到 1.1.56。
- 应用按设置框、当前规则集、官方系统提示词的顺序选用。空框且没有规则时停下来要求输入，不再把内置默认写进磁盘。
- 清洗和演练台跟随 DSH 主题的透明玻璃，去掉手动换色。
- 说明只保留官方 Web 和官方桌面。

## English

- Version 1.1.56.
- Apply uses the settings box, then the active rule set, then the official system prompt. An empty box with no rules asks for a prompt and does not write the built-in default to disk.
- 清洗 and the drill console use transparent glass that follows the DSH theme. The manual theme switch is gone.
- Docs keep official Web and the official desktop only.

# 1.1.55

## 中文

- 版本升级到 1.1.55。
- 点「应用」并重启后，每一轮 assemble 都会把提示词补回最前；宿主换成新 assemble 也会再包一次，不会第二轮丢掉。
- 空框不再在前端误取消应用；重启前先落下默认提示词。密封 asar 不会因为当前进程还是旧包而取消重启。
- 第二次应用不会因为冷却把重启/注入当成取消；密封包在换掉之前每次应用都会重启一次，补丁写完后不再空转。

## English

- Version 1.1.55.
- After Apply + restart, every assemble turn puts the operator prompt back at the front. If the host replaces assemble, it is wrapped again so turn 2 does not drop the inject.
- An empty settings box no longer cancels Apply on the client; Restart seeds the default prompt first. A sealed asar no longer cancels restart just because the running process still has the old archive.
- A second Apply is not treated as a cancel because of settle cooldown. A sealed archive still restarts on each Apply until swapped; after patches are in, it does not loop.

# 1.1.54

## 中文

- 版本升级到 1.1.54。
- 官方桌面密封 asar 启动不再中途解包/杀进程：避开 Host Fiber._reload 的 INACTIVE_EFFECT / DesktopHostFatalError；补丁留给设置页「应用」。
- 桌面 settle 延后并在 context 停用时退出；启动自愈只写盘、不 scheduleRestart（#59 / #60 / #61）。
- 市场 tar 安装与空 sha / 缺 installed-rev 的无限重启修复仍在（#58–#61，1.1.53）。

## English

- Version 1.1.54.
- Official desktop no longer unpacks or kills the host mid-boot on a sealed asar; that raced Fiber._reload and threw INACTIVE_EFFECT / DesktopHostFatalError. Patches wait for Settings Apply.
- Desktop settle is delayed and aborts on an inactive context; startup self-heal writes files only and does not scheduleRestart (#59 / #60 / #61).
- Marketplace tarball install and empty-sha / missing installed-rev restart loops remain fixed (#58–#61, 1.1.53).

# 1.1.53

## 中文

- 版本升级到 1.1.53。
- 修复点「应用」后无限重启（#59 / #60 / #61）：tarball 安装没有 `installed-rev`、或 `applied.json` 空 sha 时，启动不再反复 reapply+restart；对齐后不再空转重启，并加冷却。
- web 自愈重启不再自动弹浏览器，关窗后不会再被反复拉起新窗口（#59 / #61）。
- 空 sha 只在非密封、且清洗标记还在（或找不到插件根）时补戳，避免冲掉密封宿主自愈（#56 / #57）。
- 市场安装：`package.json` 标明优先 tar.gz/zip，避免 Hub 退回 `git ls-remote` 失败（#58）。

## English

- Version 1.1.53.
- Stop Apply/startup infinite restart (#59 / #60 / #61): missing `installed-rev` after tarball install or empty `applied.json` sha no longer reapply+restart every boot; skip restart once aligned, with a cooldown.
- Web self-heal restart does not open a browser, so closing the window no longer respawns tabs (#59 / #61).
- Empty-sha heal only runs when the host is not sealed and markers are present (or the plugin root is missing), so sealed-host self-heal still works (#56 / #57).
- Marketplace install prefers tar.gz/zip in `package.json` so Hub does not fall back to a failing `git ls-remote` (#58).

# 1.1.52

## 中文

- 版本升级到 1.1.52。
- 官方桌面「应用/重启」不再自动跑官方 installer（#57）：宿主版本由用户自行升级；插件只解包打补丁，避免落盘前误判失败清掉 `resources\\app`。
- 有 `applied.json` 但宿主又回到 sealed / 找不到插件根时，判定未对齐并自愈重打；面板提示「补丁已丢失，请重新应用」。
- 插件启动路径永不自动更新，仅面板手动更新。
- 默认提示词按本地 `default-prompt-inject.md` 重新加密写入 `asset-table.js`。
- 用户自改提示词不会被「应用」盖回加密默认：磁盘正文与内置不同时一律保留；运行时内置默认只读加密槽。
- 回退切点扩到整轮并在替换后清空 derive 缓存，避免下次发送仍带上被撤掉的内容。

## English

- Version 1.1.52.
- Official desktop Apply/Restart no longer auto-runs the official installer (#57); users upgrade the host themselves; the plugin only unpacks and patches.
- If `applied.json` exists but the host is sealed again / plugin root is missing, treat as mismatched and reapply; UI shows patches-lost.
- Plugin startup never auto-updates; update only from the panel.
- Reseal the default prompt from local `default-prompt-inject.md` into `asset-table.js`.
- Keep user-replaced prompts: never overwrite disk text that differs from the bundled sealed default; runtime bundled default comes only from the sealed slot.
- Rewind cuts the whole last turn and invalidates derive cache so the next send does not keep undone content.

# 1.1.51

## 中文

- 版本升级到 1.1.51。
- 修复 `/skills import` 对 `$DSH_HOME/skills` 自身导入时先删后拷把技能删空（#54）。
- 补齐 `platformEnvAdaptStatus` / `platformEnvAdaptSkip`，发送门禁不再误报「环境还没配好」（#55）。
- 修复官方桌面：无版本/同版本 `installer.exe` 被当成待更新劫持重启；更新失败时恢复 `resources/app`；空 sha 的 applied stamp 不再跳过 reapply（#56，0.1.7/0.2 同路径）。
- 补丁 #52 兼容无 `.volatile()` 写法；#57 跟到 `useDeveloperRole` 并覆盖 responses 通路；#48 上游已删句按软完成；状态导出 `patches_ready`；桌面端 shim 显示「本端不需要」。

## English

- Version 1.1.51.
- Reject `/skills import` when source overlaps `$DSH_HOME/skills` so delete-then-copy cannot wipe skills (#54).
- Implement `platformEnvAdaptStatus` / `platformEnvAdaptSkip` so the send gate no longer false-blocks ready environments (#55).
- Official desktop: ignore unversioned/same-version `installer.exe` pending updates; restore `resources/app` if update handoff fails; empty applied stamp sha no longer skips reapply (#56, same path on 0.1.7 and 0.2).
- Patch #52 matches non-`.volatile()` defaults; #57 follows `useDeveloperRole` and covers responses; #48 soft-settles when upstream removed the caution text; export `patches_ready`; desktop shim shows not-needed-here.

# 1.1.50

## 中文

- 版本升级到 1.1.50。
- 修复 macOS 官方桌面：点「应用」假失败「失败: 正在重启。」、解包后 `dsh` CLI 失效、status 误标 ✗（#53）。
- 修复点「应用」重启后默认提示词不注入：未改过时自动落盘内置默认，不必先点保存。

## English

- Version 1.1.50.
- Fix macOS official desktop: Apply false "Failed: Restarting.", broken `dsh` CLI after asar unpack, and status ✗ false negatives (#53).
- Fix default prompt not injecting after Apply + restart; bundled default is written without requiring Save first.

# 1.1.49-beta.1

## 中文

- 版本升级到 1.1.49-beta.1（#53 测试版）。
- 修复 macOS 官方桌面点「应用」后假失败「失败: 正在重启。」：`scheduleRestart` helper/runtime 分支补回 `restarting: true`；Darwin 重启改为 osascript 优雅退出 + SIGTERM/SIGKILL，排除 CLI 进程后再 `open` 重开（剥掉 ELECTRON_RUN_AS_NODE）。
- 解包 app.asar 后自动修补官方 `dsh` CLI 入口（asar/`app/` 回退）并补 `app/runtime -> ../runtime`，避免 `dsh web` 等全部 MODULE_NOT_FOUND。
- `/purge status` 对多路径文件清单按数组逐项判断，不再把已打补丁文件标成 ✗。
- 前端重启失败文案不再把成功分支的 note 当成 error。

## English

- Version 1.1.49-beta.1 (prerelease for #53).
- Fix macOS official desktop Apply false failure "Failed: Restarting.": helper/runtime branches of scheduleRestart return restarting:true; Darwin restart uses osascript quit then SIGTERM/SIGKILL, skips CLI processes, relaunches via open without ELECTRON_RUN_AS_NODE.
- After unpacking app.asar, auto-patch the official dsh CLI entry (asar/app fallback) and add app/runtime -> ../runtime so dsh web and other subcommands keep working.
- /purge status treats multi-path file lists correctly instead of marking patched files as missing.
- Restart failure UI no longer uses the success note as the error detail.

# 1.1.48

## 中文

- 版本升级到 1.1.48。
- 修复红队指挥「只派活」约束被组装时误删，导致不派 subagent；预设在 Agent Teams 下强制重开 classic subagent。
- 增加按任务选用 skill/MCP 的协议（先读目录，再按任务调用；子代理与红队同样）；不改官方注册与工具面。
- 子代理 maxDepth 适配 0.2 无 default 的 schema，补回默认 10。

## English

- Version 1.1.48.
- Fix redteam lead dispatch-only SOP being stripped during assemble; re-enable classic subagent under Agent Teams in the redteam preset.
- Add task-matched skill/MCP selection protocol (read catalog, then call what the task needs; same for subagents and redteam). Does not change official registration.
- Raise subagent maxDepth default to 10 on 0.2 schemas that dropped .default().

# 1.1.47

## 中文

- 版本升级到 1.1.47。
- 演练台「环境适配」接通 `platformConfigGet` / `Save` / `AssignToolkit`，修复 `unknown op: platformConfigGet`，工具路径与 FOFA/VPS 配置可正常读写。
- 技能库目录探测增加 `$DSH_HOME/redteam/skills`，Windows 用 `homedir()` 回退，不再只信空的 `HOME`。
- 知识库优先使用环境适配里的 nuclei 模板路径；空库时显示本机 `knowledge.db` 路径，避免误判成接口挂了。
- 首次安装弹出用户须知：说明用途、免费开源、GitHub 仓库地址；声明背着作者营利将追究法律责任，并提示禁止违法用途。确认后本机不再弹出。
- 桌面定位与表面检测放宽，安装目录名含 `DeepseekHarnessDesktop` 等也能找到本机 Harness；失败的定位缓存不再一直卡住「还没定位」。
- 回退与请求路径小修，降低后轮卡住或假进度的情况。

## English

- Version 1.1.47.
- Wire drill Env adapt ops `platformConfigGet` / `Save` / `AssignToolkit`, fixing `unknown op: platformConfigGet` so tool paths and FOFA/VPS config work again.
- Skill catalog also probes `$DSH_HOME/redteam/skills` and falls back with `homedir()` on Windows when `HOME` is empty.
- Knowledge prefers nuclei templates from Env adapt; empty libraries show the local `knowledge.db` path so a missing API is not assumed.
- First install shows a user notice: what the plugin does, that it is free/open source, the GitHub repo URL, legal warning against profit behind the author, and illegal-use prohibitions. After confirm it does not show again on that machine.
- Broader desktop locate/surface detection (including `DeepseekHarnessDesktop` installs); failed locate caches no longer stick on "host not located".
- Small rewind/request-path fixes to reduce later-turn hangs and misleading progress.

# 1.1.46

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.46銆?.1.45 鏈夐棶棰橈紝鐣ヨ繃锛屼笉瑕佸畨瑁呫€?- 榛樿鎻愮ず璇嶆寜 `default-prompt-inject.md` 閲嶆柊鍔犲瘑鍐欏叆銆?- 淇娉ㄥ叆涓嶇ǔ瀹氾細绗簩杞垨浠诲姟鍋氬埌涓€鍗婁汉璁惧け鏁堛€佽褰撴垚 `project_instructions` 鎷嗘帀鐨勯棶棰樸€?- 宸ヤ綔鍖烘浛鎹㈢鍜屼綔鐢ㄥ煙璇存槑鏀瑰洖 0.1.7 鐨勪紭鍏堢骇锛氫笉鑳藉帇杩?system銆乨eveloper 鍜岀敤鎴峰師璇濄€備富 intro 鐨勫弽杞嫆缁濆彞淇濇寔涓嶅彉銆傚凡缁忓彔涓婄殑浣滅敤鍩熷己鍙ユ暣娈垫敹鎴愯繖涓€鍙ャ€?- 杩涙ā鍨嬪墠鍓ユ帀澶栧眰 ChatML / `<project_instructions>` 澹筹紝閬垮厤妯″瀷鎶婄湡瀹?system 娉ㄥ叆褰撴垚椤圭洰璇存槑銆?- 缁勮鍚庣殑绯荤粺鎻愮ず娈电粺涓€淇濊瘉 `text` 涓哄瓧绗︿覆锛涗笉鍐嶄細璇濋拤姝绘暣娈?sections锛岄伩鍏嶇浜岃疆 `renderPrompt` 璇?`undefined.length` 鐩存帴姝绘帀骞舵姤 `(gateway/internal)`銆?- `agent/pre-step` 濮嬬粓鎶?`decision.messages` 瑙勮寖鎴愭暟缁勶紝閬垮厤绗簩杞彂閫佹椂璇荤┖ messages 鐐告帀銆?- 鍦板尯闂搁棬锛氬鍦板潃鍩熷悕涓嶈兘鍙洜鍏朵腑涓€涓В鏋愬埌鍙楁帶鍦板尯灏辨暣绔欐嫤姝伙紙CDN/澶氱嚎鍣０ IP锛夈€?- 鍥為€€鍚?`deriveMessages` / `systemNodes` 瀵圭己 `content` 鍋氬厹搴曪紝閬垮厤鍥為€€鍐嶅彂閫佹椂 `(gateway/internal)`銆?- 娓呮礂杩涘害锛氭湭瀹氫綅瀹夸富鏃朵笉鍐嶆樉绀哄悡浜虹殑 `0/63`锛涙湰鏈轰笉闇€瑕佹垨缁勪欢鏈鐨勯」璁″叆宸插氨缁紝閬垮厤鍋囩殑 `48/63`銆?- 鐐广€屽簲鐢ㄣ€嶅氨浼氬啓鍏ラ粯璁ゆ彁绀鸿瘝骞舵敞鍏ワ紝妗嗙┖鏃剁敤鍐呯疆榛樿锛屼笉蹇呭厛鐐逛繚瀛樸€?- 淇鍥為€€锛歚snapshotEvents()` 涓虹┖鏃朵笉鍐嶈 `undefined.length`锛岄伩鍏?`(gateway/internal)` 鎶ラ敊瀵艰嚧鍥為€€鏃犳晥銆?
## English

- Version 1.1.46. Skip 1.1.45; that version has bugs. Do not install it.
- Reseal the default prompt from `default-prompt-inject.md`.
- Fix unstable inject: persona dropping on the second turn or mid-task, including cases where the model treated the system inject as `project_instructions` and rejected it.
- Replacement and scope workspace intros match 0.1.7 again: they do not override system, developer, or direct user instructions. The main intro anti-soft-refuse text stays. A stacked scope paragraph is collapsed back to that one sentence.
- Strip outer ChatML / `<project_instructions>` wrappers before the text reaches the model, so a real system inject is not read as project instructions.
- Sanitize assembled system-prompt sections so `text` is always a string; stop pinning full sections for a session, which could make the second turn crash in `renderPrompt` on `undefined.length` with `(gateway/internal)`.
- Always normalize `decision.messages` to an array in `agent/pre-step`, so a second send does not die on a missing messages list.
- Region gate: multi-address hosts are no longer blocked just because one resolved IP is in a controlled region (CDN/noise).
- After rewind, `deriveMessages` / `systemNodes` tolerate missing `content`, so resend no longer fails with `(gateway/internal)`.
- Clean progress: do not show a scary `0/63` before the host is located; items not needed on this install count as ready, so a fake `48/63` no longer appears.
- Apply writes and injects the default prompt; an empty box uses the bundled default, so a separate Save is not required.
- Fix rewind: empty `snapshotEvents()` no longer reads `undefined.length`, so undo no longer fails with `(gateway/internal)`.

# 1.1.44

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.44銆?- 瀹樻柟妗岄潰瑙ｅ紑 `app.asar` 鏃跺厛鍐欏埌鏃佽竟鐨勭洰褰曪紝瑙ｅ紑瀹屾垚鎵嶆崲涓?`resources/app`銆傜洰褰曢噷宸茬粡鏈夊涓讳箣鍚庡彧鏀硅繖浜涙枃浠躲€傚悓涓€浠藉綊妗ｅ張鍑虹幇鏃跺彧鎶婂畠鎸紑銆傚綊妗ｇ殑澶у皬鎴栨椂闂村彉浜嗭紝鎴栫洰褰曚笉鍦ㄤ簡锛屾墠鍐嶈В涓€娆°€傝В鍖呭崱浣忔垨琛ヤ竵娌″啓瀹岋紝鎶婁笂涓€浠芥斁鍥炲幓锛屽崌绾ф爣璁扮暀鍒颁笅娆″啀璇曘€?- 鍥為€€涓婁竴杞彧鎾ゆ帀鏈€鍚庝竴鏉″凡缁忓彂鍑虹殑娑堟伅鍜屽畠鐨勫洖澶嶏紝鏇存棭鐨勮疆娆＄暀鍦ㄥ璇濋噷锛屼篃浠庢ā鍨嬭姹傞噷鎷挎帀銆傝繛缁洖閫€鍚庣暀涓嬬殑绌烘爣璁颁笉鍐嶈繘涓嬩竴杞姹傦紝涓嬩竴鍙ユ寜鏂版秷鎭彂銆?- 鍙紪杈戞彁绀鸿瘝鏁翠唤鏀惧湪绯荤粺鎻愮ず鏈€鍓嶏紝鍚屼竴浠芥鏂囦笉鍐嶆嫾绗簩閬嶃€傛瘡涓€姝ョ敤褰撳墠杩欎竴浠芥浛鎹㈢涓€鏉＄郴缁熸彁绀恒€?- deepseek.com 鐨勭郴缁熸彁绀哄浐瀹氳蛋 system锛屾€濈淮閾剧収鏃у彂閫併€?- 鍦板尯鎷︽埅鍙湅杩欐浠诲姟閲岀殑鐩爣銆傝嚜宸辩殑鏈嶅姟鍣ㄥ彧璁ゅ悕鍗曚笂鐨勯偅涓€涓湴鍧€鎴栦富鏈哄悕銆傜姝㈠彞鍐欎笂涔嬪悗鎵嶇粨鏉熻繖涓€杞€?- 瀹樻柟濮嬬粓鐢ㄥ甫 CTF 鐨勯粯璁ゆ彁绀鸿瘝銆傜孩闃熷紑浜嗚鍒欓泦灏卞彧鐢ㄨ鍒欓泦锛涘惁鍒欑敤鍘绘帀 CTF 鐨勯粯璁ゆ彁绀鸿瘝锛屽啀鎺ョ孩闃熸搷浣溿€傚瓙浠ｇ悊璺熶富浼氳瘽鍚冨悓涓€浠姐€傜鐩樻病鏈夋彁绀鸿瘝鏃跺惎鍔ㄥ氨鐢ㄩ粯璁ら偅浠斤紝涓嶅繀鍏堢偣淇濆瓨銆?
## English

- Version 1.1.44.
- Unpacking `app.asar` writes beside `resources/app` and swaps in only after the unpack finishes. Once that directory is usable, later starts only edit those files. The same archive showing up again is moved aside. A new size or mtime, or a missing directory, is unpacked once. If unpacking sticks or that patch round does not finish, the previous directory is put back and the upgrade marker stays for the next start.
- Rewinding the previous round removes only that sent message and its reply. Earlier rounds stay on screen and leave the next model request. Leftover rewind markers stay off the next model request, so the next send is a new message.
- The editable prompt is placed once at the front of the system prompt. Each step replaces the first system prompt with that current text.
- Instructions for deepseek.com stay on the system role. Thinking is still sent.
- The region check looks only at this task's target. An own server is allowed only when that exact address or hostname is on the list. The turn ends after the denial sentence is written.
- Official mode always uses the default prompt, including CTF. Red team uses only the active rule set, or the default prompt without CTF followed by the red team steps. Subagents receive the same inject as the main session. If the prompt file is empty, startup uses the bundled default without requiring Save.

# 1.1.43

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.43銆?- 杩樻病瀹氫綅鍒版湰鏈?Harness 鏃讹紝涓嶅啀鎶婃瘡涓€鏉℃樉绀烘垚璺宠繃锛屽垎缁勮鏁颁篃涓嶅啀鎶婅烦杩囩畻鎴愬凡瀹屾垚銆?- 琛ヤ竵鍒楄〃琛ラ綈鍒板叏閮?52 鏉★紝鎬绘暟鍜屽垎缁勫寰椾笂銆?- 鍚姩鏃跺鏋滄殏鏃舵壘涓嶅埌瀹夸富鐩綍锛屼笉鍐嶆妸杩欎釜绌虹粨鏋滅紦瀛樹綇銆?
## English

- Version 1.1.43.
- Before this install is located, rows are no longer shown as skipped, and a skip no longer counts as done in the group total.
- The patch list now includes all 52 items, so the total matches the groups.
- A miss while looking up the host directory is not cached for the rest of the process.

# 1.1.42

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.42銆?- 娓呮礂椤垫彁绀鸿瘝涓嬮潰鍙互鐧昏鑷繁鐨勬湇鍔″櫒锛氭瘡琛屼竴涓?IP 鎴栧畬鏁翠富鏈哄悕锛岀偣淇濆瓨鍚嶅崟銆傝鏄庨噷鍐欎簡姝ラ锛屽苟闄勪簡鎴浘銆?- 鏂板璇濇妸鎻愮ず璇嶆斁鍦ㄧ郴缁熸彁绀烘渶鍓嶃€傞潰鏉挎敼涓虹櫧澧ㄧ幓鐠冿紝涓ょ涓婚閮借兘鐪嬫竻瀛椼€?- 琛ヤ竵杩涘害鍙宸插簲鐢ㄧ殑椤广€傜綉椤佃韩浠介偅鏉″湪鍚庝竴鏉℃敼鍐欏彞瀛愪箣鍚庯紝浠嶆樉绀哄凡搴旂敤銆?- 琛ヤ笂 0.1.x 鐨勫叆鍙ｉ拡銆傚凡缁忔墦杩囩殑 0.2.0 涓嶄細琚噸鍐欍€?
## English

- Version 1.1.42.
- Under Prompt on the Clean page, register your own server: one IP or exact hostname per line, then Save list. The docs include the steps and a screenshot.
- New chats place the prompt at the front of the system prompt. The dock is frosted glass, and both the light and ink themes stay readable.
- The patch count includes only applied items. The web-surface identity row stays applied after the later sentence rewrite.
- Needles for 0.1.x entry points were added. An already patched 0.2.0 host is not rewritten.

# 1.1.41

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.41銆?- 瀹樻柟妯″紡鍙敞鍏ュ綋鍓嶆彁绀鸿瘝锛涘惎鐢ㄨ鍒欓泦鍚庝互瑙勫垯闆嗕负涓汇€傜孩闃熷啀闄勪笂绾㈤槦鎿嶄綔瑕佹眰銆?- 鍥為€€鐣欏湪褰撳墠浼氳瘽锛氬厛閫夊洖閫€涓€娆℃垨涓婁竴杞紝涓婁竴鍙ユ斁鍥炶緭鍏ユ锛屽苟娓呮帀宸茬粡鍙戝嚭鍘荤殑鍐呭銆?- 瀹夸富娌℃竻娲楀畬锛屾垨娌℃湁鍙敞鍏ョ殑鎻愮ず璇嶆椂锛屼笉閲嶅惎銆?- 榛樿宸叉槸瀹屽叏鏉冮檺鏃讹紝鏂颁細璇濅笉鍐嶈閽夊洖鍙楅檺鏉冮檺銆傚畼鏂规ā鍨嬬殑 Session Log 涓婁紶榛樿鍏抽棴銆?- 鐩爣鍦板潃钀藉湪涓浗澶ч檰銆侀娓€佹境闂ㄦ椂鍋滄銆?
## English

- Version 1.1.41.
- Official modes inject the editable prompt, or the active rule set when one is enabled. Red team also keeps its operating section.
- Rewind stays on the current session: choose one step or the last round, return the last line to the composer, and clear what was already sent.
- Restart is cancelled unless the host is cleaned and inject text is present.
- A full-access default is no longer pinned back to a restricted preset. Official model Session Log upload is off by default.
- Targets whose addresses fall in mainland China, Hong Kong, or Macau are stopped.

# 1.1.40

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.40銆?- 閫傞厤 **DSH 0.2.0-rc.2**锛欰nthropic OAuth 涓嶅啀鍦ㄧ郴缁熸彁绀烘渶鍓嶉潰寮烘彃銆孻ou are Claude Code鈥︺€嶏紝鑷畾涔?`prompt-inject` 涓嶄細琚帇鍒板悗闈€?- 鍘绘帀鍦?0.2 閲屽凡涓嶅瓨鍦ㄧ殑 **patch 41**锛坉eveloper 瑙掕壊鏀瑰啓锛夛紝閬垮厤鏃犳晥琛ヤ竵鍗犱綅銆?- 璁剧疆椤电偣 **搴旂敤** 鎴愬姛鍚?**鑷姩閲嶅惎** 瀹夸富锛屼笉蹇呭啀鎵撳紑鎻掍欢鐐圭浜屾閲嶅惎銆?
## English

- Version 1.1.40.
- For **DSH 0.2.0-rc.2**, Anthropic OAuth no longer prepends 鈥淵ou are Claude Code鈥︹€?ahead of your system prompt, so custom `prompt-inject` is not pushed behind a Claude identity block.
- Removed **patch 41** (developer-role remap) because those needles are gone in 0.2.
- After **Apply** in settings, the host **restarts automatically**; you no longer need to open the plugin again to confirm restart.

# 1.1.39

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.39銆?- 涓枃 Windows 涓婏紝瀹樻柟妗岄潰鐗堢偣銆屽畨瑁呭苟閲嶅惎銆嶄笉鍐嶅仠鍦ㄣ€屾鍦ㄥ噯澶囬噸鍚€嶃€傛洿鏂拌剼鏈琛屾敼涓虹函 ASCII锛岃矾寰勯噷鐨勪腑鏂囧啓鎴?`\u` 杞箟锛岄伩鍏?Windows Script Host 鎸?GBK 鎶婃崲琛屽悶杩涙敞閲娿€?- macOS 鍜?Linux 涓嶈蛋杩欐潯鑴氭湰锛岄噸鍚柟寮忎笉鍙樸€?
## English

- Version 1.1.39.
- On Chinese Windows, the official desktop install-and-restart no longer stays on preparing to restart. The update script starts with an ASCII comment, and non-ASCII paths are written as `\u` escapes, so Windows Script Host does not swallow the newline when it reads the file as GBK.
- macOS and Linux do not use this script. Their restart path is unchanged.

# 1.1.38

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.38銆?- 绾㈤槦涓嶅啀鏇跨敤鎴蜂笅杞藉伐鍏枫€傛病鏈夊畨瑁呰剼鏈椂锛屽紩瀵兼敼璧版紨缁冨彴銆岀幆澧冮€傞厤銆嶏紝鐢辩敤鎴疯嚜宸卞～璺緞銆?- 闀挎椂闂翠换鍔′細鍦ㄧ郴缁熸彁绀鸿瘝閲屾斁涓€寮犮€屾湰娆＄洰鏍囥€嶅崱銆傛寚鎸ュ拰瀛愪唬鐞嗙湅鐨勬槸鍚屼竴寮狅細鍙墦杩欎釜鍗曚綅锛屽洖鎶ラ噷甯﹀嚭鏉ョ殑鍏跺畠鍗曚綅涓嶆墦銆傚瓙浠ｇ悊鎸夎鑹蹭娇鐢ㄨ嚜宸辩殑鎻愮ず璇嶏紝娲炬椿鏃剁殑鍗曚綅鍚嶇О蹇呴』鍜岃繖寮犲崱涓€鑷淬€?- 宸ュ叿鏌ユ壘璁ゅ彂琛岀増涓婄殑鐪熷疄鏂囦欢鍚嶏紝渚嬪 Kali 鐨?`httpx-toolkit`銆乣impacket-secretsdump`锛屼笉鍐嶆妸 Python 鐨?`httpx` 褰撴垚鎵弿鍣ㄣ€?- 瀹樻柟妗岄潰鍦?macOS銆丩inux 涓婁篃鑳芥壘鍒?`app.asar`锛圡ac 鐢?`Contents/Resources`锛夈€俉indows 浠ュ涓嶅啀鍖呬竴灞備細鎶?`require` 寮勫潖鐨勬帶鍒跺彴闅愯棌銆?- 绾㈤槦鎺ュ叆閿氱偣闂細寮€澶村嚑姝ヨ緭鍑轰笂闄?1024锛涚涓€娈垫€濊€冮噷鏈?`we`銆佹病鏈?`let me` 灏辨斁寮€锛屽惁鍒欏悓涓€杞渶澶氬啀璧?4 姝ャ€備笂涓嬫枃鍘嬬缉鍚庡啀鍏充竴娆°€傜孩闃熷伐鍏峰拰浜鸿淇濇寔鍘熸牱銆?- 闅忓寘鎶€鑳藉悓姝ュ埌 `$DSH_HOME/redteam/skills`锛岄璁剧敤 `dshHomePath` 鎸囧悜瀹冿紝涓嶅啀鎶婃煇涓€鍙扮數鑴戠殑 `node_modules` 璺緞鍐欒繘棰勮銆備綘鑷繁鐨勬妧鑳戒粛鍦?`$DSH_HOME/skills`锛屽悓鍚嶄互浣犵殑涓哄噯銆?- 淇ソ绾㈤槦妯″紡涓嶆樉绀猴細澹版槑棰勮鏃舵紡浜嗚矾寰勫彉閲忥紝鎻掍欢涓€旈€€鍑猴紝妯″紡涓嬫媺灏辨病鏈夎繖涓€椤广€?- 璇存槑閲屽姞鍥炶禐鍔╁湴鍧€銆?
## English

- Version 1.1.38.
- Red team no longer downloads tools for you. When the setup script is missing, the guide points at the drill console environment page so you fill in the paths.
- Long jobs keep a target card in the system prompt. The commander and subagents see the same card: stay on that organization, and do not switch to other names that show up in results. Each subagent loads its own role text, and dispatched work must use the name on the card.
- Tool lookup accepts distro filenames such as Kali's `httpx-toolkit` and `impacket-secretsdump`, and does not treat Python's `httpx` as the scanner.
- The official desktop app can find `app.asar` on macOS and Linux (`Contents/Resources` on Mac). Outside Windows, the console-hide wrapper that broke `require` is not installed.
- Red team uses an anchor gate: the first steps are capped at 1024 output tokens, the cap lifts when the first reasoning block contains `we` and not `let me`, otherwise it lasts at most 4 steps in that turn, and a context compaction closes the gate again. Red team tools and the persona stay as they are.
- Bundled skills are copied to `$DSH_HOME/redteam/skills` and the preset points there with `dshHomePath`, instead of a machine-specific `node_modules` path. Your own skills stay in `$DSH_HOME/skills` and win on the same name.
- Red team mode shows in the mode list again. Declaring the preset no longer exits early because a path variable was missing.
- The sponsor addresses are back in the readme.

# 1.1.37

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.37銆?- 淇敼婕旂ず鍙扮幆澧冮厤缃粴鍔ㄩ棶棰樸€?
## English

- Version 1.1.37.
- The drill console environment page scrolls, so the rest of the settings can be filled in.

# 1.1.36

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.36銆?- 瑙ｅ喅绾㈤槦妯″紡鎷掔粷闂銆?
## English

- Version 1.1.36.
- Fix red team mode refusing the cleaned prompt.

# 1.1.35

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.35銆?- 鍚姩鏃朵笉鍐嶈嚜鍔ㄦ洿鏂帮紝瑕佽嚜宸卞湪闈㈡澘閲岄€夋嫨銆?- dsh-purge 鍏ュ彛鏀瑰埌銆屼笂涓嬫枃銆嶆梺杈癸紝涓嶅啀鎸′綇鍒殑鎻掍欢鎸夐挳銆?- 寰楀垎鍙ｅ緞瀵归綈涓婃父锛?5 椤癸紝Web 搴旂敤澧炲姞鍏滃簳褰掔被銆?- 鐭ヨ瘑搴?14 绫昏鏁板寘鍚湰鏈?nuclei 妯℃澘锛岀偣鏌愪竴绫诲彲浠ョ瓫閫夈€?- 鎶€鑳借矾寰勮窡闅?`$DSH_HOME`锛屼笉鍐嶅洜涓虹ず渚嬭矾寰勫湪鏈満涓嶅瓨鍦ㄥ氨鎶婃暣鏉℃妧鑳芥爣鎴愪笉鍙敤銆?
## English

- Version 1.1.35.
- Startup no longer auto-updates; choose the update in the panel.
- The dsh-purge entry sits beside Context, so it no longer covers other plugin buttons.
- Scoring matches upstream: 25 items, with a fallback bucket for other web apps.
- The 14 knowledge categories count local nuclei templates, and a category filters the list.
- Skill paths follow `$DSH_HOME`. A skill is no longer marked unavailable just because an example path is missing on this machine.

# 1.1.34

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.34銆?- **婕旂粌鍙扮煡璇嗗簱鐩存帴鍒楀嚭鏈満妯℃澘**銆傛墦寮€銆岀煡璇嗗簱 路 POC / EXP銆嶅氨鑳界湅鍒颁竴椤?nuclei 妯℃澘锛屽苟鍙互缈婚〉銆佹寜 CVE 鎴栫粍浠舵悳绱€備笉鍐嶅彧鏄剧ず銆屾湰鏈烘ā鏉?N銆嶃€佷笅闈㈡槸绌虹殑銆?- **鏇存柊鍖呭湪 Windows銆乵acOS銆丩inux 涓婇兘鑳借В鍘?*銆侺inux 涓嶅啀璋冪敤 PowerShell銆傞『搴忔槸锛歐indows 鐢?tar锛屼笉琛屽啀鐢?PowerShell锛沵acOS 鍜?Linux 鐢?tar銆乽nzip銆乸ython3銆乥sdtar銆傝繖浜涢兘娌℃湁鏃讹紝鐢?Node 鑷繁瑙?zip銆傛劅璋?@cracer4869 鍦?#44 鎶ュ嚭 Kali 涓婄殑 `spawnSync powershell ENOENT`銆?
## English

- Version 1.1.34.
- **The drill knowledge page lists local templates.** Opening Knowledge shows a page of nuclei templates, with paging and search by CVE or component. It no longer shows only the template count.
- **Update archives extract on Windows, macOS, and Linux.** Linux does not call PowerShell. Windows tries tar, then PowerShell. macOS and Linux try tar, unzip, python3, then bsdtar. If none of those exist, Node extracts the zip itself. Thanks to @cracer4869 for reporting `spawnSync powershell ENOENT` on Kali in #44.

# 1.1.33

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.33銆?- **淇宸茬粡閲嶅惎鍚庯紝鎵撳紑闈㈡澘浠嶅脊鍑恒€岄渶瑕侀噸鍚€?*銆傚畼鏂瑰鎴风宸茬粡浠庤В寮€鐨?`resources/app` 杩愯鏃讹紝涓嶅啀浠呭洜涓哄綋鍓嶆槸瀹樻柟杩涚▼灏卞啀瑕佹眰閫€鍑轰竴娆°€傚彧鏈夎繖娆＄湡鐨勬尓寮€浜?`app.asar`锛屾墠浼氭彁绀洪噸鍚€?
## English

- Version 1.1.33.
- **Fix the restart dialog coming back after you already restarted.** When the official app is already running from the unpacked `resources/app`, opening the panel no longer asks you to quit again just because this is the official process. The restart prompt appears only when `app.asar` was actually moved aside in this run.

# 1.1.32

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.32銆?- **鎸夋祴璇曠増鎺ヤ笂婕旂粌鍙板竷灞€**锛氶潰鏉垮彲鎷栧姩銆佸彲鏀瑰ぇ灏忥紝娴呰壊鍜屾繁鑹茶窡瀹夸富涓婚璧般€?- **璁剧疆椤典笉鍐嶅嚭鐜版湰鎻掍欢**銆備粠浼氳瘽鏍囬鏃佺殑 dsh-purge 鎵撳紑鍙充晶鏍忥紝娓呮礂鍜屾紨缁冨彴閮藉湪閲岄潰銆?
## English

- Version 1.1.32.
- **Bring the beta dock layout onto stable**: the panel can be dragged and resized, and light and dark follow the host theme.
- **The plugin no longer appears on the Settings page.** Open the right dock from dsh-purge beside the session title. Clean and Drill are both in that dock.

# 1.1.31

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.31銆?- **婕旂粌鍙拌繘鍏ユ寮忕増**銆傚彸渚ф爮涓ら〉锛氭竻娲椼€佹紨缁冨彴銆傜涓€娆¤繘鍏ユ紨缁冨彴瑕佽澹版槑骞剁‘璁ゆ巿鏉冦€傝祫浜с€佹妧鑳藉拰鏈満鐜閮藉湪鏈彃浠堕噷锛屼笉鍐嶅崟鐙娴嬭瘯鐗堢孩闃熷寘銆?- **淇鍥為€€鍫嗗垎鏀?*锛氬涓讳笉鑳藉湪鍘熶細璇濋噷鎴柇锛屽洖閫€鍚庝細鎶婃棫浼氳瘽浠庝晶杈规爮绉诲嚭锛屽閫€鍑犳涓嶄細鐣欎笅涓€涓插垎鏀€?
## English

- Version 1.1.31.
- **Drill console is on the stable release.** The right dock has two pages: Clean and Drill. The first time you open Drill you read the notice and confirm authorization. Assets, skills, and the local environment ship inside this plugin.
- **Fix rewind leaving a branch every time.** The host cannot truncate a session in place. After rewind the old session leaves the sidebar, so repeated undo does not pile up branches.

# 1.1.30

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.30銆?- **淇姝ｅ紡鐗堝拰 web 鍒囨崲鐗堟湰澶辫触**锛氫笉鍐嶇敤 `dsh plugin add` 鎷夊寘銆俻npm 璇锋眰 GitHub 鍘嬬缉鍖呬細 `http 302` 鎴?`fetch failed`銆傛敼鐢辨彃浠惰嚜宸变笅杞姐€?- **淇鎬濊€冨拰杈撳嚭姝诲惊鐜?*锛氬幓鎺夐粯璁ゆ彁绀鸿瘝閲屾病鏈夌粓姝㈡潯浠剁殑閲嶇疆銆?
## English

- Version 1.1.30.
- **Fix version switching on the desktop app and web**: stop installing through `dsh plugin add`. pnpm's fetch of the GitHub archive returns `http 302` or `fetch failed`. The plugin downloads the package itself.
- **Fix the thinking and output loop**: remove the default-prompt reset that had no stop condition.

# 1.1.28

## 涓枃

- **淇鏇存柊澶辫触 `http 302`**锛氫笅杞芥敼涓虹洿杩?`codeload.github.com`锛屽苟鎵嬪姩璺熼殢璺宠浆锛岄伩鍏?Electron/閮ㄥ垎 Node 瀵?github.com 鈫?codeload 鐨?302 澶勭悊澶辫触銆?- **淇娴嬭瘯鐗堝垪琛ㄧ┖鐧?*锛氬墠绔?`keepListedVersion` 涓庡悗绔竴鑷达紝姝ｅ紡鐗堝凡鍙戝竷鏃朵粛淇濈暀 beta tip / `beta` 鍒嗘敮锛泃ip SHA 鎷変笉鍒版椂鍥為€€ raw/jsDelivr 鎺㈡祴銆?
## English

- **Fix update failure `http 302`**: download via `codeload.github.com` and follow redirects manually so Electron/some Node builds no longer stall on github.com 鈫?codeload 302.
- **Fix empty beta list**: client `keepListedVersion` matches the server 鈥?keep the beta tip / `beta` branch after stable ships; fall back to raw/jsDelivr when tip SHA cannot be fetched.

# 1.1.27

## 涓枃

- **淇搴旂敤閲嶅惎鍚庤繘瑙勫垯璁惧畾浠嶅脊銆岄渶瑕侀噸鍚€?*锛氭墜鍔ㄣ€屽簲鐢ㄣ€嶆垚鍔熷悗鍐欏叆 `applied` 鎴筹紝閲嶅惎鍚?settle 涓嶅啀璇垽琛ヤ竵鏈榻愩€?- 鐐广€岄噸鍚€嶆竻鎺?`boot_full_quit` 绮樻€ф爣璁帮紱status 鎸夊竷灏斿€煎悓姝ュ脊绐椼€?- web `waitForRestart` 蹇呴』鍏堢湅鍒版棫杩涚▼鎺夌嚎鍐嶅垽瀹氭垚鍔燂紝閬垮厤鍚岃繘绋嬭鍒锋柊鍙堝脊绐椼€?
## English

- **Fix restart prompt still showing after Apply + successful restart**: write the `applied` stamp on successful manual Apply so settle does not think patches are out of date.
- Clear sticky `boot_full_quit` when Restart is clicked; status syncs the modal from the boolean.
- Web `waitForRestart` requires the old process to go down before treating restart as success, avoiding same-process false refresh.

# 1.1.26

## 涓枃

- **淇娴嬭瘯閫氶亾琚寮忕増鍚屽彿钘忔帀**锛歚1.1.25` 姝ｅ紡鍙戝竷鍚庯紝`1.1.25-beta.*` 鍥犮€屾寮忓凡杩戒笂銆嶉€昏緫鏁撮€氶亾涓嶅彲瑙侊紱鐜?**beta 鍒嗘敮 tip 濮嬬粓鍒楀嚭**锛堟寮?娴嬭瘯骞惰锛屾祴璇曞甫绾㈤槦锛夈€?- 宸茶拷涓婄殑鏃?beta **鏍囩**浠嶄細闅愯棌锛沗1.1.11-beta` 浠嶄笅绾裤€?
## English

- **Fix beta lane hidden by same-number stable**: after `1.1.25` stable, `1.1.25-beta.*` vanished via the 鈥渟table caught up鈥?filter; the **beta branch tip always stays listed** (parallel channels; beta carries red-team).
- Older caught-up beta **tags** still hide; `1.1.11-beta` stays withdrawn.
# 1.1.25

## 涓枃

- **淇 [#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43)**锛氫笉鍐嶆妸 `profiles/*/cordis.patch.yml`锛堢敤鎴?patch 灞傦級绾冲叆 `backupAll`/`revertAll`锛涘崌绾ц嚜鎰堟椂涓嶄細鐢ㄦ棫 bak 瑕嗙洊鐢ㄦ埛鍚庢潵杩藉姞鐨?`insert`銆?- 鍚姩/杩樺師鏃朵富鍔ㄤ涪鎺夊巻鍙蹭笂璇缓鐨?`cordis.patch.yml.dshpurge.bak`锛屼繚鐣欏綋鍓嶇敤鎴锋枃浠躲€?- 鏂板 `npm run test:profile-patch`銆?
## English

- **Fix [#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43)**: stop including `profiles/*/cordis.patch.yml` (user patch layer) in `backupAll`/`revertAll`, so upgrade reapply no longer restores an old bak over later user `insert`s.
- Drop stale `cordis.patch.yml.dshpurge.bak` without restoring; keep the live user file.
- Add `npm run test:profile-patch`.
# 1.1.24

## 涓枃

- **淇 [#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40)**锛歚pathLooksDesktop` 涓嶅啀浠呭嚟璺緞閲岀殑 `deepseek-harness` 瀛愪覆鎶婃簮鐮佺増鍒ゆ垚妗岄潰绔紱闇€甯?`resources/` / `.exe` / `.app` 绛夊畨瑁呭舰鎬併€?- **淇 [#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41)**锛氭簮鐮侀儴缃茬殑 `apps/cli`锛坱sdown 鏋勫缓浜х墿锛夌姝?hide-console 娉ㄥ叆锛沗revertAll` 鍦ㄦ棤 `.dshpurge.bak` 鏃跺彧璺宠繃銆佺粷涓嶅垹闄ょ洰鏍囨枃浠躲€?- 鏂板 `npm run test:surface` 鍥炲綊銆?
## English

- **Fix [#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40)**: `pathLooksDesktop` no longer treats source trees as desktop just because the path contains `deepseek-harness`; require install shapes (`resources/`, `.exe`, `.app`).
- **Fix [#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41)**: skip hide-console injection into source `apps/cli` build output; `revertAll` never deletes targets when `.dshpurge.bak` is missing.
- Add `npm run test:surface`.
# 1.1.23

## 涓枃

- **淇 [#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38)**锛歚#1`/`#2`/`#3` 鎻愮ず璇嶈ˉ涓佹瘡娆?`apply` 鍙犲姞绾?+841 瀛楃銆佹案涓嶆敹鏁涖€?- **鍘熷洜**锛氭浛鎹骇鐗╀粛浠ュ墠涓€鐗堟枃鏈负鍓嶇紑锛屼笖鏈 `skipIfMarked`锛宍autoApplyOnStart` 姣忚疆閮戒細鍐嶅啓涓€灞傘€?- **淇**锛氫负 `#1`/`#2`/`#3` 琛?`skipIfMarked: true`锛圼#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)锛夛紝骞跺姞 `npm run test:idempotence` 鍥炲綊銆?- 宸茶啫鑳€鐨勫涓绘枃浠朵笉浼氳嚜鍔ㄧ缉鍥烇紝闇€杩樺師 `.dshpurge.bak` 鎴栭噸瑁?dsh 鍚庡啀 apply銆?
## English

- **Fix [#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38)**: prompt patches `#1`/`#2`/`#3` grew by ~+841 chars on every `apply` and never converged.
- **Cause**: replacement text still starts with the previous pattern, and `skipIfMarked` was missing, so `autoApplyOnStart` rewrote every boot.
- **Fix**: set `skipIfMarked: true` on `#1`/`#2`/`#3` ([#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)); add `npm run test:idempotence`.
- Already-bloated host files are not auto-shrunk 鈥?restore `.dshpurge.bak` or reinstall dsh, then apply again.

# 1.1.22

## 涓枃

- **淇瀹樻柟妗岄潰鐐广€屽簲鐢ㄣ€嶆姤 ENOENT**銆俙app.asar` 杩樺湪鏃讹紝鏂板缓 `dsh-purge-child-process-hide.mjs` 浼氬け璐ワ紝璺緞琚啓鎴?`resources\app.asar\...\dsh-purge-child-process-hide.mjs`锛岃ˉ涓佸仠鍦ㄥ緟搴旂敤銆?- **鍘熷洜**锛氬畼鏂瑰鎴风杩樺甫鐫€ `app.asar` 鏃讹紝Electron 浼氭妸 `resources\app` 鏄犲皠杩涜繖涓綊妗ｃ€傚綊妗ｉ噷娌℃湁鐨勬柊鏂囦欢锛岀敤鏅€氭枃浠舵帴鍙ｅ幓鍒涘缓灏变細 ENOENT銆?- **涓ょ鍐欐硶閮戒繚鐣?*銆傚綊妗ｈ繕鍦ㄦ椂锛屾敼鍐欑湡瀹炵鐩樹笂鐨?`resources\app`銆傛病鏈?`app.asar` 鏃朵粛鐢ㄥ師鏉ョ殑 `node:fs`锛屽寘鎷?Web銆佺ぞ鍖烘闈紝浠ュ強瀹樻柟鍖呭凡缁忚В寮€骞舵妸褰掓。鎸垚 `app.asar.bak` 鐨勬儏鍐点€?- 瀹夎鐩綍涓嶅啓姝荤洏绗︺€俉eb 鍜岀ぞ鍖烘闈㈢殑搴旂敤銆侀噸鍚繚鎸佸師鏍枫€傚涓讳粛瀵瑰噯 **dsh 0.1.7-rc.2**銆?
## English

- **Fixes ENOENT when Apply runs on the official desktop.** While `app.asar` is still present, creating `dsh-purge-child-process-hide.mjs` failed. The path was rewritten to `resources\app.asar\...\dsh-purge-child-process-hide.mjs`, and patches stayed pending.
- **Cause**: with the archive still in place, Electron maps `resources\app` into `app.asar`. Creating a file that is not already in the archive through the normal file API throws ENOENT.
- **Both write paths stay.** If the archive is still there, files are written on the real `resources\app` directory. If there is no `app.asar`, the previous `node:fs` path is unchanged. That covers Web, community desktop, and an official install that has already been unpacked and had the archive moved to `app.asar.bak`.
- Install paths are not pinned to a drive letter. Web and community desktop keep their existing Apply and restart. The host target remains **dsh 0.1.7-rc.2**.

# 1.1.21

## 涓枃

- **淇蹇呴渶琛ヤ竵澶辫触 #43銆?9銆?15銆?23銆?42**銆傜偣銆屽簲鐢ㄣ€嶄笉鍐嶅洜涓鸿繖 5 鏉℃姤銆屾竻娲楁湭瀹屾垚銆嶃€傛彁绀鸿瘝鏈潵灏变細鍐欏叆锛涜繖 5 鏉℃病鍐欎笂鏃讹紝鐣岄潰鍗存妸鏁存搴旂敤鍒ゅけ璐ワ紝鐪嬭捣鏉ュ儚鎻掍欢澶辨晥銆?- **鍘熷洜**锛氫笂绾ф枃浠跺す鍚嶅彨 DeepSeek Harness 鏃讹紝鏁存５鐩綍琚綋鎴愬畼鏂规闈€俉eb 鐨?npm 鍖呭洜姝よ鎺掗櫎锛岃繖 5 鏉″寰椾笂鐨勫師鏂囦篃娌″啓杩涘幓銆傚畨瑁呰矾寰勪笉鍐欐鐩樼銆傜幇鍦ㄥ彧鏈夋梺杈圭湡鏈夋闈㈢▼搴忥紝鎴栬矾寰勫湪璇ュ畨瑁呯殑 `resources/app` 閲岋紝鎵嶇畻妗岄潰瀹夎銆俉eb銆佺ぞ鍖烘闈€佸畼鏂规闈㈠悇鑷墦鑷繁鐨勫寘銆?- **#43**锛氬幓鎺?Web 鍥涗釜鍐呯疆棰勮锛坰tandard銆乸tc銆乧ordis銆乵inimal锛夐噷鐨勮韩浠藉彞銆傛病鍐欎笂鏃讹紝棰勮閲岀殑鍘熻韩浠藉彞浼氱暀鍦ㄦ敞鍏ユ梺杈广€?- **#9**锛氬鎵硅姹傝嚜鍔ㄦ斁琛屻€?- **#15**锛氭矙绠?`confine` 涓嶅啀鍖呬竴灞傦紝鍛戒护鎸夊師鏍锋墽琛屻€?- **#23**锛氬瓙浠ｇ悊榛樿娣卞害浠?1 鎻愬埌 10銆?- **#42**锛氱粰璁剧疆鏈嶅姟琛ュ洖鏃х殑 `register` / `get`锛岃繕鍦ㄨ皟鏃ф帴鍙ｇ殑鎻掍欢鎵嶈兘鍔犺浇銆?- 鏂囦欢鍦ㄣ€佷絾杩欎唤鍘熸枃涓嶅湪褰撳墠鐗堟湰閲屾椂锛屾樉绀鸿烦杩囷紝涓嶅啀鎶婃暣娆″簲鐢ㄥ垽澶辫触銆傚師鏂囪繕鍦ㄦ椂浠嶄細鍐欎笂銆?
## English

- **Fixes required-patch failures #43, #9, #15, #23, and #42.** Apply no longer reports the cleanse as incomplete because of these five. The prompt was already written; the failure made the plugin look dead.
- **Cause**: a parent folder named DeepSeek Harness was treated as the official desktop install, so the Web npm packages were excluded and these five were never written. Install paths are not pinned to a drive letter. A tree counts as the desktop install only when the desktop executable is beside it, or the path is under that install's `resources/app`. Web, community desktop, and official desktop each patch their own packages.
- **#43**: strips the identity sentence from the four built-in Web presets (standard, ptc, cordis, minimal). Left in place, that sentence stays next to the inject.
- **#9**: approval requests are auto-granted.
- **#15**: sandbox `confine` no longer wraps the command.
- **#23**: subagent default depth moves from 1 to 10.
- **#42**: the settings service gets the old `register` / `get` methods back, so plugins that still call them can load.
- When the file exists but this version does not contain that original text, the row shows skipped and Apply still completes. Text that is present is still written.

# 1.1.20

## 涓枃

- **瀹夸富鐗堟湰**锛氬綋鍓嶅鍑?**dsh 0.1.7-rc.2**銆備笂涓€妗?**0.1.7-rc.1**锛堝惈 `0.1.7-rc.1.20260924.1`锛夌殑鏃ч敋鐐逛粛鍙敤銆?- **瀹樻柟妗岄潰鍗囩骇**锛氬凡缁忎笅杞界殑鏂扮増鏈細鍦ㄩ噸鍚紝鎴栧湪搴旂敤閲岀偣瀹夎骞堕噸鍚椂鐪熸瀹夎锛岀劧鍚庤В寮€鏂扮増鏈苟閲嶆柊鎵撹ˉ涓併€傛病鏈夋柊鐗堟湰鏃讹紝閲嶅惎浠嶆槸鍏虫帀鍐嶆墦寮€褰撳墠瀹㈡埛绔€傚畨瑁呯洰褰曚笉鍐欐鐩樼銆?- **琛ヤ竵**锛?14銆?35 璺熶笂 rc.2 鐨勫崌绾у啓娉曪紝涓嶅啀鎶ュ繀闇€琛ヤ竵澶辫触銆?29銆?33銆?36 鐨勬柊鎻愮ず鍙ヤ篃浼氭墦涓娿€?- Web 鍜岀ぞ鍖虹増 DSH Desktop 鐨勫簲鐢ㄣ€侀噸鍚繚鎸佸師鏍枫€?
## English

- **Host version**: current target is **dsh 0.1.7-rc.2**. Anchors for the previous target, **0.1.7-rc.1** (including `0.1.7-rc.1.20260924.1`), still match.
- **Official desktop upgrade**: a downloaded update installs on Restart, or on the in-app install-and-restart action, then the new build is unpacked and patched. With no pending update, Restart still closes and reopens the current client. Install paths are not pinned to a drive letter.
- **Patches**: #14 and #35 match the rc.2 escalation text, so Apply no longer fails those required patches. #29, #33, and #36 follow the new prompt wording.
- Web and community DSH Desktop keep their existing Apply and restart.

# 1.1.19

## 涓枃

- **瀹樻柟妗岄潰 EXE**锛氭敮鎸佸畼鏂?DeepSeek Harness銆傜偣銆屽簲鐢ㄣ€嶈В寮€ `app.asar` 骞惰ˉ涓婂師鐢熸ā鍧楋紝鍐嶇偣銆岄噸鍚€嶏紝瀹㈡埛绔嚜宸卞叧鎺夊苟閲嶆柊鎵撳紑銆俉eb 鍜岀ぞ鍖虹増 DSH Desktop 鐨勫簲鐢ㄣ€侀噸鍚繚鎸佸師鏍枫€?- **閲嶅惎**锛氬畼鏂瑰鎴风閫€鍑轰笉鍐嶈澶栧３褰撴垚宕╂簝锛屼篃涓嶄細鐣欎笅鍚庡彴 PowerShell銆傞噸鍚剼鏈笉鍐嶈皟鐢?Windows 鑴氭湰瀹夸富娌℃湁鐨?`toISOString`锛岄伩鍏嶅脊鍑鸿繍琛屾椂閿欒銆傛柊杩涚▼涓嶅啀缁ф壙 `ELECTRON_RUN_AS_NODE`锛屽惁鍒欎細鍒氭墦寮€灏遍€€鍑恒€?- **鏇存柊**锛氭崲鐗堟湰鎴栧洖閫€鏃讹紝鎸夎惤鍦扮殑閭ｄ竴鐗堣嚜鍔ㄨ繕鍘熷啀搴旂敤锛屼笉蹇呮瘡娆℃墜鍔ㄥ厛杩樺師鍐嶅簲鐢ㄥ啀閲嶅惎銆?- **琛ヤ竵鍒楄〃**锛氬涓诲凡缁忚嚜甯?`dsh-web-fetch-http` 鏃讹紝涓嶅啀鏄剧ず涓€鏉℃案杩滆烦杩囩殑 #20銆傚畨瑁呯洰褰曚笉鍐嶅啓姝荤洏绗︺€?
## English

- **Official desktop EXE**: Apply on official DeepSeek Harness unpacks `app.asar`, restores native modules, then Restart closes the client and opens it again. Web and community DSH Desktop keep their existing Apply and restart.
- **Restart**: exiting the official host is no longer treated as a crash, and no PowerShell process is left behind. The helper no longer calls `toISOString`, which made Windows Script Host pop a runtime error. The new process does not inherit `ELECTRON_RUN_AS_NODE`, which made it exit immediately.
- **Updates**: switching or rolling back a version restores and reapplies that version's patches without a manual revert first.
- **Patch list**: hosts that already depend on `dsh-web-fetch-http` no longer show a permanently skipped #20. Install paths are not pinned to a drive letter.

# 1.1.18

## 涓枃

- **閲嶅惎**锛氱偣銆岄噸鍚€嶅悗鏃ч〉闈㈢殑 token 浼氬け鏁堬紝鍙埛鏂扮瓑浜庢墦涓嶅紑銆傜幇鍦ㄤ細绛夌鍙ｉ噴鏀撅紙蹇呰鏃剁粨鏉熸棫杩涚▼锛夛紝骞舵寜鏂拌繘绋嬫墦鍗扮殑鍦板潃鎵撳紑娴忚鍣ㄣ€傝鐢ㄦ柊鎵撳紑鐨勯〉闈紝鍐嶆柊寮€涓€杞璇濄€?- **璁剧疆**锛?.1.17 涔嬪墠鑻ュ凡鎶?`legacyApplyPath` 鍙犺繘 `dsh-settings`锛岀偣銆屽簲鐢ㄣ€嶄細鏀舵垚涓€浠斤紝鎻愪緵鍟嗙洰褰曟墠鑳借捣鏉ャ€傛敹濂戒箣鍚庡啀閲嶅惎涓€娆°€?
## English

- **Restart**: the old page token dies with the process, so a refresh looks like restart did nothing. Restart now frees the port and opens the browser at the new `dsh web:` URL. Use that page and start a new chat.
- **Settings**: Apply collapses duplicate `legacyApplyPath` left by earlier 1.1.17 patches so `dsh-settings` can load. Restart once after that apply.

# 1.1.17

## 涓枃

- **绋冲畾鎬?*锛氫慨澶嶈缃ˉ涓?#42 鍦?dsh 0.1.7 涓婇噸澶嶆彃鍏?`legacyApplyPath` 鐨勯棶棰樸€傛鍓嶄細瀵艰嚧 `@deepseek-ai/dsh-settings` 鏃犳硶鍔犺浇銆佹彁渚涘晢鐩綍鎶ラ敊銆乵nemon 绛夋彃浠惰繛閿?pending銆傜幇鏀逛负 `skipIfMarked`锛屼笖涓嶅啀涓庡畼鏂瑰凡鑷甫鐨?`legacyApplyPath` 鍙犲啓銆?- **宸ヤ綔鍖哄己鎸囦护**锛?1/#2 鍚屾椂璇嗗埆 `WORKSPACE_*` 涓?`AGENT_*` 甯搁噺鍚嶏紝閬垮厤銆屽叏灞€/鏇挎崲寮忓厤璐ｃ€嶅湪鏃у涓讳笂鏄剧ず璺宠繃銆佸簲鐢ㄦ棤鏁堛€?- **鎷掔瓟涓庤蒋鎷?*锛氬畼鏂?`agent-instructions` 寮烘寚浠よˉ鍏呮湰鏈烘巿鏉冭瘎娴嬩笌鍙嶈蒋鎷掕瘽鏈紱鎻掍欢澧炲姞鍥哄畾 `dsh-purge:rules` 娈碉紙涓庢墽琛岃鍒欎竴鑷达級銆?*鏂板紑浼氳瘽骞堕噸鍚?dsh 鍚?*鐢熸晥銆?
## English

- **Stability**: patch #42 no longer stacks duplicate `legacyApplyPath` on dsh 0.1.7, which broke `@deepseek-ai/dsh-settings`, provider catalog loading, and downstream plugins. Uses `skipIfMarked` and does not re-insert the helper the official package already ships.
- **Workspace intros**: patches #1/#2 match both `WORKSPACE_*` and `AGENT_*` constant names so rows no longer show Skipped on older installs.
- **Refusal / soft refusal**: stronger official workspace intros plus a fixed `dsh-purge:rules` section. **Restart dsh and start a new chat** for prompt changes.

# 1.1.16

## 涓枃

- 瀵瑰噯 **dsh 0.1.7-rc.1**銆傚伐浣滃尯璇存槑甯搁噺鏀瑰悕涓?`AGENT_INSTRUCTIONS_INTRO`锛屽彞瀛愭病鍙橈紝琛ヤ竵璺熺潃鏀广€?- 娌欑 `confine()` 宸叉槸 `async confine(argv, policy, signal)`锛岃ˉ涓佹寜鏂板嚱鏁板啓銆傜洿閫氳涓轰笌涓婁竴鐗堢浉鍚屻€?- 瀛愪唬鐞嗘繁搴︽敼鍒?`dsh-subagent`锛岄粯璁や粠 1 鎻愬埌 10銆傛繁搴︽鏌ヨ繕鍦ㄣ€?- 璁剧疆鏈嶅姟琛ュ洖鏃х殑 `register` / `get`銆俙dsh-mnemon`銆乣dsh-better-reasoning-effort` 杩欑被杩樺湪璋冩棫鎺ュ彛鐨勬彃浠跺彲浠ョ户缁敤銆傚畼鏂?`describe` / `update` 涓嶅姩銆傝ˉ涓佸彧鎵撲竴娆★紝涓嶄細鍦ㄥ惎鍔ㄦ椂閲嶅鎻掑叆銆?- 鍒犳帀 0.1.7 閲屽凡缁忓涓嶄笂鐨勬棫鏉℃枃锛屽寘鎷崟鐙粰 `dsh-base` 琛?`dsh-web-fetch-http` 渚濊禆鐨勯偅鏉°€傚畼鏂瑰寘宸茬粡鑷甫銆?- Web 鍥涗釜鍐呯疆棰勮锛坰tandard銆乸tc銆乧ordis銆乵inimal锛夊彧娓呯┖韬唤鍙ャ€傚伐浣滅洰褰曘€佸伐鍏峰垪琛ㄣ€乣ptc` 妯″紡锛屼互鍙?minimal 鐨?`complete: true` 鍜?`includeRuntimeContext: false` 涓嶅姩銆?- `complete: true` 鏃讹紝`prompt-inject.md` 浠嶆帴鍦ㄨ繖娈靛墠闈€傛崲瀹夸富鐗堟湰鎴栨棫閽╁瓙鍒犳涔嬪悗锛屾敞鍏ヤ笉浼氫涪銆傜偣銆屽簲鐢ㄣ€嶄箣鍚庝粛瑕佸啀鐐广€岄噸鍚€嶏紝鏂板紑涓€杞璇濇墠杩涘綋鍓嶄細璇濄€?- `dsh-compaction-instant` 缃戦〉绔粠宸插垹闄ょ殑 `settingsScope` 鏀瑰埌 `configForms`锛岄〉闈笉鍐嶅仠鍦?Failed to load plugins銆?- 鍥為€€鍦?0.1.7 涓婁細寤哄嚭鏂颁細璇濓紝浣嗙晫闈粛鍋滃湪鏃у璇濓紝鐪嬭捣鏉ュ儚娌″弽搴斻€?.1.7 宸叉病鏈?`sessions.open`銆傜幇鍦ㄦ敼鐢?`uiWorkspace.openSession` 鍒囧埌鏂颁細璇濓紝骞舵妸涓婁竴鍙ュ～鍥炶緭鍏ユ銆傚け璐ュ師鍥犳樉绀哄湪鎸夐挳涓娿€?- README 鐨勮禐璧忓尯鎹㈡垚闈炵泩鍒╁０鏄庯細涓ョ鍟嗕笟鍞崠銆佷粯璐瑰€掑崠鎴栭粦鐏颁骇鐗熷埄锛屼粎渚涙妧鏈弬鑰冦€?
## English

- Aligned with **dsh 0.1.7-rc.1**. The workspace-instruction constant is now `AGENT_INSTRUCTIONS_INTRO`. The sentence is unchanged, and the patch follows it.
- Sandbox `confine()` is now `async confine(argv, policy, signal)`, and the patch matches that function. Passthrough behavior is the same as the previous release.
- Subagent depth lives on `dsh-subagent`. The default moves from 1 to 10. The depth check remains.
- The settings service again exposes the old `register` / `get` methods, so plugins such as `dsh-mnemon` and `dsh-better-reasoning-effort` keep working. Official `describe` / `update` stay. The patch applies once and does not insert itself again on startup.
- Patch text that no longer exists in 0.1.7 is removed, including the extra `dsh-web-fetch-http` dependency on `dsh-base`. The official package already depends on it.
- The four built-in Web presets (standard, ptc, cordis, minimal) lose only the identity sentence. The working-directory suffix, tool lists, `ptc` mode, and minimal's `complete: true` plus `includeRuntimeContext: false` stay.
- When `complete: true`, `prompt-inject.md` is still prepended to that section. A host upgrade or an older hook that drops the section does not drop the inject. After Apply you still click Restart and start a new chat before it enters the session.
- The `dsh-compaction-instant` web client uses `configForms` instead of the removed `settingsScope`, so the page no longer stops on Failed to load plugins.
- Rewind on 0.1.7 created the new session and left the UI on the old chat, so the click looked dead. 0.1.7 has no `sessions.open`. The button now opens the new session with `uiWorkspace.openSession` and puts the previous user line back in the composer. A failure shows on the button.
- The README sponsor block is now a non-profit notice: no commercial resale and no gray-market profit; technical reference only.
