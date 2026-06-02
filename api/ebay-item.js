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

export default async function handler(req, res) {
  // CORS(同一オリジンだが念のため)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = req.query.url || '';
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
