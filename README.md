# 电商数据采集平台（ecom-data-hub）

可扩展的电商平台数据采集与展示平台。**官方 API 优先 → 可插拔爬虫回退 → 商品详情页评论/问答/SPU-SKU 一并采回**。

## 核心能力

- **官方 API 优先架构**：淘宝/天猫已接入淘宝开放平台（TOP）真实调用——系统设置页填 AppKey/AppSecret（可选卖家 Session）即生效，工作台策略 auto 自动优先官方、失败回退爬取；其余平台预置官方适配器位（京东宙斯 / 拼多多开放平台 / 亚马逊 SP-API 可按同构扩展）。
- **真实爬取引擎**：`GenericScrapeAdapter` 是**可运行的真实实现**——UA 轮换 + 请求间随机延迟 + 失败指数退避重试 + 可选代理；引擎优先 Playwright（JS 重度渲染站点必需），降级原生 `fetch`。
- **通用启发式解析**：浏览器渲染后，直接在页面内扫描「商品图 + 链接 + 价格」三要素抽取，**无需逐个站点校准选择器**即可对绝大多数电商列表页抽到标题/链接/图片；另有 CSS 类选择器与 JSON-LD 兜底。
- **商品 + 详情页评论 + 公开问答一起采**：勾选「带详情」后，自动跟进 Top-N 商品详情页，一并抓取**评论**与**公开问答（问大家/买家问答）**，全部落库关联。
- **SQLite 数据库存储**：用 Node 内置 `node:sqlite` 取代旧版 JSON 文件，支持 SQL 查询 / 索引 / 定时任务与运行记录。旧 `store.json` 首次启动自动迁移。
- **存储后端可切换（SQLite / 本地 MongoDB）**：通过 `STORE_BACKEND` 环境变量在嵌入式 SQLite 与本地 MongoDB 文档数据库之间切换，业务代码零改动（统一 `server/storage.js` 门面）。
- **存储管理（查看位置 + 清理）**：仪表盘与 API 可随时查看数据目录、数据库文件、各目录大小与记录数；支持按类型/平台/关键字范围**安全清理**（弹框列出将删除的数据明细，二次确认）。「数据管理」页与「存储管理」共用同一清理弹框。
- **请求指纹随机化（端型可选）**：从**固定真实设备池**抽取完整档案（UA ↔ 平台 ↔ 视口 ↔ 语言 ↔ Client Hints 严格同源，12 套），支持按端型筛选——**混合端 / 仅桌面端（7 套）/ 仅手机端含平板（5 套）**，系统设置页切换保存即生效；每次请求还随机生成出口 IP（伪造 X-Forwarded-For）并配合代理池轮换。
- **代理池自动轮换**：从 `data/proxies.txt` 或 `CRAWL_PROXY_POOL` 载入代理，轮询分配，按健康度自动剔除/冷却，请求失败自动切下一个。
- **定时采集**：任务存于数据库，按周期自动运行并写运行记录；仪表盘可增删/手动触发。
- **爬虫运行时设置**：随机延迟区间 / 超时 / 重试 / 渲染等待 / Playwright 开关 / 指纹随机化开关，仪表盘修改后**立即对后续每次调用生效**，持久化到 `data/settings.json`。重试等待同样按设置的延迟档位随机停顿（日志会显示「重试等待 Xs」），不再使用硬编码退避。
- **字段提取诊断**：在线 URL 诊断在「一键测试」弹框内（每步结果旁「🔬字段诊断」）；离线诊断把目标页另存为 HTML 后在仪表盘直接**选文件上传**（或高级模式填服务器路径），逐字段报告命中数与样例（`--verify` 的可视化版）。
- **Cookie 提取小工具**：`tools/cookie-tool.js` 弹出真实浏览器，登录后回车即导出登录态到 `data/cookies/<平台>.json`，采集时自动注入（绕过登录墙）。
- **CSV / JSON 导出**：所有数据类型均支持 CSV 与 JSON 两种格式，一键下载到本地。
- **开箱即用**：`npm install` 自动安装 Playwright 无头浏览器（`postinstall` + 启动自检）。

## 快速开始

```bash
cd sites-lab/ecom-crawler
npm install                 # 安装依赖并自动下载无头浏览器（仅一次）
npm start                  # 启动服务 → http://localhost:4311
# CLI 采集（mock 模式，无需任何密钥）
npm run collect -- --platform taobao --type product --query 手机 --strategy mock
```

