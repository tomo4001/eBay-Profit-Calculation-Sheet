// =============================================================================
// Vercel Serverless Function: eBay Fulfillment Policy 一覧取得
// GET /api/ebay-policies-list[?marketplace=EBAY_US]
//   → User Token を refresh_token から自動取得 → ポリシー一覧を JSON で返す
//
// 必要な環境変数(Vercel):
//   EBAY_APP_ID
//   EBAY_CERT_ID
//   EBAY_REFRESH_TOKEN  ← /api/ebay-oauth-callback で取得して手動で設定
// =============================================================================

// refresh_token から access_token を取得(2時間有効)
async function getAccessToken(appId, certId, refreshToken) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const scopes = 'https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.account.readonly';

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!appId || !certId) {
    res.status(500).json({ error: 'サーバー側に EBAY_APP_ID / EBAY_CERT_ID が未設定です。' });
    return;
  }
  if (!refreshToken) {
    res.status(500).json({
      error: 'サーバー側に EBAY_REFRESH_TOKEN が未設定です。',
      hint: 'まず /api/ebay-oauth-start にブラウザでアクセスして認証してください。'
    });
    return;
  }

  const marketplace = req.query.marketplace || 'EBAY_US';

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplace)}`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      res.status(apiRes.status).json({
        error: `eBay ポリシー取得失敗 (HTTP ${apiRes.status})`,
        detail: text.slice(0, 500),
        marketplace,
      });
      return;
    }

    const data = await apiRes.json();

    // 件数のサマリと、わかりやすく整形して返す
    const policies = data.fulfillmentPolicies || [];

    res.status(200).json({
      ok: true,
      marketplace,
      total: policies.length,
      hint: '生データを確認したい場合は raw を見てください',
      summary: policies.map(p => ({
        id: p.fulfillmentPolicyId,
        name: p.name,
        handlingTime: p.handlingTime,
        shippingOptionsCount: (p.shippingOptions || []).length,
        excludedCountries: ((p.shipToLocations && p.shipToLocations.regionExcluded) || []).map(r => r.regionName),
      })),
      raw: data,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
