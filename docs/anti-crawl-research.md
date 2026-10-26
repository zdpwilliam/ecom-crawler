# 规避平台防爬策略调研（2026-10）

> 结论先行：我们现有体系（全局节流 + 代理池 + UA/指纹随机化 + 登录态注入 + 直连接口优先）已覆盖「行为层 + IP 层 + 会话层」；
> 与业界主流方案的最大差距在**传输层指纹（TLS JA3/JA4 与 HTTP/2 指纹）**和**浏览器隐匿深度**两块。

## 一、风控识别的五层模型（2026 主流）

| 层 | 检测手段 | 我们现状 | 差距 |
|---|---|---|---|
| 传输层 | TLS ClientHello 指纹（JA3/JA4）、HTTP/2 SETTINGS 帧/伪头序 | Node undici 默认 TLS 栈，指纹是「Node 而非 Chrome」 | **最大缺口** |
| 报文层 | 头顺序、Client Hints（Sec-Ch-Ua）与 UA 一致性 | UA 随机但头顺序是库默认序，Sec-Ch-Ua 未发 | 中 |
| 环境层 | Canvas/WebGL/navigator.webdriver/无头特征 | Playwright 原生，未做 stealth 补丁 | 中 |
| IP 层 | 数据中心 IP 评分、ASN 信誉、地理一致性 | 代理池 + 冷却 + 剔除已有 | 已达标 |
| 行为层 | 请求节奏、轨迹熵、会话路径 | 随机延迟 1.5-3s 全局节流 | 基本达标 |

## 二、业界主流方案与适用性

1. **TLS 指纹伪装（性价比最高的增量）**
   - 方案：Node 生态用 `got-scraping`（header 生成 + TLS 调优）；更彻底的是 `curl-impersonate`（字节级复刻 Chrome 握手，Node 可用 `node-curl-impersonate` / 直接 spawn 二进制）。
   - 关键纪律：**全套一致性**——TLS profile、UA、Sec-Ch-Ua、Accept-Language 必须同版本；UA 不能逐请求乱换（真人会话一个浏览器），应在「会话」级轮换。
   - 适用：苏宁/华为/亚马逊等直连通道立刻受益；淘宝 mtop 对 TLS 也有检测。
2. **无头浏览器隐匿升级**
   - `--headless=new`（完整浏览器二进制）+ `--disable-blink-features=AutomationControlled`；社区方案 patchright / camoufox（Firefox 反检测）可对抗 navigator.webdriver 检测。
   - 注意 CDP 协议本身的时序泄露是第一代 stealth 补丁覆盖不了的。
3. **代理策略升级**
   - 数据中心 IP < 住宅 IP < 移动 4G/5G IP（可信度递增）；单 IP 单站点每日请求量控制在 ~200 次内；按任务/站点隔离 IP 池防行为交叉关联；失败熔断 + 冷却（已实现）。
4. **行为拟人**
   - 延迟用泊松/正态分布而非均匀随机；会话内预热（先访问首页/搜索页再进详情，带 Referer 链）；穿插非目标页面访问。
5. **会话与 Cookie 池**
   - 定期刷新登录态（本次新增的定时检测即此）、多账号 Cookie 池轮换；触发风控时换「纯净度更高的 IP」重试而非原 IP 重试。
6. **验证码**
   - 滑块/点选：打码平台（约 ¥0.1/次）或浏览器内人工兜底；无感验证依赖设备指纹一致性。
7. **托管解锁器**（Scrapfly/Bright Data Web Unlocker，独立测评 95-99%）
   - 免自研对抗但按量计费且数据经第三方，**国内平台不可用/不合规**，仅作了解。

## 三、对我们项目的落地建议（按优先级）

1. **P0 直连通道换 `got-scraping`**（或 undici 自定义 ClientHello）：受益面最大，改动集中在 config.js 的 fetch 封装；同步把 UA 池改成「会话级轮换 + 头顺序模拟 Chrome」。
2. **P1 浏览器路径加 stealth**：launch args 加 `--disable-blink-features=AutomationControlled`、`--headless=new`；给 `navigator.webdriver` 打补丁；视口/时区/语言与代理 IP 地理一致。
3. **P1 Referer 链与会话预热**：详情请求前先过一次搜索页/首页，把 Cookie 罐「焐热」，Referer 填上一跳真实 URL。
4. **P2 多账号 Cookie 池**：现单账号单文件，扩展为 `<platform>-<n>.json` 池，检测失效自动切号。
5. **P2 延迟分布升级**：均匀随机 → 正态分布（均值 3s、σ 1.5s），偶发长停顿（模拟阅读）。
6. **不投入**：JSVMP 纯签名逆向（平台升级即失效，历史教训）、托管解锁器。

## 四、红线（合规）

- 频率 ≤ 正常用户均值 3 倍；不抓个人隐私字段；不绕付费/授权墙；请求日志留存备查。
