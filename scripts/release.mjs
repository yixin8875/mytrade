#!/usr/bin/env node
/**
 * 构建带签名的安装包，生成 Tauri 更新清单 latest.json，并可上传到 GitHub Releases。
 *
 * 用法：
 *   npm run release                       # 构建 + 生成清单；能拿到 token 时自动发布
 *   npm run release -- --notes "更新说明"
 *   npm run release -- --skip-build       # 只用已有产物重新生成/上传
 *   npm run release -- --upload           # 必须上传，拿不到 token 直接失败
 *   npm run release -- --no-upload        # 只构建，不上传
 *   npm run release -- --draft            # 发布为草稿
 *
 * 重新运行会先删掉同名资产再上传，重复执行是安全的。
 *
 * 环境变量：
 *   TAURI_SIGNING_PRIVATE_KEY           私钥内容或路径；不设则用 ~/.tauri/mytrade.key
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  私钥密码；默认空
 *   GITHUB_TOKEN / GH_TOKEN             发布 release 所需的 token（contents: write）；
 *                                       都没有时尝试 git credential fill（不会打印 token）
 *   RELEASE_PROXY / HTTPS_PROXY         访问 GitHub 的 HTTP 代理，例如 http://127.0.0.1:12000
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {
  copyFileSync,
  createReadStream,
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

/** 优先用环境变量；没有就静默问 git credential，token 只留在内存里。 */
function resolveToken() {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) return '';
  const match = /^password=(.*)$/m.exec(result.stdout || '');
  return match ? match[1].trim() : '';
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

  // 只发布本次版本的安装包；bundle 目录会保留历史版本，不能一并上传
  const installers = files.filter(
    (file) => (file.endsWith('.msi') || file.endsWith('-setup.exe')) && file.includes(version),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function proxyTarget() {
  const raw = (
    process.env.RELEASE_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    ''
  ).trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    fail(`代理地址无法解析：${raw}`);
  }
}

function connectThroughProxy(proxy, host, port) {
  return new Promise((resolvePromise, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username || proxy.password) {
      const user = decodeURIComponent(proxy.username);
      const pass = decodeURIComponent(proxy.password);
      headers['Proxy-Authorization'] =
        `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 8080),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT ${host}:${port} 失败：HTTP ${response.statusCode}`));
        return;
      }
      resolvePromise(socket);
    });
    request.on('error', reject);
    request.end();
  });
}

/** 直连走 https.request；配了代理就先 CONNECT 建隧道，再在隧道里做 TLS。 */
async function openTransport(host) {
  const proxy = proxyTarget();
  if (!proxy) return { host, servername: host };
  const socket = await connectThroughProxy(proxy, host, 443);
  return { socket, servername: host, host };
}

async function httpsRequest({
  method = 'GET',
  host = 'api.github.com',
  path,
  headers = {},
  body = null,
  file = null,
}) {
  const transport = await openTransport(host);
  return new Promise((resolvePromise, reject) => {
    const request = https.request(
      { ...transport, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(120_000, () => request.destroy(new Error('GitHub 请求超时')));
    if (file) {
      const stream = createReadStream(file);
      stream.on('error', reject);
      stream.pipe(request);
    } else {
      request.end(body ?? undefined);
    }
  });
}

async function withRetry(label, task, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (attempt >= attempts) break;
      console.warn(`[release] ${label}失败（第 ${attempt} 次）：${error.message}，重试…`);
      await sleep(1500 * attempt);
    }
  }
  throw last;
}

function requestHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tally-release',
    ...extra,
  };
}