打开 http://localhost:4311 即可在仪表盘运行采集、一键测试、浏览数据、管理定时任务、导出数据。

> 爬取**默认开启**，无需任何环境变量。若想关闭再设 `ALLOW_SCRAPING=false`。

## 真实爬取（scrape 策略）

`server/adapters/scrape/generic.js` 是**可运行的真实爬取引擎**，不是骨架。

- **网络引擎**：每次请求随机 UA + 请求间随机延迟 + 失败指数退避重试 + 代理池轮换；优先 Playwright（无头浏览器，JS 渲染必需，含滚动触发懒加载），降级原生 `fetch`（服务器渲染页，支持 undici 代理）。
- **解析策略**：① 浏览器内通用启发式（扫「图+链+价」，无需校准，覆盖最广）；② CSS 类选择器（按站点校准，精准字段）；③ JSON-LD 结构化数据；④ `--verify` 校准诊断。
- **详情页评论 + 问答**：`collectProduct(..., {withDetails:true})` 跟进商品详情页，抽取评论与公开问答，关联回商品。

### 网络 / 抗反爬参数（环境变量，均可覆盖）

| 变量 | 默认 | 说明 |
|------|------|------|
| `ALLOW_SCRAPING` | `true`(默认) | 爬取默认开启；设 `false` 可关闭 |
| `CRAWL_RPM` | 适配器 `rpm`(默认20) | 每平台每分钟请求上限（限流，防打挂目标站） |
| `CRAWL_DELAY_MIN/MAX` | `800`/`2500` | 请求间随机停顿区间(ms) |
| `CRAWL_TIMEOUT` | `30000` | 单页超时(ms) |
| `CRAWL_RETRIES` | `3` | 失败重试次数 |
| `CRAWL_RENDER_WAIT` | `1500` | Playwright 取 DOM 后等待异步渲染(ms) |
| `CRAWL_PROXY` / `CRAWL_PROXY_POOL` | 空 | 单代理 / 代理池（逗号分隔，或写入 `data/proxies.txt`） |
| `CRAWL_COOKIES` | 空 | 登录态 Cookie（JSON 数组或 `a=1; b=2`）；也可用 Cookie 工具导出到 `data/cookies/<平台>.json`，系统自动读取 |
| `CRAWL_NO_PW` | `false` | 设 `true` 禁用 Playwright，仅用 fetch |
| `RANDOMIZE_FINGERPRINT` | `true` | 请求指纹随机化总开关；设 `false` 关闭（固定 UA、不伪造出口 IP） |
| `STORE_BACKEND` | `sqlite` | 存储后端：`sqlite`（默认，零依赖）或 `mongodb`（本地 MongoDB 文档数据库） |
| `MONGODB_URI` | `mongodb://localhost:27017` | `STORE_BACKEND=mongodb` 时的连接串 |
| `MONGODB_DB` | `ecom_crawler` | `STORE_BACKEND=mongodb` 时的库名 |

### 京东 / 淘宝字段校准

`server/adapters/scrape/config.js` 中 `jd` / `taobao` 已补充分类选择器、`detailUrl`（详情页构造）、以及 `qa`（问大家）选择器模板。引擎优先用浏览器内启发式保底抽「标题+链接+图片+价格」，需要精确字段时再校准选择器或 `--verify`。

### 唯品会专项：mapi 直连通道

唯品会搜索页前端行为不稳定（经常只渲染模板壳、不触发商品 XHR），因此 vip 配置了 `directApi` 直连通道（`server/adapters/scrape/vip-api.js`）：直接调 `mapi-pc.vip.com` 的 `search/product/rank`（拿 pid）→ `product/module/list/v2`（`scene=search&productIds=...` 拿完整字段；**单批最多 50 个 pid**，超出自动按 50 分批请求），带登录态 Cookie 即可访问。**优先级最高、3 秒出结果**，字段含品牌/类目/特卖价/市场价/折扣；失败自动回退浏览器渲染路径（浏览器路径也会捕获 mapi 响应做结构化解析）。

### 各平台直连通道一览（2026-10-14 补齐京东详情/华为商城全链路）

