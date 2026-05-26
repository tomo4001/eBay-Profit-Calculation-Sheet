// =============================================================================
// Vercel Serverless Function: 既存ポリシーから配送サービスコードを抽出
// GET /api/ebay-shipping-services
//   → Hartuoさんの全ポリシー(EBAY_US)から実際使われている shippingServiceCode を
//     Domestic / International 別に集計して返す
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

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    // 全ポリシー取得
    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplace)}`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });
    if (!apiRes.ok) {
      const text = await apiRes.text();
      res.status(apiRes.status).json({ error: `ポリシー取得失敗 (HTTP ${apiRes.status})`, detail: text.slice(0, 300) });
      return;
    }
    const data = await apiRes.json();
    const policies = data.fulfillmentPolicies || [];

    // shippingServiceCode を Domestic / International 別に集計
    const domesticMap = new Map();
    const intlMap = new Map();

    policies.forEach(p => {
      (p.shippingOptions || []).forEach(opt => {
        const isInternational = opt.optionType === 'INTERNATIONAL';
        const target = isInternational ? intlMap : domesticMap;
        (opt.shippingServices || []).forEach(s => {
          const code = s.shippingServiceCode;
          if (!code) return;
          if (!target.has(code)) {
            target.set(code, {
              code,
              carrier: s.shippingCarrierCode || '',
              usageCount: 0,
              examplePolicy: p.name,
              exampleCost: s.shippingCost && s.shippingCost.value,
            });
          }
          target.get(code).usageCount++;
        });
      });
    });

    // 配列化(使用回数の多い順)
    const sortByUsage = (a, b) => b.usageCount - a.usageCount;
    const domesticServices = Array.from(domesticMap.values()).sort(sortByUsage);
    const internationalServices = Array.from(intlMap.values()).sort(sortByUsage);

    res.status(200).json({
      ok: true,
      marketplace,
      totalPolicies: policies.length,
      domesticServices: {
        total: domesticServices.length,
        services: domesticServices,
      },
      internationalServices: {
        total: internationalServices.length,
        services: internationalServices,
      },
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
