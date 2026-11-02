#!/usr/bin/env node
/**
 * 下载红队工具箱到 $DSH_HOME/redteam/toolkit（或 --out 指定目录）。
 *
 * 二进制不进 git：nuclei 单文件就 145MB，整包 300MB+，而且本机亚信/火绒会把
 * fscan / gogo / frp 直接删掉。仓库只保留这份可复现的下载清单。
 *
 * 用法：
 *   node scripts/fetch-toolkit.mjs                 # 全部
 *   node scripts/fetch-toolkit.mjs --only nuclei,httpx,fscan
 *   node scripts/fetch-toolkit.mjs --out D:\lab\toolkit --force
 *   node scripts/fetch-toolkit.mjs --list
 *
 * 依赖：Windows 自带 tar.exe（bsdtar，能解 zip/gz）；nmap / masscan / impacket 见 --list 末尾说明。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]
}
const has = (name) => argv.includes('--' + name)

const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')
const outDir = resolve(argOf('out', join(root, 'toolkit')))
const dlDir = join(outDir, '_dl')
const force = has('force')
const only = String(argOf('only', '')).split(',').map((x) => x.trim()).filter(Boolean)

/**
 * 每项：id / 版本 / 下载地址 / 压缩包内要取的文件 / 落地文件名 / sha256（可选）。
 * 只写官方 release 资产；masscan 官方没有 Windows 二进制，单独列在 NOTES。
 */
const TOOLS = [
  {
    id: 'nuclei', version: 'v3.11.1',
    url: 'https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_windows_amd64.zip',
    member: 'nuclei.exe', target: 'nuclei.exe',
    sha256: 'bb6cb9ff8939b753f6fcab06fd30a15f5bc61d8382a597871334c007a85ff9d2',
  },
  {
    id: 'httpx', version: 'v1.12.0',
    url: 'https://github.com/projectdiscovery/httpx/releases/download/v1.12.0/httpx_1.12.0_windows_amd64.zip',
    member: 'httpx.exe', target: 'httpx.exe',
  },
  {
    id: 'dnsx', version: 'v1.3.1',
    url: 'https://github.com/projectdiscovery/dnsx/releases/download/v1.3.1/dnsx_1.3.1_windows_amd64.zip',
    member: 'dnsx.exe', target: 'dnsx.exe',
  },
  {
    id: 'subfinder', version: 'v2.17.0',
    url: 'https://github.com/projectdiscovery/subfinder/releases/download/v2.17.0/subfinder_2.17.0_windows_amd64.zip',
    member: 'subfinder.exe', target: 'subfinder.exe',
  },
  {
    id: 'ffuf', version: 'v2.3.0',
    url: 'https://github.com/ffuf/ffuf/releases/download/v2.3.0/ffuf_2.3.0_windows_amd64.zip',
    member: 'ffuf.exe', target: 'ffuf.exe',
  },
  {
    id: 'fscan', version: 'v2.2.2',
    url: 'https://github.com/shadow1ng/fscan/releases/download/v2.2.2/fscan-nolocal_2.2.2_windows_x64.exe',
    member: null, target: 'fscan.exe',
    sha256: 'b7571f196cd68f0ed7173f462371e9d477230152345e982deb7fa155f8bd890a',
  },
  {
    id: 'gogo', version: 'v2.15.0',
    url: 'https://github.com/chainreactors/gogo/releases/download/v2.15.0/gogo_windows_amd64.exe',
    member: null, target: 'gogo.exe',
    sha256: 'c3f56039ca1b647d2f64a4c541877638d8d39631eeea7a23f9595cf578a46d87',
  },
  {
    id: 'suo5', version: 'v2.2.0',
    url: 'https://github.com/zema1/suo5/releases/download/v2.2.0/suo5-windows-amd64.exe',
    member: null, target: 'suo5.exe',
    sha256: 'e0e83bbcdae5bddc0cf1367207f454b32b6c110ebfa2a46589c18932fdb946ac',
  },
  {
    id: 'ksubdomain', version: 'v2.4.0',
    url: 'https://github.com/boy-hack/ksubdomain/releases/download/v2.4.0/KSubdomain-v2.4.0-windows-amd64.zip',
    member: 'ksubdomain.exe', target: 'ksubdomain.exe',
    sha256: 'fb1e281ec7115bca038ee62167f363cbb3504916bc54a6f7ffe8237e19841b53',
  },
  {
    id: 'chisel', version: 'v1.12.0',
    url: 'https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_windows_amd64.zip',
    member: 'chisel.exe', target: 'chisel.exe',
  },
  {
    id: 'frp', version: 'v0.71.1',
    url: 'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip',
    members: ['frpc.exe', 'frps.exe'], target: '.',
  },
]

