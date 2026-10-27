# 爬虫技术与策略深度调研报告

> 调研时间：2026-10-27 ｜ 对象：ecom-crawler 采集平台 ｜ 方法：本项目代码盘点 + GitHub 开源生态调研（Crawlee / Patchright / Camoufox / Scrapling / curl-impersonate 等，多源交叉验证）

---

## 一、本项目当前采用的技术与策略

### 1.1 架构总览

```
请求 → 策略链（official API → OpenCLI 浏览器插件桥 → scrape 爬取）
                                ↓
              指纹层（30 套真实设备池 + 追加档案，端型筛选）
              网络层（代理池轮换 + 伪造 X-Forwarded-For）
              会话层（平台 Cookie 快照 + 登录态失效检测）
              行为层（随机延迟 900~1600ms 节流、随机 UA/视口/语言）
              解析层（HTML 结构化 + mtop 签名直连 + OpenCLI 桥）
              存储层（SQLite/MongoDB 双后端 + 审计日志）
```

### 1.2 分层能力现状

| 层 | 已有能力 | 对应开源理念 |
|---|---|---|
| 请求层 | HTTP 直连优先（mtop 签名、京东/唯品会接口），失败回退 Playwright 渲染 | Crawlee 的 CheerioCrawler → PlaywrightCrawler 分层 |
| 指纹层 | 30 套**真实设备档案**（UA↔平台↔视口↔语言↔Client Hints 严格同源），端型子池筛选 | Apify fingerprint-suite 的"指纹即身份"思想 |
| 网络层 | 代理池（添加/测速/冷却/删除）+ 每请求伪造 XFF | Crawlee ProxyConfiguration 轮换 |
| 会话层 | Cookie 快照按平台管理 + 定时/手动登录态检测（api 探针 + cookie-expiry 启发式） | SessionPool 的会话↔IP↔Cookie 绑定 |
| 行为层 | 随机节流（900~1600ms 间隔）、随机视口 | 自适应节流（Scrapling AutoThrottle 的简化版） |
| 工程层 | 14 套冒烟测试、审计日志、调度器、双 tsconfig、React 面板 | Crawlee 的工程化封装 |

### 1.3 采集策略链（每平台三选一自动降级）

1. **official**：官方/半官方接口（淘宝/闲鱼 mtop H5 签名直连、京东订单接口、唯品会 mobile 接口）
2. **opencli**：浏览器插件 OpenCLI 桥（复用用户真实登录态，反爬最强但依赖扩展连接）
3. **scrape**：Playwright 渲染 + 结构化解析（兜底，覆盖全部平台）

---

## 二、行业共识：检测发生在五层，任何工具只覆盖几层

这是本次调研最重要的认知框架（多份独立测评交叉验证一致）：

| 层 | 检测内容 | 本项目覆盖度 |
|---|---|---|
| ① 协议层 | CDP 自动化痕迹（`Runtime.enable` 时序、`navigator.webdriver`） | ⚠️ 部分——用官方 Chromium，未打补丁 |
| ② 指纹层 | Canvas / WebGL / Audio / 字体 | ⚠️ 请求层完备（header 级）；浏览器渲染层未注入指纹 |
| ③ 行为层 | 鼠标轨迹、点击节奏 | ⚠️ 仅请求节奏随机化，无鼠标轨迹模拟 |
| ④ 网络层 | **TLS 指纹（JA3/JA4）**、HTTP/2 指纹、IP 信誉 | ❌ 最大缺口——undici/fetch 的 TLS 握手与真实浏览器差异显著 |
| ⑤ 渲染层 | 真实布局（`getBoundingClientRect`、真实 canvas 输出） | ✓ Playwright 真浏览器天然通过 |

**行业第一定律：IP 信誉与 TLS 指纹的重要性 > 指纹"打磨"的精细度**。完美指纹从脏 IP 出去照样被拦；反之 TLS 握手是 Python/Node 而 UA 写 Chrome，WAF 一眼看穿。

---

## 三、GitHub 优秀开源项目盘点（按对本项目价值排序）

### 3.1 框架层

