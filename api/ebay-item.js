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
// Amazon の同一画像複数サイズを正規化(._SX300_.jpg → .jpg)
function normalizeForDedup(u) {
  // Amazon: 画像 ID は同じ、サイズ指定 (._SX300_, ._SL1500_, ._AC_UF1000,1000_QL80_) が違うだけ
  return u.replace(/\._[A-Z0-9,_]+_\./gi, '.');
}

function extractImagesFromHtml(html, baseUrl) {
  const urls = new Set();
  const seenNormalized = new Set();  // 重複検出用(正規化後)
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
    // 重複チェック(正規化後 = Amazon の異なるサイズも同じものとみなす)
    const norm = normalizeForDedup(u);
    if (seenNormalized.has(norm)) return;
    seenNormalized.add(norm);
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

  // 🆕 __NEXT_DATA__ (Next.js / メルカリ等)を明示パース
  // 構造の中から画像 URL らしき文字列を再帰的に抽出
  const nextDataMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const nd = JSON.parse(nextDataMatch[1].trim());
      const collect = (obj) => {
        if (obj == null) return;
        if (typeof obj === 'string') {
          // 画像 URL パターン or 既知の CDN
          if (/^https?:\/\//.test(obj)) {
            if (/\.(jpg|jpeg|png|webp|gif|avif)(\?|$)/i.test(obj)) addAbs(obj);
            else if (/static\.mercdn\.net|mercari/i.test(obj)) addAbs(obj);
            else if (/m\.media-amazon\.com\/images/i.test(obj)) addAbs(obj);
          }
          return;
        }
        if (Array.isArray(obj)) { obj.forEach(collect); return; }
        if (typeof obj === 'object') {
          // 既知のキー名を優先(image, photo, photos, imageUrl 等)
          ['image','images','photo','photos','imageUrl','imageUri','uri','src'].forEach(k => {
            if (obj[k]) collect(obj[k]);
          });
          // それ以外も再帰
          Object.values(obj).forEach(collect);
        }
      };
      collect(nd);
    } catch (e) {}
  }

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

  // 🆕 画像プロキシモード: ?proxy=<imageUrl> で画像バイナリを CORS 付きで返す
  // (Yahoo Shopping 等で直接 fetch が CORS で失敗する場合のフォールバック)
  const proxyUrl = req.query.proxy || '';
  if (proxyUrl) {
    try {
      // Referer は元サイトのドメインを推測(Mercari の画像は Referer 必須の場合あり)
      let referer = '';
      try {
        const u = new URL(proxyUrl);
        referer = u.origin + '/';
      } catch (e) {}
      const imgRes = await fetch(proxyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          ...(referer ? { 'Referer': referer } : {}),
        },
        redirect: 'follow',
      });
      if (!imgRes.ok) {
        res.status(imgRes.status).json({ error: `画像取得失敗 HTTP ${imgRes.status}`, url: proxyUrl });
        return;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ct = imgRes.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(200).send(buf);
      return;
    } catch (e) {
      res.status(500).json({ error: '画像プロキシエラー: ' + (e.message || String(e)), url: proxyUrl });
      return;
    }
  }

  const url = req.query.url || '';
  if (!url) {
    res.status(400).json({ error: 'URL を指定してください' });
    return;
  }

  // 📷 メルカリ専用: URL パターン推測で画像取得(HTML 解析より確実)
  // 例: https://jp.mercari.com/item/m12345678 → m{id}_1.jpg, _2.jpg, ... を順次ヒット
  const mercariMatch = url.match(/(?:mercari\.com|mercari\.jp)\/(?:item|jp\/items)\/(m\d+)/i)
                     || url.match(/jp\.mercari\.com\/item\/(m\d+)/i);
  if (mercariMatch) {
    const itemId = mercariMatch[1];
    const imageUrls = [];
    // CDN の orig サイズで取得
    const maxImages = 20;  // 最大 20 枚試す
    for (let i = 1; i <= maxImages; i++) {
      const imgUrl = `https://static.mercdn.net/item/detail/orig/photos/${itemId}_${i}.jpg`;
      try {
        const r = await fetch(imgUrl, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://jp.mercari.com/',
          },
        });
        if (r.ok) {
          imageUrls.push(imgUrl);
        } else {
          // 404 = この index 以降は画像なし
          break;
        }
      } catch (e) {
        break;
      }
    }
    if (imageUrls.length === 0) {
      // fallback: アイテムが存在しない or 別の URL パターン
      res.status(200).json({
        ok: false,
        error: 'メルカリの画像が取得できませんでした(商品 ID パターン違いかも)',
        url, itemId,
      });
      return;
    }
    res.status(200).json({
      ok: true,
      mercari: true,
      itemId,
      title: 'mercari_' + itemId,
      imageUrls,
      imageCount: imageUrls.length,
    });
    return;
  }

  // 📷 eBay 以外: 汎用 HTML 抽出モード
  const isEbay = /(^|\.)ebay\./i.test(url);
  if (!isEbay) {
    try {
      // 🆕 ブラウザに近いヘッダー(WAF / bot 防御の bypass を試みる)
      const htmlRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'max-age=0',
          'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Dnt': '1',
        },
        redirect: 'follow',
      });
      if (!htmlRes.ok) {
        res.status(htmlRes.status).json({ error: `HTML 取得失敗 (HTTP ${htmlRes.status})`, url });
        return;
      }
      // 🆕 Content-Type の charset を読み取って正しく decode
      // (楽天は EUC-JP、Yahoo の一部は Shift_JIS など)
      const contentType = htmlRes.headers.get('content-type') || '';
      const charsetMatch = contentType.match(/charset=([^;]+)/i);
      let charset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : 'utf-8';
      // 別名を統一
      if (charset === 'sjis' || charset === 'shift-jis') charset = 'shift_jis';
      if (charset === 'eucjp') charset = 'euc-jp';

      const arrayBuf = await htmlRes.arrayBuffer();
      let html;
      try {
        const decoder = new TextDecoder(charset, { fatal: false });
        html = decoder.decode(arrayBuf);
      } catch (e) {
        // 不明な charset → utf-8 にフォールバック
        html = new TextDecoder('utf-8', { fatal: false }).decode(arrayBuf);
      }

      // HTML 内の <meta charset> も確認(http header と違うことがある)
      const metaCharsetMatch = html.match(/<meta[^>]+charset=["']?([^"'\s/>]+)/i);
      if (metaCharsetMatch) {
        let metaCharset = metaCharsetMatch[1].trim().toLowerCase();
        if (metaCharset === 'sjis' || metaCharset === 'shift-jis') metaCharset = 'shift_jis';
        if (metaCharset === 'eucjp') metaCharset = 'euc-jp';
        if (metaCharset !== charset) {
          // 再デコード
          try {
            html = new TextDecoder(metaCharset, { fatal: false }).decode(arrayBuf);
            charset = metaCharset;
          } catch (e) {}
        }
      }

      // 🆕 WAF / bot 防御ブロック検出(HTML サイズが極端に小さい)
      const isLikelyBlocked =
        html.length < 2000 && (
          /reference\s*#\d+\.[a-f0-9.]+/i.test(html) ||  // Akamai
          /access denied|forbidden|blocked|captcha|cloudflare|datadome|imperva/i.test(html) ||
          /you (have been|are) blocked/i.test(html)
        );
      if (isLikelyBlocked) {
        res.status(200).json({
          ok: false,
          blocked: true,
          error: 'このサイトは bot 防御(WAF)でサーバーからのアクセスをブロックしています。残念ながら自動取得できません。',
          url,
          diagnostics: {
            htmlSize: html.length,
            contentType,
            detectedCharset: charset,
            sampleHtmlStart: html.slice(0, 400),
          },
        });
        return;
      }

      let imageUrls = extractImagesFromHtml(html, url);
      const title = extractTitleFromHtml(html);

      // 🆕 楽天専用フィルタ: 商品画像ドメインだけに絞る
      // image.rakuten.co.jp と shop.r10s.jp が商品画像のホスト
      // r.r10s.jp(バナー)、anz.rd.rakuten.co.jp(広告)、ashiato.rakuten.co.jp(追跡)等は除外
      if (/(^|\.)rakuten\.co\.jp/i.test(url)) {
        imageUrls = imageUrls.filter(u => {
          // 商品画像ドメイン(これらだけ残す)
          if (/^https?:\/\/(image\.rakuten\.co\.jp|shop\.r10s\.jp)\//i.test(u)) return true;
          // それ以外(バナー、広告等)は除外
          return false;
        });
        // Rakuten では cabinet パスが商品画像の典型(banner や headline 画像は除外)
        // ヘッドライン用と思しき headline / banner / category 等を更に除外
        imageUrls = imageUrls.filter(u => {
          if (/\/(headline|banner|category|rank|navi|left-navi)\//i.test(u)) return false;
          return true;
        });
      }

      const responseBody = {
        ok: true,
        generic: true,
        title,
        imageUrls,
        imageCount: imageUrls.length,
      };
      // 🆕 0 件抽出時は診断情報を含める
      if (imageUrls.length === 0) {
        responseBody.diagnostics = {
          htmlSize: html.length,
          contentType,
          detectedCharset: charset,
          sampleHtmlStart: html.slice(0, 800),
        };
      }
      res.status(200).json(responseBody);
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