async function github(path, token, init = {}) {
  const response = await httpsRequest({
    method: init.method ?? 'GET',
    path,
    headers: requestHeaders(token, init.headers),
    body: init.body,
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: response.text,
    json: () => JSON.parse(response.text || '{}'),
  };
}

async function githubGet(path, token) {
  return withRetry(`查询 ${path} `, () => github(path, token));
}

async function deleteAsset(assetId, token) {
  return withRetry(`删除资产 ${assetId} `, async () => {
    const response = await github(`/repos/${REPO}/releases/assets/${assetId}`, token, {
      method: 'DELETE',
    });
    // 上一次重试其实已经删掉时按成功处理
    return response.status === 404 ? { ...response, ok: true } : response;
  });
}

async function removeAssetByName(releaseId, name, token) {
  const response = await githubGet(
    `/repos/${REPO}/releases/${releaseId}/assets?per_page=100`,
    token,
  );
  if (!response.ok) return;
  const assets = response.json();
  const old = Array.isArray(assets) ? assets.find((asset) => asset.name === name) : null;
  if (old) await deleteAsset(old.id, token);
}

async function ensureRelease(version, notes, token, draft) {
  const tag = `v${version}`;
  const existing = await githubGet(`/repos/${REPO}/releases/tags/${tag}`, token);
  if (existing.ok) {
    const release = existing.json();
    console.log(`[release] 已存在 release ${tag}，更新资产…`);
    return release;
  }
  if (existing.status !== 404) {
    fail(`查询 release 失败：HTTP ${existing.status} ${existing.text}`);
  }

  const created = await github(`/repos/${REPO}/releases`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `Tally ${tag}`,
      body: notes,
      draft,
      prerelease: false,
      make_latest: 'true',
    }),
  });
  if (!created.ok) {
    // 网络抖动时可能已经建好了，再查一次，避免把成功当成失败
    const again = await githubGet(`/repos/${REPO}/releases/tags/${tag}`, token).catch(() => null);
    if (again?.ok) {
      console.log(`[release] release ${tag} 已存在（创建响应丢失），继续上传`);
      return again.json();
    }
    fail(`创建 release 失败：HTTP ${created.status} ${created.text}`);
  }
  console.log(`[release] 已创建 release ${tag}`);
  return created.json();
}

async function uploadAsset(releaseId, file, token) {
  const name = basename(file);
  const size = statSync(file).size;
  const send = () =>
    httpsRequest({
      method: 'POST',
      host: 'uploads.github.com',
      path: `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      headers: requestHeaders(token, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      }),
      file,
    });

  let response = await withRetry(`上传 ${name} `, send);
  if (response.status === 422) {
    // 上一次其实传成功了，只是响应丢了：删掉同名资产再传一次
    await removeAssetByName(releaseId, name, token);
    response = await withRetry(`重传 ${name} `, send);
  }
  if (response.status < 200 || response.status >= 300) {
    fail(`上传 ${name} 失败：HTTP ${response.status} ${response.text.slice(0, 300)}`);
  }
  console.log(`[release] 已上传 ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
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
      const removed = await deleteAsset(old.id, token);
      if (!removed.ok) fail(`替换资产 ${name} 失败：HTTP ${removed.status}`);
      assets = assets.filter((asset) => asset.id !== old.id);
    }
    await uploadAsset(release.id, file, token);
  }
}

async function main() {
  if (flag('upload') && flag('no-upload')) {
    fail('--upload 和 --no-upload 不能同时使用');
  }
  const version = readVersion();
  const notes =
    option('notes') ||
    process.env.RELEASE_NOTES ||
    `Tally v${version}：新增 GitHub 自动更新，修复与改进见提交记录。`;
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

  const token = resolveToken();
  if (!token) {
    if (flag('upload')) {
      fail(
        '没有找到 GitHub token。设置 GITHUB_TOKEN / GH_TOKEN，' +
          '或先让 git 记住 github.com 的凭据（git credential 会静默读取，不会打印 token）。',
      );
    }
    console.log(
      '\n[release] 没有可用的 GitHub token，跳过上传。\n' +
        '  设置一个有 contents: write 权限的 GITHUB_TOKEN / GH_TOKEN，' +
        '或让 git credential 记住 github.com 凭据后重新运行；\n' +
        '  也可以手动把 artifacts/release 下的文件上传到 ' +
        `https://github.com/${REPO}/releases/new（tag: v${version}，需包含 latest.json）。`,
    );
    return;
  }

  const proxy = proxyTarget();
  if (proxy) {
    const port = proxy.port ? `:${proxy.port}` : '';
    console.log(`[release] 通过代理 ${proxy.protocol}//${proxy.hostname}${port} 访问 GitHub`);
  }

  const release = await ensureRelease(version, notes, token, flag('draft'));
  await uploadAssets(release, staged, token);
  console.log(`\n[release] 完成：https://github.com/${REPO}/releases/tag/v${version}`);
  console.log(
    `[release] 下载地址：https://github.com/${REPO}/releases/latest/download/latest.json`,
  );
}

main().catch((error) => fail(error?.stack || String(error)));
