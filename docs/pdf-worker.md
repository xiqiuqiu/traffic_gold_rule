# PDF 后台任务运行说明

工作台使用 Node.js、独立 LangGraph worker 和 PostgreSQL 16。浏览器上传和每日扫盘调用同一入库函数。服务端按完整 SHA-256 保存 PDF 原件。文档来源、任务、模型配置版本、分页文本、机器草稿以及图检查点均可在进程重启后恢复。

## 本机启动

使用 Node.js 24 与支持仓库锁文件的 Bun 1.4。首次安装运行 `bun install --frozen-lockfile`。首次配置可从 `.env.example` 复制到 `.env`，将两个示例密码替换为同一个随机十六进制值。已有环境沿用原配置。PostgreSQL 的数据卷在第一次启动时初始化密码。

```sh
docker compose up -d --wait
```

本机的 `tsi-ocr` 已有 `tsi-paddleocr` 镜像和 PaddleOCR 3.7.0 的 PP-OCRv6 medium 检测、识别权重。首次为工作台准备模型时，从该容器复制这两个目录。然后启动工作台专用的行框接口。

```sh
mkdir -p .local-data/paddle-ocr-models
docker cp tsi-ocr:/root/.paddlex/official_models/PP-OCRv6_medium_det .local-data/paddle-ocr-models/
docker cp tsi-ocr:/root/.paddlex/official_models/PP-OCRv6_medium_rec .local-data/paddle-ocr-models/
docker compose up -d --wait ocr
```

原有文本 OCR 接口继续使用 8866。worker 默认调用 `http://127.0.0.1:8867/v1/ocr/lines`，每次 POST 一张 `image/png`。部署在其他地址时，用 `PADDLE_OCR_URL` 指定相同接口。未配置 OCR 服务也可以运行有可靠文本层的材料；扫描页的识别错误会带原始页码进入队列重试或失败状态。

在项目根目录开两个终端，各运行一个服务。Web 和 worker 必须指向同一个 `DATABASE_URL` 和 `PDF_STORAGE_DIR`。