| 平台 | 搜索直连 | 详情 SPU/SKU 直连 | 说明 |
|---|---|---|---|
| 唯品会 | ✅ mapi rank+list（登录态） | ✅ detail/main/v6 POST（登录态） | 字段最全（品牌/类目/价格/折扣） |
| 亚马逊 | ✅ 搜索页 SSR HTML 解析 | ✅ 详情页 twister（dimensionValuesDisplayData） | 海外站走代理；币种 USD；SSR 含价格/评分 |
| 苏宁易购 | ✅ 搜索页 SSR 商品块解析 + `ds.suning.com/ds/generalForTile` 批量价格接口（匿名可调，**SSR 与详情都不含价格**，价格/店铺名全靠它；对 mdmGroupId/brandId 宽容，商品号是唯一必要参数） | ✅ 详情页 `var sn` + clusterMap（颜色×版本） | 苏宁字段名交叉错乱（clusterMap.color 实为版本 ID、itemCuPartNumber.versionId 才是颜色 ID，dl 命名 colorItemList=版本、versionItemList=颜色）；suning 浏览器回退配了 `urlAccept`+`itemIdPattern` 护栏（防筛选标签被解析成商品、店铺码被当成商品号）；存量坏数据用 `tools/backfill-suning.mjs` 修复 |
| 淘宝/天猫 | ⚠️ mtop h5 签名（`mtop-api.js`，**登录态必需**） | 浏览器渲染 | 匿名 ret=request is forbidden；无登录态自动回退浏览器并提示提取 |
| 闲鱼 | ⚠️ mtop h5 签名（**登录态必需**） | 浏览器渲染 | 匿名触发 SM 滑块（RGV587） |
| 京东 | ❌ api.m.jd.com 需签名且 functionId 随版本变化 | ✅ `item.m.jd.com` SSR（`jd-api.js`：`_itemOnly` SKU 变体 + `_itemInfo` 真实价格） | PC 端 item.jd.com 是 JS 壳无数据，必须用移动端；SSR 展示价带掩码（"1??9"）不可用，取 realPriceExt.ORIGINAL.jdprice_amount；搜索走浏览器渲染 + 登录态（响应捕获已加 api.m.jd.com） |
| 拼多多 | ❌ 接口要求 anti-content 签名（匿名 403 error_code=40003） | ❌ 未登录详情页跳登录页 | 走浏览器渲染 + 登录态；浏览器响应捕获已加 proxy/api（登录后可拿结构化商品数据） |
| 华为商城 | ✅ `openapi.vmall.com/mcp/v1/search/queryPrd` POST（`huawei-api.js`，**匿名可调**） | ✅ comdetail SSR `__NEXT_DATA__`（base=每 SKU 名称/价格/规格/库存） | 请求需先 GET csrftoken.js 引导会话（CSRF-TOKEN Cookie）+ 同值 `csrfToken` 请求头 + 任意 32hex tid；详情跳转链（302/307）每跳 set-cookie，必须带 Cookie 罐手动跟随 |
| 小红书 | ❌ 搜索页未登录=登录墙（2026-10-26 实测） | ❌ 详情页桌面端强制 App 扫码验证；移动端落 App 墙（详情接口匿名 error_code 602） | **登录态必需**：主路线=浏览器渲染 + 响应捕获（edith/mall.xiaohongshu.com 已入捕获白名单）；Cookie 提取登录页=主站 |
| 抖音商城 | ❌ 主站搜索未登录=验证码中间页（2026-10-26 实测） | ❌ 抖店商品页未登录弹「页面已下线」离线弹窗 | **登录态必需**：主站 douyin.com 登录后浏览器渲染 + 响应捕获（ec.snssdk.com / jinritemai.com 已入白名单）；注意主站 Cookie 不覆盖 jinritemai 域，详情页以登录态浏览路径为准 |
| TikTok Shop | ❌ shop.tiktok.com 全入口被 Security Check 滑块拦截（2026-10-26 实测，数据中心 IP 直连） | ❌ 同左 | 可行前提=海外住宅代理（`CRAWL_PROXY`/代理池）+ 登录态 Cookie；官方合规路线=TikTok Shop 开放 API（partner.tiktokshop.com）；币种 USD |
| 快手 | ❌ 网页端无商城入口：`kuaishou.com/shop` 404（2026-10-26 实测） | ❌ 短视频页未登录=「登录查看更多」墙，商品卡需登录态 | **登录态必需**：主路线=短视频/直播页浏览器渲染 + graphql 响应捕获（kuaishou.com/graphql 已入白名单）；无独立网页商品详情页，itemId 兜底用短视频链接 |

