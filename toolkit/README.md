# toolkit 本地目录

这个是运行目录，不是 git 内容：扫描器二进制加起来 300MB+，而且本机亚信/火绒会把
`fscan` / `gogo` / `frp` / `chisel` 当场删掉，所以仓库只带下载器
[`scripts/fetch-toolkit.mjs`](../scripts/fetch-toolkit.mjs)，二进制留在工作区并由
`.gitignore` 排除。

## 已经下好的（本机）

| 工具 | 版本 |
|---|---|
| nuclei | 3.11.1 |
| httpx | 1.12.0 |
| dnsx | 1.3.1 |
| subfinder | 2.17.0 |
| ffuf | 2.3.0 |
| ksubdomain | 2.4.0 |
| suo5 | 2.2.0 |

`nmap` / `masscan` / `impacket` 见脚本 `--list` 末尾说明。

## 重新拉

```powershell
node scripts/fetch-toolkit.mjs
node scripts/fetch-toolkit.mjs --only nuclei,httpx,fscan
node scripts/fetch-toolkit.mjs --list
```

默认输出 `$DSH_HOME/redteam/toolkit`；要拉到本目录用 `--out toolkit`。
被杀的二进制先给杀软加排除目录，或换演练 VM。

## 配进插件

演练台 → `环境适配` → `工具箱目录 toolkitDir` 填本目录绝对路径 → `自动分配` → `保存`。
