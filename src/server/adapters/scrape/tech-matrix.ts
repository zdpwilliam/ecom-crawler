// 数据抓取技术矩阵：设置页「抓取技术」面板与一键测试技术标注的单一事实来源。
// 通道字段从 SCRAPE_CONFIG 实际配置推导（directApi/detailApi 是否存在），说明文案与各适配器实现一一对应。
import { SCRAPE_CONFIG } from './config.ts';

// ---------- 全站通用技术栈（每条均有真实实现落点） ----------
export const TECH_STACK = [
  {
    key: 'direct-api',
    name: '直连接口（逆向网页端 XHR）',
    desc: '直接调用平台网页前端自己使用的数据接口（如唯品会 mapi-pc rank/list、华为 openapi.vmall queryPrd），返回结构化 JSON，字段最全、速度最快、无需渲染。属逆向网页接口而非官方开放 API，凭登录态 Cookie 与页面内置公共参数访问。',
    impl: 'adapters/scrape/*-api.ts',
  },
  {
    key: 'ssr-parse',
    name: 'SSR / 内嵌数据解析',
    desc: '抓取服务端渲染 HTML，解析内嵌 JSON 状态（__NEXT_DATA__、var sn=、_itemOnly/_itemInfo）与 JSON-LD。适合 SSR 站点（苏宁、京东移动端、亚马逊）。',
    impl: 'adapters/scrape/suning-api.ts 等',
  },
  {
    key: 'browser',
    name: '浏览器渲染（Patchright 反检测）',
    desc: 'Patchright（Playwright 反检测补丁版，navigator.webdriver=false）无头加载页面，自动滚动触发懒加载与 XHR，等渲染稳定后提取；不可用时降级官方 Playwright。',
    impl: 'adapters/scrape/generic.ts loadPlaywright',
  },
  {
    key: 'response-capture',
    name: '页面响应捕获',
    desc: '浏览器加载过程中按 host 白名单旁路捕获平台数据接口的响应体（50 条上限），深搜解析结构化字段。登录态站点的搜索/详情数据主来源。',
    impl: 'generic.ts API_HOST_RE + api-parse.ts',
  },
  {
    key: 'tls',
    name: 'TLS 指纹伪装（impit）',
    desc: '直连请求走 impit（curl-impersonate 思路），按真 Chrome 对齐 JA3/HTTP2 握手；SOCKS/异常自动降级 undici。连续 5 次失败自愈关闭探测。',
    impl: 'http-client.ts impersonatedFetch',
  },
  {
    key: 'session',
    name: '会话池三元绑定',
    desc: '登录态 Cookie + 代理 + 设备指纹绑定成一个「虚拟用户」整体轮换、粘性复用；封禁按语义分类处置（session-expired→重登 / ip-banned→整包退役 / challenge→降级浏览器 / soft-block→退避）。',
    impl: 'session-pool.ts classifyBan',
  },
  {
    key: 'fingerprint',
    name: '设备指纹池 + 渲染层注入',
    desc: '30+ 套真实设备档案（UA↔OS↔视口↔语言↔Client Hints 严格同源），按端型范围抽取；浏览器路径同步注入 navigator/WebGL/Canvas 覆盖脚本，与 UA 保持一致。',
    impl: 'fingerprint.ts + fp-inject.ts',
  },
  {
    key: 'adaptive',
    name: '自适应解析（结构快照重定位）',
    desc: '页面改版导致选择器失效时，用商品卡结构快照 + Jaccard 相似度在新 DOM 中重定位；带四重护栏（无快照不重定位/快照不作参照/无商品提示跳过/JSON 整簇作废）防误定位。',
    impl: 'adapters/scrape/adaptive.ts',
  },
  {
    key: 'throttle',
    name: '全局限流与节流',
    desc: '令牌桶 RPM 限制 + 全局请求节流（任意两次真实请求至少隔一个 900~1600ms 随机档位），直连接口与浏览器通道共用计时；代理失败指数退避冷却。',
    impl: 'config.ts netThrottle + compliance.ts',
  },
];