通用机制：`directApi` 失败或返回空自动回退浏览器渲染；`detailApi` 直连在浏览器加载失败时仍会单独返回已获取的 SPU/SKU（不丢数据）。详情 id 提取顺序：vip `detail-<brandId>-<id>.html` → 亚马逊 `/dp/<ASIN>` → 苏宁 `product.suning.com/<shopCode>/<id>.html` → 京东 `item(.m).jd.com/<sku>.html` → 华为 `vmall.com/product/<prdId>.html` → 兜底 10+ 位数字。

### 数据浏览

「数据管理」页含 3 个页签：商品 / 评论 / 问答。商品行「详情」打开抽屉：完整字段 + SPU/SKU 拆解 + 关联评论/问答 + 补抓详情；评论/问答行的「商品」列可点击跳回对应商品。页面每 5 秒感知库存变化自动刷新；清空数据后表格立即回到第 1 页并刷新。

### Cookie 提取小工具（绕过登录墙）

淘宝、京东等强反爬平台直接打会返回登录页/验证码。用自己的账号登录态即可绕过。

**推荐：面板一键操作**——仪表盘「爬虫设置 → 登录态提取」选平台点「提取登录态（弹出浏览器登录）」，会弹出**系统 Chrome**（最大化、可正常操作），登录成功后自动检测保存，全程无需命令行。保存后自动重测并刷新登录状态表。

- **持久化浏览器档案（2026-10-27）**：提取所用 Chrome 每平台一个独立档案（`data/chrome-profiles/<平台>`），Cookie/localStorage 跨次保留——重新登录时通常已带会话，多数平台无需重复扫码。
- **🌐 浏览器态检测（登录状态表新按钮）**：headless 读取该平台提取浏览器档案中的**实时登录态**（区别于「检测」读已保存快照），判定已登录时自动把档案内最新 Cookie 同步为采集用快照。注意：受 Chrome App-Bound Encryption 安全机制限制，系统**无法直接读取你日常 Chrome** 的 Cookie，请统一用本系统弹出的提取浏览器登录。

命令行等价方式：

```bash
# 1) 交互提取：弹出系统 Chrome（持久化档案），检测到登录成功自动保存（关窗口有快照兜底）
node tools/cookie-tool.js extract --platform taobao
# 2) headless 读取档案实时登录态（已登录则同步快照），stdout 末行输出 JSON 结果
node tools/cookie-tool.js probe --platform kuaishou
# 3) 从浏览器复制的 "a=1; b=2" 或 JSON 转换
node tools/cookie-tool.js convert --platform jd --in cookies.txt
# 4) 查看已保存的 Cookie 文件
node tools/cookie-tool.js list
```

导出的 `data/cookies/<平台>.json` 会在采集该平台时**自动注入**（无需再设 `CRAWL_COOKIES`）。

### 测试

```bash
npm test   # = node scripts/run-all-smoke.cjs：13 套冒烟+单元测试统一入口（含真实网络，约 4~6 分钟）
node tools/test-cookie-tool.mjs   # 仅登录自动关闭决策单元测试（秒级）
```

冒烟脚本逐轮沉淀在 `tools/smoke-round*.cjs`；全量入口顺序执行并汇总退出码。登录态提取的「自动关闭」走双闸判定（`tools/cookie-tool.js`）：cookie 标记命中 + 页面级二次确认（小红书游客态也会种 `web_session`，须确认 `.login-btn` 登录按钮消失才算登录）。

### 离线验证（无需浏览器 / 外网）

```bash
# 列表页商品
node scripts/run-collect.js --platform jd --type product --strategy scrape \
  --query 手机 --fixture data/fixtures/demo-products.html --limit 10

# 商品 + 详情页评论 + 问答
node scripts/run-collect.js --platform jd --type product --strategy scrape \
  --query 手机 --fixture data/fixtures/demo-products.html \
  --withDetails --detailLimit 2 --detailFixture data/fixtures/demo-detail.html

# 公开问答单独采集
node scripts/run-collect.js --platform jd --type qa --itemId 100001 --strategy scrape \
  --fixture data/fixtures/demo-detail.html

# 校准诊断：只看命中情况，不落库
node scripts/run-collect.js --platform jd --type product --verify --fixture data/fixtures/demo-products.html
```

> 注：所有 CLI 脚本均以 `node --experimental-sqlite` 运行（SQLite 为实验模块，需该 flag），已写入 `package.json` 的 `scripts`。

## 代理池自动轮换

```bash
# 把代理写进 data/proxies.txt（每行一个），或设 CRAWL_PROXY_POOL 环境变量
echo "http://user:pass@host:port" >> data/proxies.txt
# 重启服务后自动生效；每次请求轮换，失败自动剔除并冷却
```

