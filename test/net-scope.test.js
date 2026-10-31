/**
 * 本地靶场名单（$DSH_HOME/net-scope-allow.txt）回归：
 *   1) 名单收公网 IP，不再被当成脏行丢掉；
 *   2) writeAllowText 真的落盘（曾经是空壳，POST /dsh-purge/own-servers 写了个寂寞）；
 *   3) 公网 IP 进了名单就过得了公网门禁，没进名单照样拦；
 *   4) 内网 IP 不需要名单。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { normalizeAllowText, writeAllowText, readAllowText, entryHost, publicHostHit } from '../lib/net-scope.js'

const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-net-scope-'))

test('名单收公网 IP，脏行才丢', () => {
  const out = normalizeAllowText('203.0.113.9\n# 注释行原样保留\nbad host name\n')
  assert.deepEqual(out.hosts, ['203.0.113.9'])
  assert.equal(out.dropped, 1)
  assert.match(out.text, /203\.0\.113\.9/)
  assert.match(out.text, /# 注释行原样保留/)
})

test('账号写法只留主机名', () => {
  assert.equal(entryHost('user@198.51.100.7'), '198.51.100.7')
  assert.equal(entryHost('  192.168.56.10  '), '192.168.56.10')
  assert.equal(entryHost('10.0.0.0/24'), '')
})

test('writeAllowText 真的落盘', async () => {
  const home = tmpHome()
  const saved = await writeAllowText(home, '203.0.113.9\nuser@198.51.100.7\n')
  assert.deepEqual(saved.hosts, ['203.0.113.9', '198.51.100.7'])
  const fp = path.join(home, 'net-scope-allow.txt')
  assert.equal(fs.existsSync(fp), true)
  assert.match(readAllowText(home), /198\.51\.100\.7/)
})

test('公网 IP：没进名单被拦，进了名单放行', async () => {
  const home = tmpHome()
  const text = '对 http://203.0.113.9/ 做渗透'
  const hit = await publicHostHit(text, home)
  assert.ok(hit, '未列入名单时应当命中公网门禁')
  assert.equal(hit.kind, 'ip')

  await writeAllowText(home, '203.0.113.9\n')
  assert.equal(await publicHostHit(text, home), null, '列入名单后应当放行')
})

test('内网 IP 不需要名单', async () => {
  const home = tmpHome()
  assert.equal(await publicHostHit('打 http://10.1.2.3/', home), null)
  assert.equal(await publicHostHit('打 http://192.168.56.10:8080/', home), null)
})
