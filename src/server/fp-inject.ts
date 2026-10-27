// 浏览器渲染层指纹注入（P1-4）：自研 fingerprint-injector 简化版。
// 背景：scrape 渲染兜底用官方 Chromium，Canvas/WebGL/硬件并发等渲染层指纹是引擎默认值，
// 与请求层注入的 UA/Client Hints 不一致时反而形成「拼接指纹」破绽。
// 本模块按所选设备档案生成一致性覆盖：navigator 平台/语言/硬件 + WebGL 厂商渲染器 +
// Canvas 噪声（每次会话固定种子——同会话稳定、跨会话不同）。
// 原则：只覆盖与档案可推导的字段，不做过度伪装（过度注入 = 新破绽）。

// 档案 → 合理 GPU 组合（UA 的操作系统/浏览器决定 WebGL renderer 语义）
function gpuFor(fp: any) {
  const ua = String(fp.userAgent || '');
  if (/iPhone|iPad/i.test(ua)) {
    return { vendor: 'Apple Inc.', renderer: 'Apple GPU', unmaskedVendor: 'Apple Inc.', unmaskedRenderer: 'Apple GPU' };
  }
  if (/Android/i.test(ua)) {
    // Android 阵营主流 Adreno / Mali
    const gpu = /SM-|Samsung/i.test(ua) ? 'Adreno (TM) 740' : /HUAWEI|HRY-|ALN-|ABR-|GOT-/i.test(ua) ? 'Maleoon 910' : 'Adreno (TM) 750';
    return { vendor: 'Qualcomm', renderer: gpu, unmaskedVendor: 'Qualcomm', unmaskedRenderer: gpu };
  }
  if (/Macintosh/i.test(ua)) {
    return { vendor: 'Apple Inc.', renderer: 'Apple M2', unmaskedVendor: 'Apple Inc.', unmaskedRenderer: 'Apple M2' };
  }
  // Windows：Intel 核显占装机量最大份额（NVIDIA/AMD 独显用户反而是少数）
  const gpus = [
    { vendor: 'Intel', renderer: 'Intel(R) UHD Graphics 770' },
    { vendor: 'Intel', renderer: 'Intel(R) Iris(R) Xe Graphics' },
    { vendor: 'NVIDIA', renderer: 'NVIDIA GeForce GTX 1660 SUPER' },
  ];
  return gpus[0];
}

// 会话内固定随机种子：Canvas 噪声跨请求稳定（同会话=同一台设备），跨会话不同
function seedFrom(fp: any) {
  const s = String(fp.userAgent || '') + '|' + (fp.viewport || []).join('x');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 生成与设备档案一致的渲染层覆盖脚本（addInitScript 注入，文档开始前执行）。
 * 覆盖项：navigator.platform/languages/hardwareConcurrency/deviceMemory、
 * WebGL vendor/renderer（WEBGL_debug_renderer_info 全链路）、Canvas 2D 指纹微噪声、
 * window.chrome 存在性（Chrome 系档案）、screen 尺寸对齐视口。
 */
export function fingerprintInitScript(fp: any): string {
  if (!fp || !fp.userAgent) return ''; // 临时档案/随机化关闭：保持原行为
  const gpu = gpuFor(fp);
  const seed = seedFrom(fp);
  const platform = fp.platform || 'Win32';
  const langs = String(fp.acceptLanguage || 'zh-CN,zh;q=0.9')
    .split(',')
    .map((s) => s.split(';')[0].trim());
  const cores = fp.mobile ? 8 : /Firefox/i.test(fp.userAgent) ? 8 : 16;
  const mem = fp.mobile ? 4 : 8;
  const vw = (fp.viewport || [1280, 800])[0];
  const vh = (fp.viewport || [1280, 800])[1];
  const isChromium = /Chrome|Edg\//.test(fp.userAgent);
  return `(function(){
  try {
    var SEED = ${seed};
    // ---- navigator 一致性 ----
    var def = function(obj, prop, val) { try { Object.defineProperty(obj, prop, { get: function(){ return val; }, configurable: true }); } catch (e) {} };
    def(navigator, 'platform', ${JSON.stringify(platform)});
    def(navigator, 'languages', ${JSON.stringify(langs)});
    def(navigator, 'hardwareConcurrency', ${cores});
    def(navigator, 'deviceMemory', ${mem});
    Object.defineProperty(navigator, 'webdriver', { get: function(){ return undefined; }, configurable: true });
    // 插件：Chromium 桌面有 PDF 插件；移动/非 Chromium 空数组更合理
    def(navigator, 'plugins', ${isChromium && !fp.mobile ? '[{name:"PDF Viewer"},{name:"Chrome PDF Viewer"},{name:"Chromium PDF Viewer"}]' : '[]'});
    ${isChromium ? "if (!window.chrome) window.chrome = { runtime: {} };" : ''}
    // ---- screen 与视口对齐 ----
    try { def(screen, 'width', ${vw}); def(screen, 'height', ${vh}); def(screen, 'availWidth', ${vw}); def(screen, 'availHeight', ${vh - 48}); } catch (e) {}
    // ---- WebGL 一致性（WEBGL_debug_renderer_info 全覆盖 + 参数微整形） ----
    var GPU = ${JSON.stringify(gpu)};
    var patchGetParameter = function(proto) {
      var orig = proto.getParameter;
      proto.getParameter = function(p) {
        // UNMASKED_VENDOR_WEBGL=37445 / UNMASKED_RENDERER_WEBGL=37446 / VENDOR=7936 / RENDERER=7937
        if (p === 37445) return GPU.unmaskedVendor;
        if (p === 37446) return GPU.unmaskedRenderer;
        if (p === 7936) return GPU.vendor;
        if (p === 7937) return GPU.renderer;
        return orig.apply(this, arguments);
      };
    };
    try { patchGetParameter(WebGLRenderingContext.prototype); } catch (e) {}
    try { patchGetParameter(WebGL2RenderingContext.prototype); } catch (e) {}
    // ---- Canvas 2D 微噪声（同会话稳定：seed 驱动的确定扰动） ----
    try {
      var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          var ctx = this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            // 在角落叠一个肉眼不可见的确定性噪声像素，改变哈希但不改观感
            var img = ctx.getImageData(0, 0, 1, 1);
            img.data[0] = (img.data[0] + (SEED & 3)) & 0xff;
            ctx.putImageData(img, 0, 0);
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      };
    } catch (e) {}
  } catch (e) {}
})();`;
}