仪表盘「代理池 & Cookie」面板支持：
- **添加代理**（填 `127.0.0.1:7890` 这类 VPN 本地端口会自动补 `http://`，或代理商的 `http://user:pass@host:port`）；
- **一键测速**（走该代理请求一次目标站测延迟，显示每条 ✅ms 或 ❌ 人话错误原因，失败自动进冷却）；
- **删除代理**、查看每条的延迟与状态。

> **协议支持**：HTTP 代理走 undici ProxyAgent，**SOCKS4/5 走 fetch-socks**（如 v2rayN 默认的 `socks5://127.0.0.1:10808`）——测速与抓取均可用。注意所有代理请求统一使用 npm `undici` 的 fetch（Node 内置 fetch 与 npm undici v7 dispatcher 跨实例不兼容，会报 `UND_ERR_INVALID_ARG`）。

> **VPN 接入说明**：Clash / V2Ray 等客户端会在本地开 HTTP/SOCKS 端口（v2rayN 默认 SOCKS 10808 / HTTP 10809，Clash 默认 7890），把对应端口加入代理池即可让爬虫流量走 VPN 出口，家庭 IP 不再直接暴露。注意：VPN 出口多为机房 IP，部分电商平台对机房 IP 更敏感；要更接近真实用户，建议购买**住宅代理**服务填入池中。代理 IP 无法凭空生成——池里只能放「真实可达」的代理地址，系统负责轮换、测速与故障剔除。

## 爬虫运行时设置（每次调用生效）

仪表盘「爬虫设置」面板可调：随机延迟 min/max、单页超时、重试次数、渲染等待、Playwright 开关、指纹随机化开关。保存后**立即生效**（无需重启），并持久化到 `data/settings.json`。等价 API：`GET/POST /api/settings`。

**全局节流（防封号）**：所有真实网络请求之间强制间隔 `delayMin~delayMax` 的随机档位（默认 2~6 秒），运行日志可见「节流等待 Xs」。要更保守就调大区间（如 5~15 秒）；代价是采集更慢。节流是**跨模块单例计时**（`config.js` 的 `netThrottle`）：直连接口（vip/jd/亚马逊/苏宁/华为/mtop）与浏览器页面加载共用同一个闸口，因此「rank→list」「直连失败→浏览器回退」「详情页→详情页」等跨通道切换同样被隔开——新增请求出口时必须在发起 fetch/goto 前调用 `await netThrottle(log)`。

## 字段提取诊断

字段提取为三层策略（按顺序回退）：
1. **浏览器内启发式**：扫「商品图 + 链接 + 价格」三要素，免校准、覆盖最广，但字段最少（标题/价格/图片/链接）；
2. **CSS 类选择器**：`server/adapters/scrape/config.js` 按平台维护，字段最全（类目/品牌/店铺/销量等），站点改版时需要校准；
3. **JSON-LD 结构化数据**：页面内嵌 `application/ld+json` 的兜底解析。

诊断方法（仪表盘「运行采集 → 字段提取诊断」）：
- **在线 URL 模式**：填目标页 URL，走完整爬取引擎（代理池 + 随机指纹 + 浏览器渲染 + 懒加载滚动）抓回页面后诊断，适合 JS 动态渲染的页面；
- **本地文件模式**：把目标页「另存为 HTML」后点「📂 选择 HTML 文件」直接上传诊断（高级模式可填服务器可访问路径）。

输出包括：每个字段的命中数与样例值、可入库的组合样例、当前可用策略与下一步校准建议；平台选择器全空时会自动用通用测试选择器交叉核对，区分「页面没内容」与「选择器没对准」。API 等价：`POST /api/diagnose {platform, kind, url | fixturePath}`。CLI 等价：`--verify`。

> 注意：字段提取发生在**采集时**（网页 HTML → 字段 → 入库）；导出 CSV/JSON 只是把已入库字段写文件，不做提取。

## 采集过程日志

`GET /api/logs?since=<序号>`：增量获取运行日志（引擎选择 / 档案编号 / 代理 / 重试 / 详情页进度 / 风控信号）。仪表盘「运行采集」点击运行后，「采集中」下方会实时滚动展示这些日志，采集结束自动收尾。日志环形缓冲 800 条，同时镜像到服务器控制台（`[run]` 前缀）。

## 手动停止采集

