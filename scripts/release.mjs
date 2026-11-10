#!/usr/bin/env node
/**
 * 构建带签名的安装包，生成 Tauri 更新清单 latest.json，并可上传到 GitHub Releases。
 *
 * 用法：
 *   npm run release                       # 构建 + 生成清单；有 GITHUB_TOKEN 时自动发布
 *   npm run release -- --notes "更新说明"
 *   npm run release -- --skip-build       # 只用已有产物重新生成/上传
 *   npm run release -- --no-upload        # 只构建，不上传
 *   npm run release -- --draft            # 发布为草稿
 *
 * 环境变量：
 *   TAURI_SIGNING_PRIVATE_KEY           私钥内容或路径；不设则用 ~/.tauri/mytrade.key
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  私钥密码；默认空
 *   GITHUB_TOKEN / GH_TOKEN             发布 release 所需的 token（contents: write）
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO = 'yixin8875/mytrade';
const RELEASE_DIR = join(ROOT, 'artifacts', 'release');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};

function fail(message) {
  console.error(`\n[release] ${message}\n`);
  process.exit(1);
}

function readVersion() {
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (!conf.version) fail('tauri.conf.json 里没有 version');
  return conf.version;
}

function resolveSigningKey() {
  const fromEnv = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() ?? '';
  if (fromEnv && !fromEnv.includes('BEGIN')) {
    // 传的是路径
    if (!existsSync(fromEnv)) fail(`TAURI_SIGNING_PRIVATE_KEY 指向的文件不存在：${fromEnv}`);
    return readFileSync(fromEnv, 'utf8').trim();
  }
  if (fromEnv) return fromEnv;

  const fallback = join(homedir(), '.tauri', 'mytrade.key');
  if (existsSync(fallback)) return readFileSync(fallback, 'utf8').trim();
  return '';
}

function runBuild(signingKey) {
  if (!existsSync(join(ROOT, 'public', 'charting_library', 'charting_library.standalone.js'))) {
    fail(
      '缺少 public/charting_library/。TradingView 图表库没有提交到 git，' +
        '发布前需要先把它复制回 public/charting_library/。',
    );
  }
  if (!signingKey) {
    fail(
      '找不到更新签名私钥。请设置 TAURI_SIGNING_PRIVATE_KEY，' +
        '或把私钥放到 ~/.tauri/mytrade.key（可用 npm run tauri -- signer generate 生成）。',
    );
  }

  console.log(`[release] 构建 v${readVersion()}（含更新签名）…`);
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  };
  const result = spawnSync('npm', ['run', 'tauri:build'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail('tauri build 失败');
}

function collectArtifacts(version) {
  const bundle = join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
  if (!existsSync(bundle)) fail(`找不到构建产物目录：${bundle}`);

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(bundle);

  // Tauri v2 的 Windows 更新包就是 NSIS 安装器本身，签名在同名 .sig；
  // 旧版本 / 其他打包方式也可能生成 *.nsis.zip，这里一并兼容。
  const exes = files.filter((file) => file.endsWith('-setup.exe'));
  const zips = files.filter((file) => file.endsWith('.nsis.zip'));
  const candidates = exes.length > 0 ? exes : zips;
  if (candidates.length === 0) {
    fail(
      '没有找到 NSIS 更新包（*-setup.exe）。请确认 tauri.conf.json 的 ' +
        'bundle.createUpdaterArtifacts 为 true，并且安装包构建成功。',
    );
  }
  const updaterPackage = candidates.find((file) => basename(file).includes(version)) ?? candidates[0];
  const signatureFile = `${updaterPackage}.sig`;
  if (!existsSync(signatureFile)) fail(`缺少签名文件：${signatureFile}`);

  const installers = files.filter(
    (file) =>
      (file.endsWith('.msi') || file.endsWith('-setup.exe')) &&
      (file.includes(version) || !file.includes('_x64_')),
  );
  const signatures = installers.map((file) => `${file}.sig`).filter(existsSync);

  return {
    updaterPackage,
    updaterSig: signatureFile,
    installers,
    signatures,
  };
}

function buildManifest({ version, notes, updaterPackage, updaterSig }) {
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: readFileSync(updaterSig, 'utf8').trim(),
        url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(
          basename(updaterPackage),
        )}`,
      },
    },
  };
  mkdirSync(RELEASE_DIR, { recursive: true });
  const latestPath = join(RELEASE_DIR, 'latest.json');
  writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return latestPath;
}

function stageArtifacts({ updaterPackage, updaterSig, installers, signatures }, latestPath) {
  mkdirSync(RELEASE_DIR, { recursive: true });
  const staged = [updaterPackage, updaterSig, ...installers, ...signatures, latestPath];
  for (const file of staged) {
    const target = join(RELEASE_DIR, basename(file));
    if (resolve(file) !== resolve(target)) copyFileSync(file, target);
  }
  return [...new Set(staged.map((file) => join(RELEASE_DIR, basename(file))))];
}

async function github(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mytrade-release',
      ...(init.headers ?? {}),
    },
  });
  return response;
}

async function ensureRelease(version, notes, token, draft) {
  const tag = `v${version}`;
  const existing = await github(`/repos/${REPO}/releases/tags/${tag}`, token);
  if (existing.ok) {
    const release = await existing.json();
    console.log(`[release] 已存在 release ${tag}，更新资产…`);
    return release;
  }
  if (existing.status !== 404) {
    fail(`查询 release 失败：HTTP ${existing.status} ${await existing.text()}`);
  }

  const created = await github(`/repos/${REPO}/releases`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `MyTrade ${tag}`,
      body: notes,
      draft,
      prerelease: false,
      make_latest: 'true',
    }),
  });
  if (!created.ok) fail(`创建 release 失败：HTTP ${created.status} ${await created.text()}`);
  console.log(`[release] 已创建 release ${tag}`);
  return created.json();
}

async function uploadAssets(release, files, token) {
  // latest.json 最后上传，避免客户端读到指向不存在文件的清单
  const ordered = [
    ...files.filter((file) => !file.endsWith('latest.json')),
    ...files.filter((file) => file.endsWith('latest.json')),
  ];
  let assets = release.assets ?? [];

  for (const file of ordered) {
    const name = basename(file);
    const old = assets.find((asset) => asset.name === name);
    if (old) {
      const removed = await github(`/repos/${REPO}/releases/assets/${old.id}`, token, {
        method: 'DELETE',
      });
      if (!removed.ok) fail(`替换资产 ${name} 失败：HTTP ${removed.status}`);
      assets = assets.filter((asset) => asset.id !== old.id);
    }

    const size = statSync(file).size;
    const response = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
          'User-Agent': 'mytrade-release',
        },
        body: readFileSync(file),
      },
    );
    if (!response.ok) fail(`上传 ${name} 失败：HTTP ${response.status} ${await response.text()}`);
    console.log(`[release] 已上传 ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

async function main() {
  const version = readVersion();
  const notes =
    option('notes') ||
    process.env.RELEASE_NOTES ||
    `MyTrade v${version}：新增 GitHub 自动更新，修复与改进见提交记录。`;
  const signingKey = resolveSigningKey();

  if (!flag('skip-build')) runBuild(signingKey);

  const artifacts = collectArtifacts(version);
  const latestPath = buildManifest({ version, notes, ...artifacts });
  const staged = stageArtifacts(artifacts, latestPath);

  console.log('\n[release] 本地发布文件：');
  console.log(`  ${RELEASE_DIR}`);
  console.log(`[release] 更新清单：${latestPath}`);
  console.log(`[release] 上传的更新包：${basename(artifacts.updaterPackage)}`);

  if (flag('no-upload')) return;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.log(
      '\n[release] 未设置 GITHUB_TOKEN / GH_TOKEN，跳过上传。\n' +
        '  设置一个有 contents: write 权限的 token 后重新运行，或手动把 artifacts/release 下的文件\n' +
        `  上传到 https://github.com/${REPO}/releases/new（tag: v${version}，需包含 latest.json）。`,
    );
    return;
  }

  const release = await ensureRelease(version, notes, token, flag('draft'));
  await uploadAssets(release, staged, token);
  console.log(`\n[release] 完成：https://github.com/${REPO}/releases/tag/v${version}`);
  console.log(
    `[release] 下载地址：https://github.com/${REPO}/releases/latest/download/latest.json`,
  );
}

main().catch((error) => fail(error?.stack || String(error)));
