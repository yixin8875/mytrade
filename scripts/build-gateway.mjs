#!/usr/bin/env node
/**
 * 用 PyInstaller 把 Python 网关打成单文件 sidecar。
 *
 * 产物：src-tauri/binaries/mytrade-gateway-<target-triple>.exe
 * 用法：npm run gateway:build [-- --force]
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src-tauri', 'binaries');
const BUILD_DIR = join(ROOT, 'build', 'pyinstaller');
const NAME = 'mytrade-gateway';
const force = process.argv.includes('--force');

function fail(message) {
  console.error(`\n[gateway] ${message}\n`);
  process.exit(1);
}

function targetTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail('找不到 rustc，无法确定 sidecar 目标平台。请先安装 Rust 工具链。');
  }
  const match = /^host:\s*(\S+)/m.exec(result.stdout || '');
  if (!match) fail('无法从 rustc -vV 读取 host target triple');
  return match[1];
}

function newestSource() {
  const files = [
    join(ROOT, 'scripts', 'build-gateway.mjs'),
    join(ROOT, 'gateway', 'requirements.txt'),
    join(ROOT, 'gateway', 'requirements-build.txt'),
  ];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.py')) files.push(full);
    }
  };
  walk(join(ROOT, 'gateway'));
  return Math.max(...files.filter(existsSync).map((file) => statSync(file).mtimeMs));
}

if (process.platform !== 'win32') {
  fail('当前只为 Windows 构建桌面版 sidecar。');
}

const triple = targetTriple();
const output = join(OUT_DIR, `${NAME}-${triple}.exe`);
if (!force && existsSync(output) && statSync(output).mtimeMs >= newestSource()) {
  console.log(`[gateway] sidecar 已是最新：${output}`);
  process.exit(0);
}

// 优先使用独立的构建虚拟环境，避免 Anaconda 等全局环境里的 Qt/Sphinx 等包被误打包
const venvPython = join(ROOT, 'build', 'gateway-venv', 'Scripts', 'python.exe');
const python = process.env.PYTHON || (existsSync(venvPython) ? venvPython : 'python');
const probe = spawnSync(python, ['-c', 'import PyInstaller'], { encoding: 'utf8' });
if (probe.status !== 0) {
  fail(
    '构建环境缺少 PyInstaller。请先运行：npm run gateway:setup\n' +
      '（会创建 build/gateway-venv 并安装 gateway/requirements-build.txt）',
  );
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(BUILD_DIR, { recursive: true });

const args = [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name',
  NAME,
  '--distpath',
  OUT_DIR,
  '--workpath',
  join(BUILD_DIR, 'work'),
  '--specpath',
  BUILD_DIR,
  '--paths',
  join(ROOT, 'gateway'),
  '--icon',
  join(ROOT, 'src-tauri', 'icons', 'icon.ico'),
  // MetaTrader5 的 C 扩展通过 numpy C API 加载，numpy 2.x 的子模块需要显式收集
  '--collect-all',
  'numpy',
  '--collect-all',
  'MetaTrader5',
  // uvicorn 通过字符串动态导入这些模块，PyInstaller 无法静态发现
  '--hidden-import',
  'uvicorn.logging',
  '--hidden-import',
  'uvicorn.loops.auto',
  '--hidden-import',
  'uvicorn.loops.asyncio',
  '--hidden-import',
  'uvicorn.protocols.http.auto',
  '--hidden-import',
  'uvicorn.protocols.http.h11_impl',
  '--hidden-import',
  'uvicorn.protocols.websockets.auto',
  '--hidden-import',
  'uvicorn.protocols.websockets.websockets_impl',
  '--hidden-import',
  'uvicorn.lifespan.on',
  join(ROOT, 'gateway', 'app.py'),
];

console.log(`[gateway] 正在构建 ${triple} sidecar…`);
const build = spawnSync(python, args, { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) fail('PyInstaller 构建失败');

const raw = join(OUT_DIR, `${NAME}.exe`);
if (!existsSync(raw)) fail(`构建结束但找不到产物：${raw}`);
if (existsSync(output)) unlinkSync(output);
renameSync(raw, output);
const size = (statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`[gateway] 已生成 ${output} (${size} MB)`);
