# WeiboFav Offline

将**自己账号的微博收藏**保存为本地 SQLite 数据库与媒体文件，并在本机以时间流浏览、搜索、筛选和删除。转发微博会保留转发正文与可访问的原微博正文；图片保存原图，视频只保存缩略图，不保存视频文件。

> 仅用于导出和整理你有权访问的内容。请遵守微博的服务条款、访问频率限制及所在地法律；不要将本工具用于批量收集他人受限内容或绕过访问控制。

## 特性

- 无头脚本解析“我的收藏”，不会混入首页推流；已删除微博自动跳过。
- 转发微博分别保存转发内容与原微博正文、作者、媒体和原帖链接。
- 下载图片原图；视频仅下载可验证的封面/缩略图。
- SQLite 元数据、媒体、日志和专用 Chrome 登录档案均在可配置的本地数据目录中，与代码仓库分离且被 Git 忽略。
- 本地浏览器支持按时间分页、页码快速跳转、全文检索、媒体筛选、粘性批量删除栏、回到顶部/底部与大图预览；滚轮浏览长图，双指捏合或 `Ctrl + 滚轮` 缩放。
- 采集具有随机节流、失败重试、连续失败保护、断点续跑、磁盘空间保留和 NDJSON 运行日志。

## 环境要求

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Python 3.10 或更高版本（只使用标准库）
- 已安装的 Google Chrome

## 安装与启动

```bash
git clone https://github.com/deep-river/WeiboFav-Offline.git
cd WeiboFav-Offline
pnpm install
./scripts/start-mac.command
```

启动脚本会分别启动页面服务与仅供本机访问的 API/媒体服务；命令行打印并自动打开的地址才是离线库页面地址。不要直接访问内部 API 端口。

### 一键启动与停止

首次使用前请安装 Node.js、pnpm 和 Python 3。之后可双击或在终端执行以下脚本；启动脚本会在需要时安装依赖、构建页面，并从 `4319` 开始自动寻找可用端口（例如 `4319` 被占用时改用 `4320`）。完成后会在命令行显示实际地址并自动打开浏览器。停止脚本只会终止由该项目启动且记录在 PID 文件中的服务。

在运行 Codex desktop 的 macOS 机器上，若尚未安装 Node.js/pnpm，启动脚本会临时使用 Codex 自带的本地运行时并提示你安装正式依赖；这只是当前机器的便利回退，不会随项目部署到其他设备。要完全独立使用，请安装 Node.js 22+，然后运行 `corepack enable && corepack prepare pnpm@latest --activate`。

```bash
# macOS
./scripts/start-mac.command
./scripts/stop-mac.command

# Windows（在资源管理器中双击，或在 cmd 中运行）
scripts\start-windows.cmd
scripts\stop-windows.cmd
```

## 第一次采集

另开一个终端，复制并按需调整配置：

```bash
cp capture.config.example.json capture.config.json
pnpm capture -- --login
```

首次命令会打开脚本专用 Chrome 窗口。请在这个窗口登录微博；会话只保存在本机的专用配置目录，脚本不会读取、打印或导出 Cookie。登录成功后可关闭窗口。

```bash
# 采集收藏夹第 1 页，默认最多 20 条
pnpm capture -- --from-page 1 --pages 1

# 从失败前留下的队列继续（不会在常规增量扫描中自动重试）
pnpm capture -- --resume --limit 20

# 仅追加线上新增收藏；连续 3 页没有新 URL 后停止
pnpm capture -- --incremental
```

采集服务必须正在运行；日志会写入 `<dataDir>/logs/`，每行一个 JSON 事件，包含发现页、单条耗时、重试、跳过和失败原因。

## 让数据完全放在仓库外

默认数据目录是项目内的 `data/`，但它始终被 Git 忽略。若希望代码仓库与收藏内容彻底分开，为服务和采集器使用同一个外部路径：

```bash
export WEIBOFAV_DATA_DIR="$HOME/WeiboFav-data"
pnpm library

# 新终端中使用相同的变量
export WEIBOFAV_DATA_DIR="$HOME/WeiboFav-data"
pnpm capture -- --login
```

也可以把 `dataDir` 写入未提交的 `capture.config.json`；此时启动服务时仍应设置相同的 `WEIBOFAV_DATA_DIR`。在数据目录中会创建：

```text
library.sqlite3                 # 收藏正文、队列与媒体清单
media/<微博ID>/                 # 原图和视频缩略图
logs/capture-*.ndjson           # 采集运行日志
capture-browser-profile/        # 专用 Chrome 登录档案
```

请把整个数据目录纳入你自己的备份策略；不要将其推送到 GitHub，因为其中可能包含登录会话和受版权保护的媒体。

## 采集策略与增量更新

默认配置以 3.5–6 秒随机间隔请求正文，并在每 20 条后暂停 90 秒。可在 `capture.config.json` 调整批次、间隔、媒体并发和剩余磁盘空间下限。脚本每次先登记收藏页链接，再按微博 URL 去重；已归档的 URL 不会再次写入。

当收藏夹发生变化时，运行 `pnpm capture -- --incremental`。它从第 1 页开始扫描，连续 3 页没有新 URL 后停止（可用 `--known-pages` 调整，默认最多扫描 100 页）。已归档 URL 不会覆盖；在页面中删除的内容会留下本地删除标记，即使它仍在线上收藏夹中也不会重新导入。线上取消收藏不会删除本地备份。更完整的策略见 [CAPTURE_STRATEGY.md](CAPTURE_STRATEGY.md)。

## 数据安全边界

- 下载前检查可用磁盘空间，默认保留 10 GB 或总空间的 10%（取较大者）。
- 媒体先下载到临时文件，验证图片类型、尺寸与 SHA-256 后才写入数据库清单。
- 页面仅监听 `127.0.0.1`，不暴露给局域网。
- 评论、视频文件和已删除正文不保存。

## 开发

```bash
pnpm dev              # 前端开发服务，需另行运行 pnpm library 作为 API 服务
pnpm lint
pnpm format
pnpm build
```

许可证：[MIT](LICENSE)。