| 进程 | 命令 | 本机用途 |
|---|---|---|
| 工作台 | `bun run dev` | 打开 [工作台](http://localhost:3011)，接收上传、按本机时间定时扫盘、查询任务 |
| 后台处理 | `bun run worker` | 从 PostgreSQL 领取任务，读取原件并调用选定模型，写入草稿 |

本机示例数据库监听 `127.0.0.1:55432`，原件目录默认为 `.local-data/pdf-originals`。管理模型的演示身份可在“权限与设置”保存服务端配置。首次从原来使用的浏览器地址打开工作台时，该身份已有的有效配置可自动迁移。模型 Key 留在服务端，数据库备份也应作为含凭据的数据保管。

## 验证流程

1. 上传一份 PDF 并选“暂存待命”，从任务详情查看原件。点击开始后可以关闭浏览器。再次访问任务列表可查看进度和待复核草稿。
2. 把相同文件复制到扫描目录，执行普通扫盘。去重按文件内容，同名新版会生成新任务，改名副本复用原件。强制重扫用于显式创建新任务。单个文件上限为 64 MiB。上游写入方应先写临时文件，再将完整文件原子重命名成 PDF。
3. 调度器按服务器本地时间检查每日计划，工作台在当日计划时间后启动时可补扫。批次摘要显示新增、重复和文件错误。文件是否立即执行由“自动执行”选项决定。
4. worker 每进程同时处理一份。需要并行时可以启动多个独立 worker，所有 worker 使用相同的 `WORKER_MAX_CONCURRENT`（默认 2）。租约为 60 秒，每 15 秒续租；进程异常退出后可接管同一次解析。自动尝试最多三次，手动重试使用当时保存的模型配置创建一次新运行。

用项目专用测试库可执行 `node --import tsx --test src/server/*.test.ts src/utils/*.test.ts`。设置 `PDF_QUEUE_TEST_DATABASE_URL` 后队列测试会创建和清理独立 schema。设置 `PDF_WORKER_DB_TEST=1` 后恢复测试使用 `DATABASE_URL` 创建和清理临时数据库，需要相应权限。

## 分页处理与证据查询

- worker 使用 `@firecrawl/pdf-inspector` 逐页取文，从带位置的原生文字生成行。文字不可靠或整页扫描底图只有零星页眉时，渲染原页交给本机 PaddleOCR；已确认全白的页记录为 `blank`。识别不到文字的非空白页会阻止该份文档交付完整草稿。
- `pdf_pages` 使用完整 SHA-256、提取版本和 **1 起始原始页码** 唯一标识一页。原生取文与 OCR 都记录可见页的尺寸（pt）和旋转。OCR 页还记录源 PNG 的像素尺寸、引擎和分流原因。
- `pdf_page_lines` 的 `(page_id, line_number)` 标识原文行。`bbox` 是可见页左上角为原点的 `[左, 上, 右, 下]`（0～1）；`raw_box` 在原生页使用可见页 pt，在 OCR 页使用源 PNG 像素。识别行附带置信度。服务关闭文档纠偏，返回框对应上传图像。
- 一页及其全部行在同一事务提交。跨进程共用一个 OCR 并发槽，相同原件、相同提取版本的已成功页可以复用。当前运行完成取文后，`pdf_run_artifacts` 的 `text` 产物保存 `extractionVersion`，模型使用按原始页码合并的文本。旧任务继续展示当时的草稿；显式创建新运行可获得新页证据。

在工作台 PostgreSQL 数据库执行下面的查询，将 `$1` 和 `$2` 绑定为任务编号和原始页码，即可核对该运行实际使用的行与位置。

```sql
SELECT p.page_number, p.source, p.render_width, p.render_height,
       l.line_number, l.line_text, l.bbox, l.raw_box, l.confidence
FROM pdf_tasks t
JOIN pdf_run_artifacts a ON a.run_id = t.run_id AND a.kind = 'text'
JOIN pdf_pages p ON p.sha256 = t.sha256
                AND p.extraction_version = a.body->>'extractionVersion'
LEFT JOIN pdf_page_lines l ON l.page_id = p.id
WHERE t.id = $1 AND p.page_number = $2
ORDER BY l.line_number;
```

## 引用原文定位

worker 给模型的每一行都带有 PostgreSQL 的行标识。责任结论按主体和事故阶段分别提取，全案责任使用空事件。程序对照该次运行的原件哈希和取文版本，核对引用的页、行、主体、阶段与等级。核验结果随运行草稿保存，两个 JSON 导出格式的 `source_location` 也使用同一组已核验的位置。

在案件详情中，点击具体摘录旁的页码（可编辑页码旁为「定位」），或点击证据链清单里的摘录，阅读器会打开原页并高亮对应行。普通字段、违法、认定原因、责任和事件关系共用这个入口。同一记录有多条引用时，各条独立定位。普通引文在指定页内按行号或唯一文本匹配；找不到唯一位置时仅打开引用页，并提示人工核对。

责任引用还须核对主体、责任等级和事故阶段。修改记录后，再点对应引用即可重新核对。有分页解析结果的后台任务使用该次运行保存的行框；历史案件的文本页也可从当前打开的原件取行。扫描页需要已保存的 OCR 行框。

## 数据边界

后台初稿使用项目内置的字段和词表。人工修订、自定义词表和历史案件继续沿用原工作台的浏览器存储。备份时应配套保留原件目录、PostgreSQL 数据、原有系统状态及浏览器中的人工修订。当前测试身份入口适用于本机工作台。

## 本机验收记录

- 用项目的两页 PDF 验证浏览器上传待命、手动开始、定时器扫盘、原件逐字节下载和生成草稿。两条入口相遇时按内容去重。此组使用本机模拟模型，以保证流程测试可重复。
- 用一页虚构事故材料单独调用 3425 上的 `group/ds4.1`，worker 生成 25 项字段及法律结论草稿，包括测试甲承担全部责任、测试乙无责任。
- 用 1,000 份内容不同的小型合成 PDF 测量入库。首轮生成 1,000 条待命任务，用时 29.9 秒；复扫 6.7 秒，新增 0 条。此项只计文件持久化与队列入库。
- 在模型请求期间强制结束 worker，模拟租约到期及一次限流。重启后复用原运行的分页文本并交付草稿。

- 第二阶段用同一组混合样本走完整 worker，在隔离 PostgreSQL 中查询实际落库数据，并用本机测试模型核对输入页码。CASE-08 和 CASE-13 均只有第 2 页请求真实 PaddleOCR。两份责任段落合计 9 行逐行命中，按 1191 × 1684 参考图像换算，最大竖直中心偏差 3.8 像素。5 份原生 PDF 共 10 页的 OCR 调用数为 0；60 页混合样本只有第 35 页请求 OCR。
- OCR 临时失败的回归测试中，第 3 页失败前已写入前两页，重启后只重试第 3 页，随后成功写入第 4 页的空白标记。真实歪斜、印章遮挡材料和每日高峰批次耗时仍需独立验证。

- 第三阶段沿用第二阶段两份混合 PDF 的原件和 PostgreSQL 行框，用本机 3425 的 `group/ds4.1` 重新生成草稿。在浏览器逐条定位 6 条责任，均落在扫描的第 2 页。CASE-08 中周伟杰为第 2 行，王小明的姓名横跨第 2–3 行；放大后两行框仍与原页对齐。CASE-13 中三阶段的全部责任依次落在第 4–5、8–9、12–13 行，孙丽敏的全案无责任落在第 15 行。人工把无责引文改为错误的第三阶段全责后，重核进入待核对状态；恢复正确引文可重新定位。
