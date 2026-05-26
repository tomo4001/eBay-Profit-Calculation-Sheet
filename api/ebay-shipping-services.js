// =============================================================================
// Vercel Serverless Function: eBay Shipping Service マスタ取得
// GET /api/ebay-shipping-services[?marketplace=EBAY_US&type=domestic|international|all]
//   → eBay が認める配送サービスコード全件
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
// =============================================================================

async function getAccessToken(appId, certId, refreshToken) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const scopes = 'https://api.ebay.com/oauth/api_scope/sell.account.readonly';

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Access Token取得失敗 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;
  if (!appId || !certId || !refreshToken) {
    res.status(500).json({ error: 'EBAY_APP_ID / EBAY_CERT_ID / EBAY_REFRESH_TOKEN のいずれかが未設定です。' });
    return;
  }

  const marketplace = req.query.marketplace || 'EBAY_US';
  const typeFilter = (req.query.type || 'all').toLowerCase();

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    // Sell Metadata API: get_shipping_service_details
    const apiUrl = `https://api.ebay.com/sell/metadata/v1/marketplace/${encodeURIComponent(marketplace)}/get_shipping_service_details`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
      },
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      res.status(apiRes.status).json({
        error: `eBay metadata 取得失敗 (HTTP ${apiRes.status})`,
        detail: text.slice(0, 500),
      });
      return;
    }

    const data = await apiRes.json();
    let services = data.shippingServices || [];

    // type フィルタ
    if (typeFilter === 'domestic') {
      services = services.filter(s => s.internationalService === false);
    } else if (typeFilter === 'international') {
      services = services.filter(s => s.internationalService === true);
    }

    // 整形して返す(画面で扱いやすい形)
    const simplified = services.map(s => ({
      code: s.shippingServiceCode,
      description: s.description,
      carrier: s.shippingCarrier,
      isInternational: s.internationalService,
      dimensionsRequired: s.dimensionsRequired,
      weightRequired: s.weightRequired,
      validForSellingFlow: s.validForSellingFlow,
      // 配送日数情報があれば
      deliveryEstimate: s.deliveryEstimate || null,
    }));

    res.status(200).json({
      ok: true,
      marketplace,
      typeFilter,
      total: simplified.length,
      services: simplified,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