采集运行中，「运行采集」按钮旁会出现红色「■ 停止采集」按钮。点击后 `POST /api/collect/stop` 置位停止标志，采集流程在**最近的检查点**（每次网络请求前 / 策略切换 / 详情页循环）安全退出——当前已在途的请求会等它完成，**已入库的数据保留**，返回 `status: "stopped"`。

## 登录态内容查看

「爬虫设置 → 代理池 & Cookie」区：选平台点「查看登录态内容」→ 弹窗展示 `data/cookies/<平台>.json` 的全部条目（名称 / 值悬停看全文 / 域 / 有效期），支持一键复制 JSON。提取登录态成功后也会自动弹出。

## 商品详情页 SPU / SKU 提取

勾选「带详情」采集时，详情页会额外提取 **SPU（商品级）与 SKU（规格组合）** 信息，合入商品记录的 `specs` 字段（「数据浏览 → 商品详情」页签的「详情 JSON」可直接查看）：

- **唯品会**：直连 `POST /vips-mobile/rest/shopping/pc/detail/main/v6`（登录态必需），解析 `data.base`（spuId / prodSpuId / 标题 / 品牌 / 类目）+ `data.saleProps`（尺码/颜色规格维度）+ `data.products`（每 SKU 价格 / 市场价 / 折扣 / 货号 / 图）。
- **其他平台**：四层兜底——平台专属接口解析 → 浏览器捕获接口响应通用深搜（含页面内嵌 `__INITIAL_STATE__`）→ DOM 规格区启发式（自动过滤运费/收藏等噪声容器）→ JSON-LD offers 变体。

## 商品字段补全（类目 / 品牌 / 店铺 / 销量）

- **店铺**：SQLite `products` 表新增 `shop_name` 列（老库启动时自动 ALTER TABLE 迁移），导出 CSV 同步含 `shopName`。
- **类目/店铺**：唯品会 list/v2 搜索接口**不返回**类目名与店铺名（brandStoreSn 只是 ID）。直连通道拿到商品后会自动对缺失字段最多 10 个商品调详情接口（detail/main/v6）补全；带详情采集时 SPU 的权威字段（brandName/categoryName/vendorName）也会回填商品行。
- **存量数据回填**：`node --experimental-sqlite tools/backfill-fields.mjs --platform vip` —— 逐 itemId 调详情接口覆盖品牌/类目/店铺（0.7s 间隔防风控）。
- **销量**：唯品会搜索/详情接口均不返回销量，属数据源缺失；列表里显示「—」。
- 全站时间统一北京时间、精确到分钟（采集时间 / 评价 / 问答 / 任务完成时间 / Cookie 有效期 / 运行日志）。

## 唯品会采集须知

- 旧搜索地址 `www.vip.com/search?keyword=` 已下线（404），现走 `category.vip.com/suggest.php`。
- 唯品会 TFS 风控对无登录态请求返回 `{"msg":"Forbidden by TFS","code":11000}`，商品接口直接拒绝。**必须带登录态 Cookie**：
  ```bash
  node tools/cookie-tool.js extract --platform vip
  ```
  登录后回车，登录态存 `data/cookies/vip.json`，采集时自动注入。系统检测到 TFS 拦截会在日志与报错中明确提示。
- 频繁无 Cookie 试探会触发 IP 级临时封禁（连接直接被拒），等待冷却或切换 VPN 出口节点。

## 请求指纹随机化（抗指纹识别）

每次抓取请求都会生成一组随机「身份」，与代理池轮换叠加：

- **档案池机制**：每次运行采集前生成 **10 组随机请求档案**（UA + 伪造 IP + 语言 + 视口 + 随机 Cookie），本次运行的每个请求从池中**随机抽取一组**使用——同一次运行内身份一致（像同一个访客的多请求），跨运行完全不同。运行日志会显示每个请求用了哪组档案（`档案#N/10`）。
- **随机 User-Agent**：由「浏览器 × 操作系统 × 版本号」组件实时拼装，比静态 UA 池更难被识别为脚本（不再是那几个固定字符串）。
- **随机出口 IP**：生成一个公有段 IPv4 并写入 `X-Forwarded-For` / `X-Real-IP` 请求头（避开私有/回环/组播等保留段）。仅作用于 fetch 直取引擎；浏览器渲染路径**不伪造 XFF**（WAF 会校验 XFF 与 TCP 源 IP 一致性，不符直接拒绝加载）。
- **随机 Cookie**：每组档案附带一组随机 Cookie（uuid/cna/trackId 等），模拟「不同访客」的本地痕迹；登录态 Cookie（`data/cookies/<平台>.json`）优先级更高，会叠加注入。
- **随机语言 / 视口**：`Accept-Language` 与浏览器视口（分辨率）也随机变化。

