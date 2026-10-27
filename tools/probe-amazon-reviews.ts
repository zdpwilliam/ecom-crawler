// 临时探针：拿亚马逊评论页真实 HTML，分析为什么 [data-hook="review"] 为 0
import { loadHtml } from '../src/server/adapters/scrape/generic.ts';
import fs from 'node:fs';

const url = process.argv[2] || 'https://www.amazon.com/product-reviews/B0D1XD1ZV3?pageNumber=1';
console.log('fetching:', url);
const html = await loadHtml(url, 'amazon');
fs.writeFileSync('data/probe/am-rev-probe.html', html);
console.log('html bytes:', html.length);
console.log('data-hook="review" 卡片数:', (html.match(/data-hook="review"/g) || []).length);
console.log('data-hook 出现的钩子类型:', [...new Set((html.match(/data-hook="([^"]+)"/g) || []).map((m) => m))].slice(0, 25).join(' | '));
console.log('机器人特征:', /Enter the characters|automated access|api-services-support/i.test(html) ? '命中（机器人墙）' : '无');
console.log('登录墙特征:', /ap-signin|Sign in/i.test(html) ? '疑似' : '无');
console.log('无评论特征:', /customers talked|条客户评论|no reviews/i.test(html) ? '命中' : '无');
// 标题与正文摘要
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
console.log('title:', title.slice(0, 120));
const bodyText = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
console.log('正文摘要:', bodyText.slice(2000, 2600));
