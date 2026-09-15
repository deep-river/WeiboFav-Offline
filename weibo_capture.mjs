#!/usr/bin/env node
/**
 * Local Weibo favourites archiver.
 *
 * The script intentionally keeps authentication inside a dedicated local Chrome
 * profile. It never reads, prints, exports, or stores browser cookies.
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const STATUS_LINK = /^https:\/\/weibo\.com\/(\d+)\/([A-Za-z0-9]+)(?:[/?#].*)?$/;
const DEFAULT_DATA_DIR = process.env.WEIBOFAV_DATA_DIR || 'data';
const DEFAULTS = {
  dataDir: DEFAULT_DATA_DIR,
  browserProfileDir:
    process.env.WEIBOFAV_BROWSER_PROFILE_DIR ||
    join(DEFAULT_DATA_DIR, 'capture-browser-profile'),
  libraryUrl: 'http://127.0.0.1:4319',
  favoritesUrl: 'https://weibo.com/u/favorites?page={page}',
  delayMinMs: 3500,
  delayMaxMs: 6000,
  batchSize: 20,
  batchPauseMs: 90000,
  maxConsecutiveFailures: 2,
  mediaConcurrency: 2,
  minimumFreeBytes: 10 * 1024 ** 3,
  minimumFreeFraction: 0.1,
  headless: true,
  logDir: process.env.WEIBOFAV_LOG_DIR || join(DEFAULT_DATA_DIR, 'logs'),
};

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
function has(name) {
  return process.argv.includes(name);
}
function usage() {
  console.log(
    `\n微博收藏离线采集脚本\n\n首次登录： node weibo_capture.mjs --login\n采集一页： node weibo_capture.mjs --from-page 1 --pages 1\n续跑队列： node weibo_capture.mjs --resume --limit 20\n重采一条： node weibo_capture.mjs --url https://weibo.com/作者ID/微博短码\n\n默认数据目录为 data/；可在 capture.config.json 或 WEIBOFAV_DATA_DIR 中指定其他位置。请只在该脚本打开的专用浏览器中登录一次。\n`,
  );
}
function now() {
  return new Date().toISOString();
}
function pause(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}
async function retry(label, operation, attempts = 3, logger = null) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.deleted || attempt === attempts) break;
      console.warn(
        `${label} 第 ${attempt}/${attempts} 次失败，${attempt} 秒后自动重试：${error.message || error}`,
      );
      await logger?.log('retry', {
        label,
        attempt,
        attempts,
        error: String(error.message || error),
      });
      await pause(attempt * 1000);
    }
  }
  throw lastError;
}
function jitter(config) {
  return Math.round(
    config.delayMinMs + Math.random() * (config.delayMaxMs - config.delayMinMs),
  );
}
function toPath(value) {
  return isAbsolute(value) ? value : resolve(ROOT, value);
}
function sourceUrl(status) {
  return status?.user?.id && (status.bid || status.mblogid)
    ? `https://weibo.com/${status.user.id}/${status.bid || status.mblogid}`
    : '';
}
function cleanText(value = '') {
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}
function normalizeTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? now() : parsed.toISOString();
}
function mediaUrl(item) {
  return (
    item?.largest?.url ||
    item?.mw2000?.url ||
    item?.original?.url ||
    item?.large?.url ||
    item?.pic_big?.url ||
    item?.pic_large?.url ||
    item?.url ||
    ''
  );
}
function extensionFor(contentType, source) {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('avif')) return '.avif';
  const extension = extname(new URL(source).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(extension)
    ? extension
    : '.jpg';
}
function isImage(buffer, contentType) {
  if (contentType.startsWith('image/')) return true;
  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8) ||
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(0, 4).toString() === 'RIFF'
  );
}
async function config() {
  const file = argument('--config', 'capture.config.json');
  try {
    const overrides = JSON.parse(await readFile(toPath(file), 'utf8'));
    const dataDir = overrides.dataDir || DEFAULTS.dataDir;
    return {
      ...DEFAULTS,
      ...overrides,
      dataDir,
      browserProfileDir:
        overrides.browserProfileDir ||
        process.env.WEIBOFAV_BROWSER_PROFILE_DIR ||
        join(dataDir, 'capture-browser-profile'),
      logDir:
        overrides.logDir ||
        process.env.WEIBOFAV_LOG_DIR ||
        join(dataDir, 'logs'),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULTS;
    throw error;
  }
}
async function createLogger(settings) {
  const started = Date.now();
  const directory = toPath(settings.logDir);
  const stamp = now().replace(/[:.]/g, '-');
  const path = join(directory, `capture-${stamp}.ndjson`);
  await mkdir(directory, { recursive: true });
  return {
    path,
    async log(event, details = {}) {
      const record = {
        at: now(),
        elapsedMs: Date.now() - started,
        event,
        ...details,
      };
      try {
        await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (error) {
        console.warn(`日志写入失败：${error.message || error}`);
      }
    },
  };
}
async function api(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error || `${response.status} ${response.statusText}`,
    );
  return payload;
}
async function ensureSpace(config, bytes = 0) {
  const info = await statfs(toPath(config.dataDir));
  const free = Number(info.bavail) * Number(info.bsize);
  const total = Number(info.blocks) * Number(info.bsize);
  const reserve = Math.max(
    config.minimumFreeBytes,
    Math.floor(total * config.minimumFreeFraction),
  );
  if (free - bytes < reserve)
    throw new Error(
      `磁盘空间保护：剩余 ${Math.floor(free / 1024 ** 3)} GiB，需保留 ${Math.floor(reserve / 1024 ** 3)} GiB`,
    );
}
async function mapLimit(items, maximum, callback) {
  const output = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await callback(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(maximum, items.length) }, worker),
  );
  return output;
}
async function downloadImage(context, item, postId, config) {
  const response = await context.request.get(item.url, {
    timeout: 30000,
    headers: { Referer: 'https://weibo.com/' },
  });
  if (!response.ok())
    throw new Error(`媒体下载失败 ${response.status()}：${item.url}`);
  const contentType = (response.headers()['content-type'] || '').toLowerCase();
  const advertisedLength = Number(response.headers()['content-length'] || 0);
  await ensureSpace(config, advertisedLength);
  const bytes = Buffer.from(await response.body());
  if (!bytes.length || !isImage(bytes, contentType))
    throw new Error(`媒体不是可验证图片：${item.url}`);
  await ensureSpace(config, bytes.length);
  const directory = join(toPath(config.dataDir), 'media', postId);
  await mkdir(directory, { recursive: true });
  const filename = `${item.id}${extensionFor(contentType, item.url)}`;
  const destination = join(directory, filename);
  const temporary = `${destination}.part`;
  try {
    await writeFile(temporary, bytes, { flag: 'w' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const saved = await stat(destination);
  if (saved.size !== bytes.length)
    throw new Error(`媒体尺寸校验失败：${item.url}`);
  return {
    id: `${postId}-${item.id}`,
    kind: item.kind,
    path: `media/${postId}/${filename}`,
    originalUrl: item.url,
    bytes: saved.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function cardIsVideo(card = {}) {
  const media = card.media_info || card.data?.media_info || {};
  return (
    card.object_type === 'video' ||
    card.type === 'video' ||
    media.media_type === 'video' ||
    Boolean(media.stream_url || media.stream_url_hd || media.mp4_hd_url)
  );
}
function cardThumbnail(card = {}) {
  const media = card.media_info || card.data?.media_info || {};
  const pagePic = card.page_pic || card.data?.page_pic;
  return (
    mediaUrl(media.pic_info) ||
    mediaUrl(card.pic_info || card.data?.pic_info) ||
    mediaUrl(media.big_pic_info?.pic_big) ||
    (typeof pagePic === 'string' ? pagePic : mediaUrl(pagePic))
  );
}
function statusMedia(status, prefix) {
  const infos = status.pic_infos || {};
  // pic_ids is the author-defined display order; retain it rather than relying
  // on object enumeration, then include any unusual residual entries once.
  const ordered = [
    ...(Array.isArray(status.pic_ids)
      ? status.pic_ids.map((id) => infos[id])
      : []),
    ...Object.entries(infos)
      .filter(([id]) => !status.pic_ids?.includes(id))
      .map(([, value]) => value),
  ];
  const media = ordered
    .map(mediaUrl)
    .filter(Boolean)
    .map((url, index) => ({
      id: `${prefix}-p${index + 1}`,
      kind: 'image',
      url,
    }));
  const page = status.page_info || {};
  if (cardIsVideo(page)) {
    const thumbnail = cardThumbnail(page);
    if (thumbnail)
      media.push({
        id: `${prefix}-v1`,
        kind: 'video-thumbnail',
        url: thumbnail,
      });
  }
  // Mixed-media posts can contain picture and video cards in addition to
  // pic_infos. Their shape differs across Weibo card versions, so normalize
  // only the documented media-bearing fields instead of scraping page HTML.
  const items = Array.isArray(status.mix_media_info?.items)
    ? status.mix_media_info.items
    : [];
  for (const item of items) {
    const card = item.data || item;
    if (cardIsVideo(card)) {
      const thumbnail = cardThumbnail(card);
      if (thumbnail)
        media.push({
          id: `${prefix}-mv${media.length + 1}`,
          kind: 'video-thumbnail',
          url: thumbnail,
        });
    } else {
      const picture = mediaUrl(card.pic_info || card);
      if (picture)
        media.push({
          id: `${prefix}-mp${media.length + 1}`,
          kind: 'image',
          url: picture,
        });
    }
  }
  return media;
}
function postFromStatus(status, fallbackUrl, originalStatus = null) {
  const original = originalStatus || status.retweeted_status || null;
  const postId = String(status.idstr || status.mid || status.id);
  if (!postId || postId === 'undefined') throw new Error('微博响应缺少 ID');
  const candidates = [
    ...statusMedia(status, 'outer'),
    ...(original ? statusMedia(original, 'original') : []),
  ];
  const unique = [
    ...new Map(candidates.map((item) => [item.url, item])).values(),
  ];
  return {
    post: {
      id: postId,
      author: status.user?.screen_name || '未知作者',
      publishedAt: normalizeTime(status.created_at),
      sourceUrl: fallbackUrl,
      originalUrl: original ? sourceUrl(original) : undefined,
      source: status.source || '微博网页版',
      text: cleanText(status.text_raw || status.text),
      repostText: original
        ? cleanText(original.text_raw || original.text)
        : undefined,
      repostAuthor: original?.user?.screen_name,
      capturedAt: now(),
      tags: [],
      expectedMediaCount: unique.length,
      media: [],
    },
    media: unique,
  };
}
async function statusFromPage(page, bid) {
  const payload = await page.evaluate(async (value) => {
    const response = await fetch(
      `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(value)}&locale=zh-CN&isGetLongText=true`,
      { credentials: 'include' },
    );
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }, bid);
  const status = payload.body?.data || payload.body;
  if (!payload.ok || !status || !(status.idstr || status.mid || status.id)) {
    const keys =
      status && typeof status === 'object'
        ? `（字段：${Object.keys(status).slice(0, 8).join(',')}）`
        : '';
    const message =
      (payload.body?.msg ||
        payload.body?.message ||
        `状态接口返回 ${payload.status}`) + keys;
    if (/不存在|已删除|not exist|deleted/i.test(message)) {
      const error = new Error(message);
      error.deleted = true;
      throw error;
    }
    throw new Error(message);
  }
  return status;
}
async function favoritesOnPage(page) {
  await page.waitForFunction(
    () => /我的收藏（\d+）/.test(document.body.innerText),
    { timeout: 30000 },
  );
  if (!page.url().includes('/u/favorites'))
    throw new Error(`收藏页发生跳转：${page.url()}`);
  const urls = await page.locator('article').evaluateAll((articles) => {
    const pattern = /^https:\/\/weibo\.com\/\d+\/[A-Za-z0-9]+(?:[/?#].*)?$/;
    return [
      ...new Set(
        articles
          .map((article) =>
            [...article.querySelectorAll('a[href]')]
              .map((link) => link.href)
              .find((href) => pattern.test(href)),
          )
          .filter(Boolean),
      ),
    ];
  });
  if (urls.length < 10)
    throw new Error(
      `收藏页只识别到 ${urls.length} 条正文链接，拒绝继续以防混入推流`,
    );
  return urls;
}
async function markJob(config, sourceUrlValue, state, detail) {
  await api(config.libraryUrl, '/api/job', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: sourceUrlValue, state, detail }),
  });
}
async function detailedOriginal(page, status, config, logger) {
  const fallback = status.retweeted_status;
  if (!fallback) return null;
  const originalId = fallback.idstr || fallback.mid || fallback.id;
  if (!originalId) return fallback;
  try {
    // A retweet requires a second detail request. Keep the same randomized
    // pacing as normal posts rather than issuing bursts of paired requests.
    await pause(jitter(config));
    return await retry(
      '原微博详情请求',
      () => statusFromPage(page, String(originalId)),
      3,
      logger,
    );
  } catch (error) {
    // Keep the collected repost when an older original has disappeared; its
    // unavailable media is never represented as successfully downloaded.
    console.warn(`原微博详情不可用，保留转发正文：${error.message || error}`);
    await logger?.log('original_unavailable', {
      error: String(error.message || error),
    });
    return fallback;
  }
}
async function captureOne(page, context, config, url, logger) {
  const match = url.match(STATUS_LINK);
  if (!match) throw new Error(`不是微博正文链接：${url}`);
  // A direct one-post repair may start with a blank tab; establish Weibo's
  // origin before the authenticated status request.
  if (!page.url().startsWith('https://weibo.com/'))
    await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded' });
  const status = await retry(
    '微博正文请求',
    () => statusFromPage(page, match[2]),
    3,
    logger,
  );
  const original = await detailedOriginal(page, status, config, logger);
  const { post, media } = postFromStatus(status, url, original);
  const downloaded = await mapLimit(media, config.mediaConcurrency, (item) =>
    retry(
      '媒体下载',
      () => downloadImage(context, item, post.id, config),
      3,
      logger,
    ),
  );
  if (downloaded.length !== post.expectedMediaCount)
    throw new Error('媒体清单不完整，拒绝入库');
  post.media = downloaded;
  await api(config.libraryUrl, '/api/captured', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ post }),
  });
  return { id: post.id, media: downloaded.length };
}
async function chromeExecutable() {
  if (process.platform === 'darwin')
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32')
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return process.env.CHROME_PATH || '/usr/bin/google-chrome';
}
async function loggedIn(context) {
  return (await context.cookies('https://weibo.com')).some(
    (cookie) => cookie.name === 'SUB' && cookie.value.length > 20,
  );
}

async function main() {
  if (has('--help')) {
    usage();
    return;
  }
  const settings = await config();
  const dataDirectory = toPath(settings.dataDir);
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(join(dataDirectory, 'media'), { recursive: true });
  const logger = await createLogger(settings);
  const runStarted = Date.now();
  await logger.log('run_started', {
    fromPage: argument('--from-page', '1'),
    pages: argument('--pages', '1'),
    limit: argument('--limit', String(settings.batchSize)),
    headless:
      !has('--login') && !has('--headed') && settings.headless !== false,
  });
  console.log(`日志：${logger.path}`);
  const headless =
    !has('--login') && !has('--headed') && settings.headless !== false;
  const context = await chromium.launchPersistentContext(
    toPath(settings.browserProfileDir),
    {
      executablePath: await chromeExecutable(),
      headless,
      viewport: { width: 1280, height: 900 },
    },
  );
  const page = context.pages()[0] || (await context.newPage());
  try {
    if (has('--login')) {
      await page.goto('https://weibo.com/login.php', {
        waitUntil: 'domcontentloaded',
      });
      console.log(
        '请在打开的专用 Chrome 窗口完成微博登录；脚本只等待本地 SUB 会话，不会读取或导出它。',
      );
      const deadline = Date.now() + 15 * 60 * 1000;
      while (!(await loggedIn(context))) {
        if (Date.now() > deadline)
          throw new Error('15 分钟内未检测到登录，会话未保存');
        await pause(1000);
      }
      console.log('登录会话已保存到本地专用配置目录。现在可以运行采集命令。');
      return;
    }
    if (!(await loggedIn(context)))
      throw new Error(
        '专用采集浏览器尚未登录。请先运行：node weibo_capture.mjs --login',
      );
    await api(settings.libraryUrl, '/api/posts?page=1&pageSize=10');
    const fromPage = Number(argument('--from-page', '1'));
    const pages = Number(argument('--pages', '1'));
    const limit = Number(argument('--limit', String(settings.batchSize)));
    const directUrl = argument('--url', '');
    const urls = [];
    if (directUrl) urls.push(directUrl);
    if (has('--resume')) {
      const queued = await api(
        settings.libraryUrl,
        `/api/jobs?state=queued&limit=${limit}`,
      );
      urls.push(...queued.jobs.map((job) => job.sourceUrl));
    }
    for (
      let index = 0;
      !directUrl && index < pages && urls.length < limit;
      index += 1
    ) {
      const favoritePage = fromPage + index;
      await page.goto(
        settings.favoritesUrl.replace('{page}', String(favoritePage)),
        { waitUntil: 'domcontentloaded' },
      );
      const discovered = await favoritesOnPage(page);
      const queued = await api(settings.libraryUrl, '/api/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ favoritePage, urls: discovered }),
      });
      urls.push(...queued.captureUrls);
      await logger.log('favorites_discovered', {
        favoritePage,
        count: discovered.length,
        queuedCount: queued.captureUrls.length,
      });
      console.log(
        `收藏页 ${favoritePage}：发现 ${discovered.length} 条，待采集 ${queued.captureUrls.length} 条。`,
      );
      if (index < pages - 1 && urls.length < limit) {
        const delayMs = jitter(settings);
        await logger.log('favorites_page_pause', { favoritePage, delayMs });
        await pause(delayMs);
      }
    }
    const queue = [...new Set(urls)].slice(0, limit);
    let captured = 0;
    let failures = 0;
    for (const [index, url] of queue.entries()) {
      const itemStarted = Date.now();
      await logger.log('post_started', {
        position: index + 1,
        total: queue.length,
        sourceUrl: url,
      });
      try {
        const result = await captureOne(page, context, settings, url, logger);
        captured += 1;
        failures = 0;
        await logger.log('post_captured', {
          position: index + 1,
          id: result.id,
          sourceUrl: url,
          mediaCount: result.media,
          durationMs: Date.now() - itemStarted,
        });
        console.log(`已保存 ${result.id}（${result.media} 个媒体）`);
      } catch (error) {
        failures += 1;
        await markJob(
          settings,
          url,
          error.deleted ? 'skipped_deleted' : 'failed',
          String(error.message || error),
        );
        await logger.log(
          error.deleted ? 'post_skipped_deleted' : 'post_failed',
          {
            position: index + 1,
            sourceUrl: url,
            durationMs: Date.now() - itemStarted,
            error: String(error.message || error),
          },
        );
        console.error(`未保存 ${url}：${error.message || error}`);
        if (failures >= settings.maxConsecutiveFailures)
          throw new Error(`连续 ${failures} 条失败，已停止以保护账号会话`);
      }
      if (index < queue.length - 1) {
        if (captured && captured % settings.batchSize === 0) {
          console.log(`批次完成，休息 ${settings.batchPauseMs / 1000} 秒。`);
          await logger.log('batch_pause', {
            durationMs: settings.batchPauseMs,
            captured,
          });
          await pause(settings.batchPauseMs);
        } else await pause(jitter(settings));
      }
    }
    await logger.log('run_finished', {
      captured,
      total: queue.length,
      durationMs: Date.now() - runStarted,
    });
    console.log(`完成：本轮成功 ${captured}/${queue.length} 条。`);
  } catch (error) {
    await logger.log('run_failed', {
      durationMs: Date.now() - runStarted,
      error: String(error.message || error),
    });
    throw error;
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`采集终止：${error.message || error}`);
  process.exitCode = 1;
});
