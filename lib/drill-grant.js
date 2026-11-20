/**
 * 演练台授权落在当前 $DSH_HOME/dsh-purge，不进插件包，也不进用户主目录下的共享文件夹。
 * 插件更新只换 node_modules，这个文件还在，所以不再弹窗。
 * 成功卸载会删掉这一份；Web 和桌面各记各的。文件不存在才重新确认。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-files.js";

export function drillGrantPath(dshHome) {
  return join(dshHome, "dsh-purge", "drill-grant.json");
}

export function readDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  if (!existsSync(file)) return { granted: false, path: file };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      granted: !!(raw && raw.granted === true),
      path: file,
      at: raw && raw.at ? raw.at : null,
    };
  } catch {
    return { granted: false, path: file };
  }
}

export function writeDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  const at = new Date().toISOString();
  // 原子替换交给 lib/atomic-files.js：临时文件 + rename 退避。
  // 旧写法「先 unlink 再 rename」中间有一段文件不存在的窗口，写失败还会把旧授权丢掉。
  atomicWriteSync(file, `${JSON.stringify({ granted: true, at }, null, 2)}\n`);
  return readDrillGrant(dshHome);
}

/** 只删当前安装的授权文件。失败向上抛，不删整个目录。 */
export function clearDrillGrant(dshHome) {
  const file = drillGrantPath(dshHome);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
