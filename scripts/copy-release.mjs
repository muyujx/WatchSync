// 构建后置脚本：将 release 产物复制到项目根目录 release/ 下，便于直接取用。
// 用法：tauri:build 末尾自动调用（node scripts/copy-release.mjs）。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src-tauri', 'target', 'release', 'watchsync.exe');
// 输出目录：根目录 release/（已在 .gitignore 构建产物条目中）；改名首字母大写
const destDir = join(root, 'release');
const destName = 'WatchSync.exe';

// 源产物缺失视为构建失败（tauri build 未产出或路径变更），非 0 退出阻断流水线
if (!existsSync(src)) {
  console.error(`[copy-release] 未找到 release 产物: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, destName));
console.log(`[copy-release] 已复制 ${src} -> ${join(destDir, destName)}`);