| 项目 | Stars | 核心价值 | 对本项目的启示 |
|---|---|---|---|
| **apify/crawlee**（TS） | 26.3k | 统一 HTTP/浏览器接口、持久化队列断点续跑、SessionPool（Cookie+IP+指纹打包轮换）、got-scraping/impit 复刻浏览器 TLS | 编排思想可借鉴，直接引入则与现有策略链/调度器/面板深度耦合，**建议按模块吸收而非整体替换** |
| **D4Vinci/Scrapling**（Python） | 87k | 自适应解析（改版后按元素特征相似度重定位）、抓取阶梯（curl_cffi → Playwright → Patchright）、AutoThrottle | **自适应解析**是消灭"改版即失明"维护成本的正解，值得自研轻量版 |

### 3.2 反检测浏览器（两条路线）

| 项目 | Stars | 路线 | 关键事实 |
|---|---|---|---|
| **Patchright** | ~5k | 打补丁（Chromium，去 `HeadlessChrome` UA、WebDriver 暴露、`Runtime.enable` CDP 调用） | 已有 Playwright 代码**近乎零改动替换**；官方建议 `launch_persistent_context` + 真 Chrome（本项目提取浏览器已是 persistent 档案 ✓） |
| **Camoufox** | ~12.7k | 改引擎（Firefox fork，C++ 层写指纹，Juggler 协议绕开 CDP） | 标准检测 0% headless 检出，但 **Cloudflare 过盾约 42s/页**（约 85 页/时/worker），Firefox 份额 3% 部分站点对 Firefox 更严 |
| CloakBrowser | ~32k | Chromium 源码级 33 处补丁 + humanize | 较新，稳定性待观察；二进制闭源 |
| Botasaurus | ~5.8k | 行为层（贝塞尔鼠标轨迹公认最好） | 行为层被卡时的选项 |
| FlareSolverr | ~16k | 外挂式：真浏览器过挑战后交还 HTML+Cookie | 已有 HTTP 爬虫只想补"过 Cloudflare 一环"时最小侵入 |

### 3.3 HTTP 层伪装（性价比之王）

- **curl-impersonate**（根项目）：换 BoringSSL/NSS 定制编译，密码套件顺序/GREASE/HTTP2 参数逐项对齐真浏览器
- **got-scraping / impit**（Node，Crawlee 内置）：`useHeaderGenerator` + 浏览器风格 header；**本项目同为 Node 栈，直接可用的同生态位方案**
- **curl_cffi**（Python）：`impersonate="chrome136"` 一行伪装
- **四个限制必须知道**：① 不能单独过 Cloudflare 5 秒盾（挑战需 JS 执行）；② HTTPS 中间人代理会用代理自己的栈重新握手——TLS 伪装白做（SOCKS5 不改指纹）；③ 密码套件**顺序即指纹**（新版 BoringSSL 强制重排有真实 bug 案例）；④ 服务端已开始对"同一 JA3 新建连接/秒"限速

### 3.4 代理与会话管理范式

- **两种轮换语义必须区分**：per-request（无状态列表页）vs **sticky 粘性会话**（登录、购物车、Cookie 绑定的分页——本项目 mtop/唯品会登录态通道**必须粘性**，3 秒换 IP 本身就是异常信号）
- Crawlee SessionPool 范式：**Cookie + 代理 IP + 指纹打包成一个"虚拟用户"整体轮换**，被封整包丢弃——避免"烧掉的 IP 配新 Cookie"自相矛盾组合
- **死代理 vs 被封代理要分开处理**（scrapy-rotating-proxies 经验）：一个页面最多换 5 个 IP 重试，5 个都失败 = 目标在拒绝你，而不是继续杀代理。摘错方向会把健康池耗干
- 住宅代理价格参考（2026-09/10）：平价 $0.7–1.5/GB，主流 $2–4/GB；用**有效成本**核算（$1/GB 但一半被弹 = $2/GB）

---

## 四、对照差距与改进路线（按性价比排序）

> **实施状态（2026-10-27 更新）**：P0 全部 3 项与 P1 全部 3 项已完成落地——
> P0-1 会话池 `src/server/session-pool.ts`（三元绑定 + 登录态粘性）、P0-2 `src/server/http-client.ts`（impit TLS 伪装，全直连通道 + 探针接入）、P0-3 `classifyBan()` 语义化（session-expired/ip-banned/challenge/soft-block 四类处置）；
> P1-4 `src/server/fp-inject.ts` 渲染层指纹注入 + Patchright 自动探测（`npm i patchright` 即启用）、P1-5 `src/server/adapters/scrape/adaptive.ts` 快照重定位（含 noProductHint 平台跳过与误定位护栏）、P1-6 指纹池统计加权采样（FAMILY_WEIGHTS）。
> 测试：`tests/test-session-pool.mjs` 单元 17 项 + 全量冒烟 15 套通过。

