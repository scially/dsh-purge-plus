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

**已下线的本地改动（2026-11-03，1.1.91）：**

自动重启整条链**已经删掉**，不要再捡回来：

- `b5a6e63`（重启全程写 `restart.log` + settle 等真实监听）——随 `lib/restart-web.js` 一起删除；
- `c5b9a07`（EPIPE 对照实验 `scripts/verify-epipe.mjs`）——同上，脚本删除；
- `readRecordedUrl`（`lib/web.js` 导出，重启时把记录里的 token 地址传给 helper）——`lib/restart-web.js` 没了，导出与测试一并删除。

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
