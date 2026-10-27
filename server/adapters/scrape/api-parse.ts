// 数据接口响应 → 结构化商品（供「直连接口」与「浏览器捕获」两条路径共用）。
// 兼容 JSONP 与纯 JSON；深搜「长得像商品的对象」，字段名灵活映射（不同平台接口结构不同）。
export function apiProductsFromBodies(apiBodies) {
  const raw = [];
  const seen = new Set();
  const num = (v) => {
    if (v && typeof v === 'object') return 0;
    const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const pick = (o, keys) => {
    for (const k of keys) {
      let v = k.split('.').reduce((a, p) => (a && a[p] != null ? a[p] : undefined), o);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        v = pick(v, ['vipPrice', 'marketPrice', 'price', 'value', 'text']);
      }
      if (v != null && v !== '') return v;
    }
    return undefined;
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const id = pick(node, ['productId', 'merchandiseId', 'productIdStr', 'pid', 'itemId', 'goodsId']);
    const title = pick(node, ['title', 'productName', 'smallName', 'goodsName']);
    if (id && title && !seen.has(String(id))) {
      seen.add(String(id));
      const brandId = pick(node, ['brandId']);
      // 类目优先取 attrs 里的「主分类」（唯品会 list/v2 结构），退回 category* 字段
      let cat = '';
      if (Array.isArray(node.attrs)) {
        const m = node.attrs.find((a) => a && typeof a === 'object' && /主分类|品类|分类/.test(String(a.name || '')));
        if (m) cat = String(m.value || '');
      }
      if (!cat) cat = String(pick(node, ['categoryName', 'firstCateName', 'cateName', 'firstCategoryName', 'category']) || '');
      raw.push({
        itemId: String(id),
        title: String(title),
        brand: String(pick(node, ['brandShowName', 'brandName', 'brandStoreName', 'brand']) || ''),
        shop: String(pick(node, ['brandShowName', 'brandStoreName', 'vendorName', 'storeName', 'shopName']) || ''),
        category: cat,
        price: num(pick(node, ['price.salePrice', 'salePrice', 'price.vipPrice', 'vipPrice', 'price', 'priceInfo.vipPrice'])),
        marketPrice: num(pick(node, ['price.marketPrice', 'marketPrice', 'originalPrice', 'refPrice'])),
        discount: String(pick(node, ['price.saleDiscount', 'saleDiscount', 'price.discount', 'discount', 'discountText']) || ''),
        sales: num(pick(node, ['soldQuantity', 'salesNum', 'saleNum', 'commentNum', 'commentCount', 'buyCount'])),
        url: String(pick(node, ['url', 'detailUrl', 'link']) || (brandId ? `https://detail.vip.com/detail-${brandId}-${id}.html` : '')),
        image: String(pick(node, ['smallImage', 'image', 'img', 'squareImage', 'logo', 'imageUrl', 'pic']) || ''),
      });
    }
    Object.values(node).forEach(visit);
  };
  for (const { body } of apiBodies || []) {
    try {
      let text = String(body).trim();
      const s = text.indexOf('(');
      const e = text.lastIndexOf(')');
      if (s > 0 && e > s && /^[a-zA-Z_$][\w$]*$/.test(text.slice(0, s))) text = text.slice(s + 1, e); // JSONP 去壳
      visit(JSON.parse(text));
    } catch {
      /* 非商品数据/解析失败跳过 */
    }
  }
  return raw;
}

/** 把解析出的原始商品映射为标准入库结构（与 normalizeProducts 同形，字段更全）。 */
export function mapApiProducts(raw, cfg, platformId) {
  return raw.map((r, i) => ({
    id: `scrape-${cfg.name}-${r.itemId}-${i}`,
    platform: platformId,
    platformName: cfg.name,
    itemId: r.itemId,
    shopName: r.shop,
    title: r.title,
    price: r.price,
    currency: cfg.currency || 'CNY',
    category: r.category,
    brand: r.brand,
    sales: r.sales,
    stock: 0,
    url: r.url,
    images: r.image ? [r.image] : [],
    specs: {
      ...(r.marketPrice ? { marketPrice: r.marketPrice } : {}),
      ...(r.discount ? { discount: r.discount } : {}),
      ...(r.extra || {}),
    },
    collectedAt: new Date().toISOString(),
  }));
}

