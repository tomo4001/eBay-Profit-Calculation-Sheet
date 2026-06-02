// =============================================================================
// Vercel Serverless Function: eBay 出品情報取得
// GET /api/ebay-item?url=<eBay出品URL>
//   → 商品タイトル / カテゴリーID / 価格+送料(ライバル合計価格) を返す
//
// 必要な環境変数(Vercel Settings → Environment Variables):
//   EBAY_APP_ID   = Production App ID (Client ID)
//   EBAY_CERT_ID  = Production Cert ID (Client Secret)
// =============================================================================

// URL から eBay アイテムID(数値)を抽出
function extractItemId(url) {
  if (!url) return null;
  // 例: https://www.ebay.com/itm/123456789012
  //     https://www.ebay.co.uk/itm/Some-Title/123456789012
  //     https://www.ebay.com/itm/123456789012?hash=...
  const patterns = [
    /\/itm\/(\d{9,15})/,           // /itm/123456789012
    /\/itm\/[^/]+\/(\d{9,15})/,    // /itm/Title/123456789012
    /[?&]item=(\d{9,15})/,         // ?item=123456789012
    /(\d{12,15})/,                 // フォールバック: 12-15桁の数字
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// URL ドメインから eBay マーケットプレイスIDを判定
function detectMarketplace(url) {
  if (!url) return 'EBAY_US';
  if (url.includes('ebay.co.uk')) return 'EBAY_GB';
  if (url.includes('ebay.de')) return 'EBAY_DE';
  if (url.includes('ebay.com.au')) return 'EBAY_AU';
  if (url.includes('ebay.ca')) return 'EBAY_CA';
  if (url.includes('ebay.fr')) return 'EBAY_FR';
  if (url.includes('ebay.it')) return 'EBAY_IT';
  if (url.includes('ebay.es')) return 'EBAY_ES';
  return 'EBAY_US';
}

// eBay OAuth アプリケーショントークン取得(client credentials)
async function getAppToken(appId, certId) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=' +
          encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth失敗 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.access_token;
}

// 📷 汎用 HTML から画像 URL を抽出(eBay 以外のサイト用)
function extractImagesFromHtml(html, baseUrl) {
  const urls = new Set();
  const addAbs = (raw) => {
    if (!raw) return;
    let u = raw.trim();
    if (!u || u.startsWith('data:')) return;
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) {
      try { u = new URL(baseUrl).origin + u; } catch (e) { return; }
    } else if (!/^https?:/i.test(u)) {
      try { u = new URL(u, baseUrl).href; } catch (e) { return; }
    }
    urls.add(u);
  };

  // og:image / og:image:secure_url / og:image:url
  const ogRegex = /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/gi;
  let m;
  while ((m = ogRegex.exec(html)) !== null) addAbs(m[1]);
  const ogRegex2 = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url|:url)?["']/gi;
  while ((m = ogRegex2.exec(html)) !== null) addAbs(m[1]);

  // twitter:image
  const twRegex = /<meta[^>]+(?:name|property)=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = twRegex.exec(html)) !== null) addAbs(m[1]);

  // JSON-LD product images
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(m[1].trim());
      const collect = (obj) => {
        if (obj == null) return;
        if (typeof obj === 'string') {
          if (/^https?:\/\//.test(obj) && /\.(jpg|jpeg|png|webp|gif|avif)/i.test(obj)) addAbs(obj);
          return;
        }
        if (Array.isArray(obj)) { obj.forEach(collect); return; }
        if (typeof obj === 'object') {
          if (obj.image) collect(obj.image);
          if (obj.url && obj['@type'] && /image/i.test(obj['@type'])) collect(obj.url);
          if (obj['@graph']) collect(obj['@graph']);
        }
      };
      collect(ld);
    } catch (e) {}
  }

  // <img src/data-src/data-zoom-image/...>
  const imgRegex = /<img[^>]+(?:src|data-src|data-zoom-image|data-large|data-original|data-lazy)=["']([^"']+)["']/gi;
  while ((m = imgRegex.exec(html)) !== null) {
    const src = m[1];
    if (/icon|logo|sprite|spacer|placeholder|loading/i.test(src)) continue;
    if (/\.svg(\?|$)/i.test(src)) continue;
    addAbs(src);
  }

  // 🔍 Aggressive: HTML 全体から画像 URL パターンをスキャン
  // (Next.js の __NEXT_DATA__ / SPA の inline JSON に埋め込まれた画像 URL を拾う)
  // パターン: https?://...拡張子.jpg|jpeg|png|webp|gif|avif (クエリ任意)
  const aggressiveRegex = /https?:\\?\/\\?\/[^"'\s<>(){}\[\]]+?\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^"'\s<>(){}\[\]]*)?/gi;
  while ((m = aggressiveRegex.exec(html)) !== null) {
    // JSON 内のエスケープを除去(\/  → /)
    let u = m[0].replace(/\\\//g, '/');
    // 細かい除外: アイコン, ロゴ, プレースホルダ, アバター, OG 画像のサイズ違いコピー等は別途排除
    if (/icon|logo|sprite|spacer|placeholder|loading|favicon/i.test(u)) continue;
    // アバター / プロフィール画像系は除外(個別商品とは無関係)
    if (/avatar|profile|user[-_]?img/i.test(u)) continue;
    addAbs(u);
  }

  // 🔍 メルカリ / 主要 CDN の URL を念のため別途検出(拡張子なしの場合あり)
  // 例: https://static.mercdn.net/item/detail/orig/photos/m123456789_1.jpg
  //     https://static.mercdn.net/c!/.../photos/m123_1
  const cdnPatterns = [
    /https?:\\?\/\\?\/static\.mercdn\.net\/[^"'\s<>(){}\[\]]+/gi,        // メルカリ
    /https?:\\?\/\\?\/[^"'\s<>(){}\[\]]*?\.akamaized\.net\/[^"'\s<>(){}\[\]]+/gi,  // Akamai CDN
    /https?:\\?\/\\?\/[^"'\s<>(){}\[\]]*?\.cloudfront\.net\/[^"'\s<>(){}\[\]]+/gi, // CloudFront
  ];
  for (const re of cdnPatterns) {
    while ((m = re.exec(html)) !== null) {
      let u = m[0].replace(/\\\//g, '/');
      if (/icon|logo|sprite|favicon|avatar|profile/i.test(u)) continue;
      // 末尾のクォート文字などの除去
      u = u.replace(/[,;)\]}'"`]+$/, '');
      addAbs(u);
    }
  }

  return Array.from(urls);
}

function extractTitleFromHtml(html) {
  let t = '';
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m) t = m[1];
  if (!t) {
    m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) t = m[1];
  }
  return t.trim();
}

export default async function handler(req, res) {
  // CORS(同一オリジンだが念のため)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = req.query.url || '';
  if (!url) {
    res.status(400).json({ error: 'URL を指定してください' });
    return;
  }

  // 📷 eBay 以外: 汎用 HTML 抽出モード
  const isEbay = /(^|\.)ebay\./i.test(url);
  if (!isEbay) {
    try {
      const htmlRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
        },
        redirect: 'follow',
      });
      if (!htmlRes.ok) {
        res.status(htmlRes.status).json({ error: `HTML 取得失敗 (HTTP ${htmlRes.status})`, url });
        return;
      }
      const html = await htmlRes.text();
      const imageUrls = extractImagesFromHtml(html, url);
      const title = extractTitleFromHtml(html);
      res.status(200).json({
        ok: true,
        generic: true,
        title,
        imageUrls,
        imageCount: imageUrls.length,
      });
      return;
    } catch (e) {
      res.status(500).json({ error: '汎用 HTML 取得エラー: ' + (e.message || String(e)), url });
      return;
    }
  }

  // 以下、eBay モード(既存処理)
  const itemId = extractItemId(url);
  if (!itemId) {
    res.status(400).json({ error: 'eBayアイテムIDをURLから抽出できませんでした。URLを確認してください。' });
    return;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) {
    res.status(500).json({ error: 'サーバー側に EBAY_APP_ID / EBAY_CERT_ID が設定されていません(Vercel環境変数)。' });
    return;
  }

  const marketplace = detectMarketplace(url);

  try {
    const token = await getAppToken(appId, certId);

    // Browse API: legacy item ID で取得
    const apiUrl = `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${itemId}`;
    const itemRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        'Content-Type': 'application/json',
      },
    });

    if (!itemRes.ok) {
      const text = await itemRes.text();
      res.status(itemRes.status).json({
        error: `eBay商品取得失敗 (HTTP ${itemRes.status})`,
        detail: text.slice(0, 300),
        itemId, marketplace,
      });
      return;
    }

    const item = await itemRes.json();

    // 価格(商品本体)
    const priceValue = item.price && item.price.value ? parseFloat(item.price.value) : 0;
    const priceCurrency = item.price && item.price.currency ? item.price.currency : '';

    // 送料(最安の配送オプション)
    let shipping = 0;
    if (Array.isArray(item.shippingOptions) && item.shippingOptions.length > 0) {
      const costs = item.shippingOptions
        .map(o => (o.shippingCost && o.shippingCost.value != null) ? parseFloat(o.shippingCost.value) : null)
        .filter(v => v != null);
      if (costs.length > 0) shipping = Math.min(...costs);
    }

    const total = priceValue + shipping;

    // カテゴリーID(leaf category)
    let categoryId = '';
    if (item.categoryId) {
      categoryId = String(item.categoryId);
    } else if (Array.isArray(item.categoryPath) && item.categoryPath.length > 0) {
      // フォールバック
      categoryId = '';
    }

    // 📷 画像 URL 一覧(メイン + 追加画像)
    // 可能なら最高画質バリアント(eBay の場合 s-l1600 等)に置換
    const upscaleEbayImage = (u) => {
      if (!u) return u;
      // i.ebayimg.com の URL は s-l64, s-l140, s-l500, s-l1600 等のサイズ指定がある
      return u.replace(/s-l\d+\./i, 's-l1600.');
    };
    const imageUrls = [];
    if (item.image && item.image.imageUrl) imageUrls.push(upscaleEbayImage(item.image.imageUrl));
    if (Array.isArray(item.additionalImages)) {
      item.additionalImages.forEach(img => {
        if (img && img.imageUrl) imageUrls.push(upscaleEbayImage(img.imageUrl));
      });
    }

    res.status(200).json({
      ok: true,
      itemId,
      marketplace,
      title: item.title || '',
      categoryId,
      categoryPath: item.categoryPath || '',
      price: priceValue,
      shipping,
      total,                 // ライバル合計価格(価格 + 送料)
      currency: priceCurrency,
      imageUrls,             // 📷 画像 URL 一覧(高画質版)
      imageCount: imageUrls.length,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e), itemId, marketplace });
  }
}