```bash
# 仪表盘「请求指纹随机化」面板：点「生成随机指纹」可预览一次生成的 UA / IP / 语言 / 视口 / 代理
# 关闭随机化（回到固定 UA、不伪造 IP）：
RANDOMIZE_FINGERPRINT=false npm start
```

> 指纹随机化是「降低风险」的加固手段，不能替代合规的代理与登录态；真抓反爬站仍需住宅代理 + Cookie。

## 本地 MongoDB 文档数据库后端

默认用 SQLite（零依赖）。切换 MongoDB **直接在仪表盘「存储管理」面板点「切换到 MongoDB」即可**（立即生效、记忆到 `data/settings.json`，无需改环境变量或重启）；也可用环境变量：

```bash
# 1. 安装依赖（mongodb / undici 均已在 package.json，npm install 自动装）
npm install

# 2. 用环境变量切换后端并启动
STORE_BACKEND=mongodb MONGODB_URI=mongodb://localhost:27017 npm start
```

- 启用后，采集数据与定时任务/运行记录分别存入 MongoDB 集合：`products` / `reviews` / `qa` / `jobs` / `job_runs`（库名默认 `ecom_crawler`，可用 `MONGODB_DB` 覆盖；`chats` 为历史遗留集合，不再写入）。
- 文档按驼峰字段原样存储，`id` 为主键（`replaceOne upsert`），与 SQLite 行结构兼容，便于迁移与跨库查询。
- 全接口 async 统一封装在 `server/storage.js` 门面：业务层（采集/导出/调度/API）**无需改动**即可切换后端。
- 若 MongoDB 未启动，`storageInfo()` 会优雅返回 `connected:false` 与连接错误，不会让服务崩溃；真正读写时才会报错提示。

## 存储管理（查看位置 + 清空数据）

仪表盘「存储管理」面板：

- **查看位置**：显示当前存储后端、数据库文件（SQLite）或连接串（MongoDB）、数据目录、导出目录与 Cookie 目录的大小/文件数、以及各类型记录数。
- **清空数据**：「数据管理」页点「🗑 清理数据」弹框确认——弹框按当前范围（当前筛选 或 全部）实时统计各类型条数，勾选要删除的类型（商品/评论/问答）、是否含定时任务/导出文件，确认后执行（不可逆）。API 支持 `platform`/`q` 参数做范围删除。

API 等价操作：

```bash
# 查看存储信息
curl http://localhost:4311/api/storage
# 清空（需 confirm:true 作为安全护栏）
curl -X POST http://localhost:4311/api/storage/clear \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true,"types":["product","review","qa"],"jobs":false,"exports":false}'
```

## 定时采集

任务存于数据库 `jobs` 表，服务启动即自动调度。仪表盘「定时采集任务」面板可：
- 添加任务（平台 / 类型 / 查询词 / 周期 / 数量 / **带详情（评论+问答+SPU/SKU，可设详情数 N：跟进前 N 个商品详情页一并采回）** / 是否启用）；
- 手动触发单次运行；
- 删除任务；查看 `job_runs` 运行记录。

也可独立运行调度器：`npm run scheduler`（或 `node scripts/scheduler.js --run <jobId>` 仅跑一次）。

首次启动会种入一个**默认禁用**的示例任务 `sample-suning-product` 作为模板。

## 数据导出（CSV / JSON）

所有数据类型（product / review / qa）均支持两种格式：
- 仪表盘「数据浏览 & 导出」面板：选类型后点「导出当前类型 CSV / JSON」直接下载。
- CLI：`npm run export -- --type product --format csv`（`--platform` / `--q` 可筛选），文件落到 `data/exports/`。
- HTTP：`GET /api/export?type=product&format=json`。

## 八大平台实测状态（2026-10-13）

引擎已验证可真实联网抓取。下表为沙箱内用数据中心 IP 直连的实测结果——**带登录态 Cookie + 住宅代理后，反爬类普遍可解**。