// ---------- 平台级通道矩阵 ----------
// channel 字段与 SCRAPE_CONFIG 的 directApi/detailApi 配置严格对应：
//   directApi=搜索直连、detailApi=详情直连；两者皆无 → 浏览器渲染 + 响应捕获。
export const TECH_MATRIX: Record<string, { name: string; search: string; detail: string; needLogin: string; best: string }> = {
  vip: {
    name: '唯品会',
    search: '直连接口 rank+list（mapi-pc，登录态 + TLS 伪装，50 pid/批）',
    detail: '直连 detail/main/v6 POST + 浏览器响应捕获兜底',
    needLogin: '必需',
    best: '直连接口最稳：搜索页前端经常不触发商品 XHR，浏览器路径常只拿到 11KB 风控壳页',
  },
  jd: {
    name: '京东',
    search: '浏览器渲染 + 响应捕获（搜索接口需签名，无匿名直连）',
    detail: '详情页 SSR 直连解析（item.m.jd.com 内嵌 _itemOnly）+ 浏览器兜底',
    needLogin: '必需',
    best: '详情走直连最稳；搜索需登录态，浏览器渲染后由响应捕获解析',
  },
  taobao: {
    name: '淘宝/天猫',
    search: 'mtop 签名直连（登录态必需；无登录态返回空自动回退浏览器渲染）',
    detail: '浏览器渲染 + 响应捕获',
    needLogin: '必需',
    best: '登录态下 mtop 直连最快；无登录态只能浏览器渲染（易触发滑块）',
  },
  xianyu: {
    name: '闲鱼',
    search: 'mtop 签名直连（登录态必需；匿名触发 SM 滑块自动回退浏览器）',
    detail: '浏览器渲染 + 响应捕获',
    needLogin: '必需',
    best: '与淘宝同源：登录态 mtop 直连；匿名基本空手而归',
  },
  huawei: {
    name: '华为商城',
    search: '直连接口 openapi.vmall queryPrd（csrfToken + 会话 Cookie，匿名可调）',
    detail: '详情页 SSR 直连解析（comdetail __NEXT_DATA__）',
    needLogin: '不需要',
    best: '全直连即可，搜索/详情接口均匿名可用，字段最全',
  },
  amazon: {
    name: '亚马逊',
    search: '搜索页 SSR HTML 直连解析（海外站走代理）',
    detail: '详情页 SSR 直连（标题/价格/图 + twister 变体）',
    needLogin: '不需要',
    best: 'SSR 直连最稳最快（服务端渲染完整 HTML，无验证码时无需浏览器）',
  },
  suning: {
    name: '苏宁易购',
    search: '搜索页 SSR 商品块直连解析（浏览器 DOM 启发式会产生 228 条噪声，已弃用）',
    detail: '详情页 SSR 直连（var sn 全字段 + clusterMap 变体；SSR 无价格由浏览器渲染补）',
    needLogin: '不需要',
    best: 'SSR 直连；价格字段需浏览器渲染路径补齐',
  },
  pdd: {
    name: '拼多多',
    search: '浏览器渲染 + 响应捕获（接口 anti-content 反爬签名，匿名 403，无直连可行）',
    detail: '浏览器渲染（goods.html 未登录跳登录页）',
    needLogin: '必需',
    best: '登录态浏览器 + 响应捕获是唯一可行路线',
  },
  dewu: {
    name: '得物',
    search: '浏览器渲染尝试（强制移动端画像）——大概率失败',
    detail: '无（H5 详情 302 到 PC 壳页 + App 下载墙）',
    needLogin: '必需（且仍不足）',
    best: '得物没有网页商城（实测）：可行路线仅得物开放平台合作或 App 抓包签名接口，超出本系统能力',
  },
  xiaohongshu: {
    name: '小红书',
    search: '浏览器渲染 + 响应捕获（edith/mall 接口，登录态下页面自身签名）',
    detail: '浏览器渲染 + 响应捕获（详情接口匿名返回 error_code 602）',
    needLogin: '必需',
    best: '登录态浏览器 + 响应捕获；未登录搜索页为登录墙、详情页强制 App 扫码验证',
  },
  douyin: {
    name: '抖音商城',
    search: '浏览器渲染 + 响应捕获（ec.snssdk/jinritemai 接口，登录态）',
    detail: '浏览器渲染 + 响应捕获（抖店商品页未登录弹「页面已下线」）',
    needLogin: '必需',
    best: '登录态浏览器 + 响应捕获；未登录主站搜索为验证码中间页',
  },
  tiktok: {
    name: 'TikTok Shop',
    search: '浏览器渲染 + 响应捕获（需海外住宅代理 + 登录态）',
    detail: '浏览器渲染 + 响应捕获',
    needLogin: '必需（另需住宅代理）',
    best: '网页端被 Security Check 滑块拦截：住宅代理 + 登录态缺一基本空手而归；官方开放 API（partner.tiktokshop.com）是合规路线',
  },
  kuaishou: {
    name: '快手',
    search: '浏览器渲染 + 响应捕获（graphql 接口，登录态下由页面自身请求）',
    detail: '无独立网页商品详情页（商品在短视频/直播组件内）',
    needLogin: '必需',
    best: '登录态浏览器经短视频/直播页采集商品卡，graphql 响应自动解析',
  },
};

/** 平台的最佳技术建议（未知平台返回通用兜底）。 */
export function techAdvice(platformId: string): string {
  return TECH_MATRIX[platformId]?.best || '优先直连接口；接口不可用时浏览器渲染 + 响应捕获兜底';
}

/** 一键测试各步骤使用的技术通道标注（与实际执行路径一致）。 */
export function stepTech(platformId: string, step: 'list' | 'detail' | 'review' | 'qa'): string {
  const cfg = (SCRAPE_CONFIG as any)[platformId] || {};
  if (step === 'list') {
    return cfg.directApi ? '直连接口（失败自动回退浏览器渲染 + 响应捕获）' : '浏览器渲染 + 响应捕获 + DOM/内嵌 JSON 解析';
  }
  if (step === 'detail') {
    return cfg.detailApi ? '详情直连接口（失败回退浏览器响应捕获 + 内嵌 JSON 深搜）' : '浏览器渲染 + 响应捕获 + 内嵌 JSON 深搜';
  }
  return '浏览器渲染 + DOM 启发式抽取（页面 HTML 正则兜底）';
}
