// 浏览器上下文全局增强：generic.ts 里 page.evaluate 使用的 DOM 属性
// （部分属性不在标准 lib.dom 里：innerText 是非标准但广泛支持的属性）
interface Element {
  innerText: string;
  href?: string;
  content?: any;
}

interface Window {
  chrome?: unknown;
}