const NOTES = `
未包含（官方不给 Windows 独立二进制，或需要额外运行时）：
  nmap       winget install Insecure.Nmap   → 把 C:\\Program Files (x86)\\Nmap 填进 binDirs
  masscan    官方 release 只有源码（1.3.2），需 CMake/VS 自编，或 WSL/Kali 里装
  impacket   pip install impacket           → 把 Python 的 Scripts\\secretsdump.py 填进工具路径
  nuclei 模板  nuclei.exe -update-templates  → 生成 %USERPROFILE%\\nuclei-templates
             或在环境适配里把模板目录指到 toolkit\\nuclei-templates
`

function log(line) { process.stdout.write(line + '\n') }

function download(url) {
  const file = join(dlDir, basename(new URL(url).pathname))
  if (existsSync(file) && !force) return file
  mkdirSync(dlDir, { recursive: true })
  log('  ↓ ' + url)
  const r = spawnSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-o', file, url], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('下载失败：' + url)
  if (!existsSync(file) || statSync(file).size === 0) throw new Error('下载后文件不存在（可能被杀软删了）：' + file)
  return file
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function extract(archive, member) {
  if (member === null) return archive
  const tmp = join(dlDir, 'x-' + Date.now())
  mkdirSync(tmp, { recursive: true })
  const r = spawnSync('tar.exe', ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('解压失败：' + archive)
  const hit = join(tmp, member)
  if (!existsSync(hit)) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error('压缩包里没有 ' + member + '：' + archive)
  }
  return hit
}

function installOne(tool) {
  log(`[${tool.id}] ${tool.version}`)
  const archive = download(tool.url)
  if (tool.sha256) {
    const got = sha256(archive)
    if (got !== tool.sha256) throw new Error(`sha256 不匹配：${tool.id}\n  期望 ${tool.sha256}\n  实际 ${got}`)
  }
  const members = tool.members || [tool.member]
  const extracted = members.map((m) => extract(archive, m))
  for (const file of extracted) {
    const target = tool.target === '.' ? join(outDir, basename(file)) : join(outDir, tool.target)
    if (existsSync(target)) rmSync(target, { force: true })
    renameSync(file, target)
    log('  → ' + target)
  }
}

if (has('list')) {
  for (const t of TOOLS) log(`${t.id.padEnd(11)} ${t.version.padEnd(9)} ${t.url}`)
  log(NOTES)
  process.exit(0)
}

const picked = only.length ? TOOLS.filter((t) => only.includes(t.id)) : TOOLS
if (!picked.length) {
  log('没有匹配的工具。可用：' + TOOLS.map((t) => t.id).join(', '))
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
log('输出目录：' + outDir)
log('注意：fscan / gogo / frp / chisel 会被部分国产杀软当场删除；被删就先加排除目录，或换演练 VM。')
let ok = 0
for (const tool of picked) {
  try { installOne(tool); ok += 1 } catch (e) { log('  ✗ ' + (e && e.message ? e.message : e)) }
}
log(`完成 ${ok}/${picked.length}。${NOTES}`)