| 平台 | id | 当前状态 | 说明 |
|------|----|---------|------|
| 苏宁易购 | `suning` | ✅ 可直接爬 | 实测抓到真实商品（标题/链接/图片） |
| 淘宝/天猫 | `taobao` | 🔒 登录墙 | 需 `CRAWL_COOKIES` 或 `data/cookies/taobao.json`（Cookie 工具） |
| 京东 | `jd` | 🔒 登录墙 | 需 `data/cookies/jd.json` |
| 拼多多 | `pdd` | 📱 App 壳 | 移动页多为 JS App，需 Cookie + 代理 |
| 得物 | `dewu` | ❌ 无网页商城 | 2026-10 实测：PC/H5 均为品牌壳页 + App 下载墙，商品接口被验证码风控（code 485）；已配 `mobileOnly` 强制移动端 UA/视口（isMobile+hasTouch）仍是下载墙。可行路线=得物开放平台 / App 抓包 |
| 唯品会 | `vip` | 🔒 验证页 | 需 Cookie + 代理 |
| 闲鱼 | `xianyu` | 🔒/App | 需 Cookie + 代理 |
| 亚马逊 | `amazon` | 🔒 反爬 | 需住宅代理 + Cookie |

> 价格、销量等字段对未精细校准的站点可能为空，属正常——引擎保底抽出"标题+链接+图片"，需要完整字段时到 `config.js` 增补选择器或用 `--verify` 校准。

## 目录结构

```
server/
  types.js              数据契约与常量（product/review/qa）
  compliance.js         限流 + 爬取安全总闸
  db.js                 SQLite 存储（node:sqlite）+ jobs/job_runs + 查询/导出/清空
  storage.js            存储门面（按 STORE_BACKEND 选 SQLite / MongoDB，全 async）
  storage-mongo.js      本地 MongoDB 文档数据库后端（惰性依赖 mongodb）
  fingerprint.js        请求指纹随机化（随机 UA / 出口 IP / 语言 / 视口）
  store.js              兼容层（再导出 storage.js）
  export.js             CSV / JSON 导出
  proxy-pool.js         代理池（轮换 + 健康度冷却）
  scheduler.js          定时采集引擎
  collectors.js         编排：官方→OpenCLI→爬取 三级回退；关联评论/问答落库
  index.js              HTTP 服务 + API
  test-run.js           一键测试（列表→详情→评价→问答；成功数据自动入库）
  adapters/
    base.js             适配器基类（含 guard 安全闸门）
    registry.js         平台注册表（可扩展性核心）
    mock.js             无凭证可跑通的 mock 适配层
    official/taobao-top.js   淘宝 TOP 官方API（真实签名请求+字段映射；凭证走设置页或 TOP_APP_KEY/SECRET/SESSION 环境变量）
    official/opencli-adapter.js  OpenCLI 桥接：复用本机 Chrome 登录态采集（taobao/jd/xianyu/amazon；需 @jackwener/opencli + Browser Bridge 扩展）
    scrape/generic.js        真实爬取引擎(Playwright/fetch + 多策略解析 + 详情页评论/问答)
    scrape/config.js         各平台选择器 + UA池 + 网络参数 + 代理/详情/问答配置
tools/
  ensure-browser.js     自动安装无头浏览器（postinstall + 启动自检）
  cookie-tool.js        Cookie 提取小工具（extract / convert / list）
scripts/
  run-collect.js        CLI 采集（支持 --withDetails / --detailFixture / --verify）
  scheduler.js          独立定时采集调度器
  export-data.js        CLI 导出
public/                 仪表盘前端
data/                   数据库(ecom.db) + 导出(exports/) + Cookie(cookies/) + 示例(fixtures/)
```

## 如何新增一个平台

1. 在 `server/adapters/` 下新建适配器类（继承 `BaseAdapter`），实现 `collectProduct` / `collectReviews` / `collectQa`。
2. 在 `server/adapters/registry.js` 的 `PLATFORMS` 数组追加：
   ```js
   { id: 'newplatform', name: '新平台', official: NewPlatformAdapter, scrape: GenericScrapeAdapter },
   ```
3. 如需官方 API：`export class NewPlatformAdapter extends BaseAdapter { ... }`，读取对应密钥环境变量。
4. 如需爬取回退：在 `config.js` 的 `SCRAPE_CONFIG` 增补该平台的选择器 / `detailUrl` / `qa` 配置。

## 数据获取策略说明

| 数据类型 | 推荐路径 | 兜底 |
|---------|---------|------|
| 商品 | 官方开放平台 API | 授权后爬取 |
| 评论 | 官方开放平台 API | 详情页爬取（带详情时自动采） |
| 问答(问大家) | 商品详情页爬取（公开内容） | — |