### P0（高收益低成本，建议尽快做）

1. **会话↔代理↔指纹三元绑定**：当前代理轮换与 Cookie 快照、指纹抽档是独立的三件事。改为"同一会话固定同一代理+同一指纹"，登录态通道强制粘性。这是行业共识里"明明工具很强还是被封"的最大错配源。改动集中在 `fingerprint.ts` / `proxy-pool.ts` / 采集调度，量级约 1~2 天
2. **登录态探针补 TLS 伪装**：登录检测走 undici（Node 原生 TLS，一眼被识别为非浏览器）。引入 **got-scraping 或 impit**（同为 Node 生态，API 相近）替换探针与 HTTP 直连通道的底层，让 mtop/vip/京东探针的握手与真浏览器对齐。改动集中在 `login-check.ts` / 各 `-api.ts`
3. **封禁识别语义化**：当前探针把"200 但内容是挑战页"归为 unknown。参考 Crawlee 的 `session.retire()` / `markBad()` 语义：明确区分【会话失效→提示重登】【IP 被封→换代理重试】【风控挑战→降级浏览器渲染】三种处置

### P1（中等收益，按需做）

4. **浏览器渲染层指纹注入**：渲染兜底路径用官方 Chromium，渲染层指纹为默认值。轻量方案：页面 init script 注入 WebGL/Canvas/硬件并发等一致性覆盖（自研 fingerprint-injector 简化版）；重量方案：**Patchright 直接替换 Playwright 启动器**（对本项目提取浏览器/渲染兜底几乎零改动）。先在淘宝/抖音等强风控平台实测再决定
5. **自适应解析（对抗改版失明）**：为 scrape 通道的选择器加"元素特征快照"——首采时记录目标元素的结构指纹（标签、属性、父子关系、文本模式），改版后按相似度重定位并告警。参考 Scrapling 的 auto_save/adaptive 设计
6. **指纹池升级到统计采样**：当前 30 套为人工整理。可借鉴 fingerprint-suite 的贝叶斯网络按真实浏览器流量分布采样（版本/平台/语言联合分布），让池分布与真实流量对齐而非均匀随机

### P2（重投入，仅在收益明确时）

7. **Camoufox 路线**：仅当单平台强风控（如抖音/小红书全量采集）且价值足够覆盖 ~42s/页时考虑；与现有 Chromium 选择器不兼容，DOM 层要重写
8. **持久化请求队列 + 断点续跑**：Crawlee 的 RequestQueue 思想，当前调度器重启后无断点恢复。数据量大、任务频繁失败时再建
9. **托管 API 兜底**：企业级防御（Akamai/DataDome）自建成功率仅 20–40%，叠加住宅代理 70–85%。高价值难目标可按成功计费接 Bright Data Web Unblocker 类服务做最后一级策略链

### 成功率参考口径（方向性，非 SLA）

基础防护（Cloudflare Free）90%+；中等（CF Pro/PerimeterX）60–80%；企业级（Akamai/DataDome）20–40%（叠加住宅代理 70–85%）；自定义 ML 防御 <20%。所有"99% 成功率"宣传只能在自己目标清单上用真实正文校验（不能只看 200 状态码）。

---

## 五、合规边界（必须守住的底线）

- **中国**：公开数据 ≠ 开放数据；突破技术访问控制可能触及非法获取计算机信息系统数据罪；爬取个人信息可能触及侵犯公民个人信息罪；实质性替代原服务构成民事侵权。本项目现有合规设计（匿名视角优先、PII 脱敏、审计日志、人工登录）方向正确，应坚持
- 工程侧最低配：只用匿名访客可见数据、遵守 robots.txt 的 Disallow/Crawl-delay、自适应限速、数据最小化、不碰 PII
- AI 训练用途是当前最不确定的方向，robots.txt 对 AI crawler 正从行业惯例变成实质约束

---

## 六、一句话总结

**本项目的策略链、指纹池、登录态检测、测试工程化在同类开源项目中已属前列（多数同类项目只有 Selenium+UA 轮换水平）；当前真正的短板是 ①TLS 指纹（HTTP 层最易补）、②会话↔IP↔指纹未整体绑定（行为错配）、③封禁处置语义粗糙。按 P0→P1 路线逐级升配即可，P2 的重型反检测仅在单平台价值明确时投入。**
