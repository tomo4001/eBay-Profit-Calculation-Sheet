// =============================================================================
// Vercel Serverless Function: 単一 Fulfillment Policy をフル取得
// GET /api/ebay-policy-detail?id=<fulfillmentPolicyId>
//   → 指定IDのポリシーのフルJSONを返す(構造確認用)
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
// =============================================================================

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

  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'クエリパラメータ ?id=<fulfillmentPolicyId> が必要です' });
    return;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!appId || !certId || !refreshToken) {
    res.status(500).json({ error: 'EBAY_APP_ID / EBAY_CERT_ID / EBAY_REFRESH_TOKEN のいずれかが未設定です。' });
    return;
  }

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy/${encodeURIComponent(id)}`;
    const apiRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      res.status(apiRes.status).json({
        error: `eBay ポリシー取得失敗 (HTTP ${apiRes.status})`,
        detail: text.slice(0, 500),
      });
      return;
    }

    const data = await apiRes.json();
    res.status(200).json(data);

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
