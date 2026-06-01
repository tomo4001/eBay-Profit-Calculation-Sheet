// =============================================================================
// Vercel Serverless Function: eBay Fulfillment Policy 削除 (DELETE)
//
// POST /api/ebay-policy-delete
//   body: { policyId: "xxx" }
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
//
// ⚠️ 注意: 削除は取り消し不可。リスティングが紐づいているポリシーは削除できない。
// =============================================================================

async function getAccessToken(appId, certId, refreshToken) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const scopes = 'https://api.ebay.com/oauth/api_scope/sell.account';
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST のみ対応' });
    return;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;
  if (!appId || !certId || !refreshToken) {
    res.status(500).json({ error: '環境変数(EBAY_APP_ID/CERT_ID/REFRESH_TOKEN)が未設定' });
    return;
  }

  const body = req.body || {};
  const policyId = body.policyId;
  if (!policyId) { res.status(400).json({ error: 'policyId が必要' }); return; }

  // ローカル専用 ID (local_new_*) は eBay に存在しないので拒否
  if (typeof policyId === 'string' && policyId.startsWith('local_new_')) {
    res.status(400).json({
      ok: false,
      error: 'ローカル専用ポリシー(local_new_*)は eBay に存在しないため API 削除不要です',
      policyId,
    });
    return;
  }

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy/${encodeURIComponent(policyId)}`;
    const apiRes = await fetch(apiUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    // DELETE は通常 204 No Content
    if (apiRes.status === 204 || apiRes.status === 200) {
      res.status(200).json({
        ok: true,
        policyId,
        status: apiRes.status,
        message: '✓ eBay 上のポリシーを削除しました',
      });
      return;
    }

    // エラーレスポンスを解析
    const text = await apiRes.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}

    // 404: 既に削除されている or 存在しない
    if (apiRes.status === 404) {
      res.status(200).json({
        ok: true,
        policyId,
        status: 404,
        notFound: true,
        message: '⚪ eBay 上にこのポリシーは存在しません(既に削除済み)',
      });
      return;
    }

    res.status(apiRes.status).json({
      ok: false,
      policyId,
      status: apiRes.status,
      error: `eBay DELETE 失敗 (HTTP ${apiRes.status})`,
      detail: json || text.slice(0, 1500),
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e), policyId });
  }
}
