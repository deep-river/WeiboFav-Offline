'use client';

import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import {
  Archive,
  ChevronsDown,
  ChevronsUp,
  Check,
  ExternalLink,
  Film,
  ImageIcon,
  Minus,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';

type Media = {
  id: string;
  kind: 'image' | 'video-thumbnail';
  localUrl: string;
  originalUrl: string;
  bytes: number;
};
type Post = {
  id: string;
  author: string;
  publishedAt: string;
  sourceUrl: string;
  originalUrl?: string;
  source: string;
  text: string;
  repostText?: string;
  repostAuthor?: string;
  media: Media[];
  capturedAt: string;
};
type ApiResponse = {
  posts: Post[];
  page: number;
  pageSize: number;
  total: number;
  stats: { mediaBytes: number; freeBytes: number };
};
const filters = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '含图片' },
  { id: 'video', label: '视频缩略图' },
];
const libraryOrigin = (
  process.env.NEXT_PUBLIC_WEIBOFAV_LIBRARY_URL || ''
).replace(/\/$/, '');
function libraryUrl(path: string) {
  return libraryOrigin ? `${libraryOrigin}${path}` : path;
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function displayDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
function renderMentions(value: string) {
  const pieces: Array<string | ReactElement> = [];
  const pattern = /@([^\s@:：]+)(?=[:：])/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) pieces.push(value.slice(cursor, match.index));
    pieces.push(
      <span
        key={`${match.index}-${match[1]}`}
        className="font-medium text-[#1e6b5d]"
      >
        @{match[1]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) pieces.push(value.slice(cursor));
  return pieces;
}

function paginationPages(current: number, total: number) {
  const pages = new Set([1, total]);
  for (let target = current - 2; target <= current + 2; target += 1) {
    if (target >= 1 && target <= total) pages.add(target);
  }
  return [...pages].sort((left, right) => left - right);
}

export default function Home() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [stats, setStats] = useState<ApiResponse['stats']>({
    mediaBytes: 0,
    freeBytes: 0,
  });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [viewer, setViewer] = useState<Media | null>(null);
  const [zoom, setZoom] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const parameters = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        media: filter,
        q: query.trim(),
      });
      const response = await fetch(libraryUrl(`/api/posts?${parameters}`), {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('无法读取离线库');
      const data = (await response.json()) as ApiResponse;
      setPosts(data.posts);
      setStats(data.stats);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [filter, page, query]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!viewer) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setViewer(null);
        setZoom(1);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [viewer]);

  const visiblePosts = posts;
  const pageCount = Math.max(1, Math.ceil(total / 20));
  const nearbyPages = paginationPages(page, pageCount);
  const selectedVisible = visiblePosts.filter((post) =>
    selected.includes(post.id),
  );
  const allVisibleSelected =
    visiblePosts.length > 0 && selectedVisible.length === visiblePosts.length;
  const togglePost = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((entry) => entry !== id),
    );
  const toggleAll = (checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...new Set([...current, ...visiblePosts.map((post) => post.id)])]
        : current.filter((id) => !visiblePosts.some((post) => post.id === id)),
    );
  const goToPage = (nextPage: number) => {
    const target = Math.max(1, Math.min(pageCount, nextPage));
    if (target === page) return;
    setPage(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const deleteSelected = async () => {
    setDeleting(true);
    try {
      const response = await fetch(libraryUrl('/api/delete'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: selected }),
      });
      if (!response.ok) throw new Error('删除失败');
      setSelected([]);
      await load();
    } finally {
      setDeleting(false);
    }
  };
  const closeViewer = () => {
    setViewer(null);
    setZoom(1);
  };
  const openViewer = (media: Media) => {
    setViewer(media);
    setZoom(1);
  };
  const changeZoom = (amount: number) =>
    setZoom((current) =>
      Math.min(4, Math.max(0.5, Number((current + amount).toFixed(2)))),
    );

  const renderPost = (post: Post) => (
    <li
      key={post.id}
      className="relative grid gap-3 pl-11 sm:grid-cols-[34px_1fr] sm:pl-0"
    >
      <div className="relative z-10 flex justify-center pt-5">
        <Checkbox
          checked={selected.includes(post.id)}
          onCheckedChange={(checked) => togglePost(post.id, checked === true)}
          aria-label={`选择 ${post.author} 的微博`}
          className="size-5 border-[#80a99d] bg-[#f6f6f2]"
        />
      </div>
      <article className="overflow-hidden rounded-2xl border border-[#d9e4df] bg-white shadow-[0_8px_22px_rgba(31,68,57,.05)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf1ef] px-5 py-3 text-sm">
          <div>
            <span className="font-semibold text-[#254d45]">@{post.author}</span>
            <span className="mx-2 text-[#bdc7c4]">·</span>
            <time className="text-[#657370]">
              {displayDate(post.publishedAt)}
            </time>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a
              href={post.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[#1e6b5d] hover:underline"
            >
              打开收藏微博{' '}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            {post.originalUrl && post.originalUrl !== post.sourceUrl && (
              <a
                href={post.originalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[#1e6b5d] hover:underline"
              >
                打开嵌套原帖{' '}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        <div className="p-5">
          <div className="space-y-4">
            {post.text && (
              <p className="whitespace-pre-wrap text-[1.05rem] leading-8 text-[#233432]">
                {renderMentions(post.text)}
              </p>
            )}
            {post.repostText && (
              <section className="rounded-xl border border-[#cbd9d4] bg-[#f8fbf9] p-4">
                <p className="mb-2 font-bold text-[#233432]">
                  @{post.repostAuthor || '未知作者'}
                </p>
                <p className="whitespace-pre-wrap text-[1.05rem] leading-8 text-[#233432]">
                  {renderMentions(post.repostText)}
                </p>
              </section>
            )}
          </div>
          {post.media.length > 0 && (
            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              {post.media.map((media) => (
                <button
                  key={media.id}
                  type="button"
                  onClick={() => openViewer(media)}
                  className="group relative overflow-hidden rounded-xl bg-[#e8eeeb] text-left outline-none focus-visible:ring-3 focus-visible:ring-[#3a8575]"
                  aria-label={`查看${media.kind === 'image' ? '原图' : '视频缩略图'}`}
                >
                  <img
                    src={libraryUrl(media.localUrl)}
                    alt={
                      media.kind === 'video-thumbnail'
                        ? '视频缩略图'
                        : '微博已保存原图'
                    }
                    className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                  />
                  {media.kind === 'video-thumbnail' && (
                    <span className="absolute inset-0 grid place-items-center bg-black/20">
                      <Film
                        className="size-9 text-white drop-shadow"
                        aria-hidden="true"
                      />
                    </span>
                  )}
                  <span className="absolute bottom-0 left-0 right-0 flex items-center gap-1 bg-[#163c35]/80 px-2 py-1.5 text-xs text-white">
                    <ImageIcon className="size-3" aria-hidden="true" />
                    {media.kind === 'image' ? '原图' : '视频缩略图'} ·{' '}
                    {formatBytes(media.bytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1 px-1 text-xs text-[#85938e]">
              <Check className="size-3.5 text-[#3c907a]" aria-hidden="true" />
              采集于 {displayDate(post.capturedAt)}
            </span>
          </div>
        </div>
      </article>
    </li>
  );

  return (
    <>
      <main className="min-h-screen bg-[#f6f6f2] text-[#1d2a2a]">
        <header className="border-b border-[#dae2df] bg-[#fbfcf8]/95 px-5 py-4 backdrop-blur sm:px-9">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-[#1e6b5d] text-[#eef6ef] shadow-sm">
                <Archive className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h1 className="font-serif text-xl font-semibold tracking-tight">
                  微博收藏·离线库
                </h1>
                <p className="text-sm text-[#657370]">
                  仅保存正文、原帖链接与指定媒体
                </p>
              </div>
            </div>
            <Badge
              variant="outline"
              className="hidden border-[#bfd0ca] bg-[#eef4ef] px-3 py-1 text-[#386057] sm:inline-flex"
            >
              已验证采集
            </Badge>
          </div>
        </header>
        <section className="mx-auto max-w-6xl px-5 py-7 sm:px-9">
          <div className="mb-7 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <p className="eyebrow">时间流</p>
              <h2 className="mt-1 font-serif text-3xl font-semibold tracking-tight">
                按原微博发布时间浏览
              </h2>
            </div>
            <p className="text-sm text-[#657370]">
              {total.toLocaleString()} 条 · 媒体 {formatBytes(stats.mediaBytes)}{' '}
              · 可用 {stats.freeBytes ? formatBytes(stats.freeBytes) : '读取中'}
            </p>
          </div>
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-[#dbe4e0] bg-white p-3 shadow-[0_8px_24px_rgba(32,61,54,.05)] sm:flex-row sm:items-center">
            <label className="relative flex flex-1 items-center">
              <Search
                className="pointer-events-none absolute left-3 size-4 text-[#71817d]"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                className="h-10 w-full rounded-xl border border-[#d8e2de] bg-[#fbfcf9] pl-9 pr-3 text-base outline-none placeholder:text-[#87938f] focus:border-[#3a8575] focus:ring-3 focus:ring-[#8cc7bb]/25"
                placeholder="搜索正文或作者"
              />
            </label>
            <div className="flex gap-1 overflow-x-auto" aria-label="媒体筛选">
              {filters.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setFilter(entry.id);
                    setPage(1);
                  }}
                  className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition ${filter === entry.id ? 'bg-[#1e6b5d] text-white' : 'text-[#53645f] hover:bg-[#edf3ef]'}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          <div className="sticky top-3 z-20 mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe4e0] bg-[#fbfcf8]/95 px-3 py-2 text-sm shadow-sm backdrop-blur">
            <label className="flex cursor-pointer items-center gap-2 text-[#53645f]">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(checked) => toggleAll(checked === true)}
                aria-label="选择当前筛选结果"
              />
              选择当前 {visiblePosts.length} 条
            </label>
            {selected.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#8f3634] px-3 text-sm font-medium text-white hover:bg-[#782c2a]">
                  <Trash2 className="size-4" aria-hidden="true" />
                  删除 {selected.length} 条
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      永久删除 {selected.length} 条收藏？
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      会同时删除这些记录及其已下载的原图或视频缩略图，无法恢复。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => void deleteSelected()}
                      className="bg-[#8f3634] hover:bg-[#782c2a]"
                      disabled={deleting}
                    >
                      {deleting ? '正在删除…' : '永久删除'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
          {loading ? (
            <p className="rounded-2xl border border-dashed border-[#c8d5d0] p-10 text-center text-[#657370]">
              正在读取离线库…
            </p>
          ) : visiblePosts.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-[#c8d5d0] p-10 text-center text-[#657370]">
              没有符合条件的保存内容。
            </p>
          ) : (
            <>
              <ol className="relative space-y-5 before:absolute before:bottom-0 before:left-[18px] before:top-4 before:w-px before:bg-[#cfe0d9] sm:before:left-[23px]">
                {visiblePosts.map(renderPost)}
              </ol>
              <Pagination className="mt-8">
                <PaginationContent className="max-w-full overflow-x-auto px-1">
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      text="上一页"
                      aria-disabled={page === 1}
                      onClick={(event) => {
                        event.preventDefault();
                        goToPage(page - 1);
                      }}
                    />
                  </PaginationItem>
                  {nearbyPages.map((target, index) => (
                    <Fragment key={target}>
                      {index > 0 && target - nearbyPages[index - 1] > 1 && (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      )}
                      <PaginationItem>
                        <PaginationLink
                          href={`#page-${target}`}
                          isActive={target === page}
                          size="default"
                          onClick={(event) => {
                            event.preventDefault();
                            goToPage(target);
                          }}
                        >
                          {target}
                        </PaginationLink>
                      </PaginationItem>
                    </Fragment>
                  ))}
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      text="下一页"
                      aria-disabled={page === pageCount}
                      onClick={(event) => {
                        event.preventDefault();
                        goToPage(page + 1);
                      }}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </>
          )}
        </section>
      </main>
      <div className="fixed bottom-5 right-5 z-30 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="grid size-10 place-items-center rounded-xl border border-[#c9d8d2] bg-white/95 text-[#35665b] shadow-lg backdrop-blur transition hover:bg-[#edf4ef] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#8cc7bb]"
          aria-label="快速回到页面顶部"
          title="回到顶部"
        >
          <ChevronsUp className="size-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() =>
            window.scrollTo({
              top: document.documentElement.scrollHeight,
              behavior: 'smooth',
            })
          }
          className="grid size-10 place-items-center rounded-xl border border-[#c9d8d2] bg-white/95 text-[#35665b] shadow-lg backdrop-blur transition hover:bg-[#edf4ef] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[#8cc7bb]"
          aria-label="快速前往页面底部"
          title="前往底部"
        >
          <ChevronsDown className="size-5" aria-hidden="true" />
        </button>
      </div>
      <Dialog
        open={viewer !== null}
        onOpenChange={(open) => {
          if (!open) closeViewer();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[min(96vw,1120px)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden border-[#39504a] bg-[#16201e] p-0 text-white shadow-2xl sm:max-w-[min(96vw,1120px)]"
        >
          <DialogTitle className="sr-only">图片查看器</DialogTitle>
          <div className="flex items-center justify-between border-b border-white/15 px-3 py-2 text-sm">
            <span>
              {viewer?.kind === 'video-thumbnail' ? '视频缩略图' : '原图'} ·{' '}
              {zoom * 100}%
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => changeZoom(-0.25)}
                className="grid size-9 place-items-center rounded-lg hover:bg-white/10"
                aria-label="缩小图片"
              >
                <Minus className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => changeZoom(0.25)}
                className="grid size-9 place-items-center rounded-lg hover:bg-white/10"
                aria-label="放大图片"
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                onClick={closeViewer}
                className="ml-1 grid size-9 place-items-center rounded-lg hover:bg-white/10"
                aria-label="关闭大图"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>
          <div
            className="h-[min(76vh,820px)] overflow-auto bg-black/60 p-5"
            aria-label="大图浏览区域"
            onWheel={(event) => {
              if (!event.ctrlKey) return;
              event.preventDefault();
              changeZoom(event.deltaY < 0 ? 0.2 : -0.2);
            }}
          >
            <img
              src={viewer ? libraryUrl(viewer.localUrl) : undefined}
              alt={
                viewer?.kind === 'video-thumbnail'
                  ? '放大的视频缩略图'
                  : '放大的原图'
              }
              className="mx-auto block h-auto max-w-none select-none rounded-sm shadow-2xl"
              style={{ width: `${zoom * 100}%` }}
            />
          </div>
          <div className="border-t border-white/15 px-4 py-2 text-center text-xs text-white/70">
            滚轮上下浏览 · 双指捏合或 Ctrl + 滚轮缩放 · Esc 关闭
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