/**
 * 从详情页接口响应 / 页面内嵌 JSON 中深搜 SPU（商品级）与 SKU（规格组合）信息。
 * 兼容 JSONP 与纯 JSON；字段名灵活匹配（不同平台结构不同）：
 *  - SKU 识别：对象含 skuId/sku 标识，或（size/color 类规格字段 + 价格）；
 *  - SPU 识别：对象含 productId/merchandiseId/spuId + 标题类字段（且无规格字段）。
 * @returns {{ spu: object|null, spus: Array, skus: Array }}
 */
export function spuSkuFromBodies(apiBodies) {
  const spus = [];
  const skus = [];
  const seenSpu = new Set();
  const seenSku = new Set();
  const num = (v) => {
    if (v && typeof v === 'object') return 0;
    const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const pick = (o, keys) => {
    for (const k of keys) {
      let v = k.split('.').reduce((a, p) => (a && a[p] != null ? a[p] : undefined), o);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        v = pick(v, ['vipPrice', 'marketPrice', 'price', 'value', 'text']);
      }
      if (v != null && v !== '') return v;
    }
    return undefined;
  };
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    const skuId = pick(node, ['skuId', 'skuIdStr', 'productSkuId', 'sku']);
    const size = pick(node, ['size', 'sizeName', 'sizeValue', 'dimension']);
    const color = pick(node, ['color', 'colorName', 'colorValue']);
    const spuId = pick(node, ['productId', 'merchandiseId', 'productIdStr', 'spuId', 'brandProductId']);
    const title = pick(node, ['title', 'productName', 'goodsName', 'merchandiseName', 'smallName']);
    const hasPrice =
      pick(node, ['price.salePrice', 'salePrice', 'price.vipPrice', 'vipPrice', 'price.marketPrice', 'marketPrice', 'price']) != null;

    // SKU：有 sku 标识，或有规格字段且带价格（避免把 SPU 自身当 SKU——SPU 无规格字段）
    if ((skuId || ((size || color) && hasPrice)) && (skuId || size || color)) {
      const key = String(skuId || `${size}|${color}`);
      if (!seenSku.has(key)) {
        seenSku.add(key);
        skus.push({
          skuId: skuId ? String(skuId) : '',
          spuId: spuId ? String(spuId) : '',
          size: size ? String(size) : '',
          color: color ? String(color) : '',
          price: num(pick(node, ['price.salePrice', 'salePrice', 'price.vipPrice', 'vipPrice', 'price'])),
          marketPrice: num(pick(node, ['price.marketPrice', 'marketPrice'])),
          stock: num(pick(node, ['stock', 'stockNum', 'leftNum', 'amount'])),
          image: String(pick(node, ['smallImage', 'image', 'img', 'pic', 'skuImage']) || ''),
        });
      }
    }
    // SPU：商品级对象（有商品 id + 标题，无规格字段）
    if (spuId && title && !size && !color && !seenSpu.has(String(spuId))) {
      seenSpu.add(String(spuId));
      spus.push({
        spuId: String(spuId),
        title: String(title),
        brand: String(pick(node, ['brandShowName', 'brandName', 'brandStoreName', 'brand']) || ''),
        category: String(pick(node, ['categoryName', 'firstCateName', 'cateName', 'category']) || ''),
        price: num(pick(node, ['price.salePrice', 'salePrice', 'price'])),
        image: String(pick(node, ['smallImage', 'image', 'img', 'pic']) || ''),
      });
    }
    Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  for (const { body } of apiBodies || []) {
    try {
      let text = String(body).trim();
      const s = text.indexOf('(');
      const e = text.lastIndexOf(')');
      if (s > 0 && e > s && /^[a-zA-Z_$][\w$]*$/.test(text.slice(0, s))) text = text.slice(s + 1, e); // JSONP 去壳
      visit(JSON.parse(text), 0);
    } catch {
      /* 非商品数据/解析失败跳过 */
    }
  }
  return { spu: spus[0] || null, spus, skus };
}
