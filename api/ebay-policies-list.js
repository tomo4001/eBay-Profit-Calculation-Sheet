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

    // 🔄 ページネーション対応: limit=200(eBayの最大値) で全件取得
    const allPolicies = [];
    let offset = 0;
    const limit = 200;
    let totalReported = null;
    let pages = 0;
    const maxPages = 20; // 安全上限(=最大 4000 件)

    while (pages < maxPages) {
      const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplace)}&limit=${limit}&offset=${offset}`;
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
          offset,
          collectedSoFar: allPolicies.length,
        });
        return;
      }

      const data = await apiRes.json();
      const policies = data.fulfillmentPolicies || [];
      if (totalReported == null && typeof data.total === 'number') totalReported = data.total;

      allPolicies.push(...policies);
      pages++;

      // 次ページがあるか判定:
      //   - data.next (eBay が返す次URL) があれば続く
      //   - もしくは取得件数が limit 以上なら次ページを試す
      //   - 取得件数が limit 未満なら最終ページ
      if (policies.length < limit) break;
      offset += limit;
    }

    // 📊 Rate Table 一覧も取得（v1）
    let rateTables = [];
    try {
      const rateTableUrl = `https://api.ebay.com/sell/account/v1/rate_table?country_code=${marketplace === 'EBAY_US' ? 'US' : 'GB'}`;
      const rateTableRes = await fetch(rateTableUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (rateTableRes.ok) {
        const rateTableData = await rateTableRes.json();
        rateTables = rateTableData.rateTables || [];

        // 📊 各 Rate Table の詳細を取得（v2）
        const rateTableDetails = [];
        for (const rt of rateTables) {
          try {
            const detailUrl = `https://api.ebay.com/sell/account/v2/rate_table/${encodeURIComponent(rt.rateTableId)}`;
            const detailRes = await fetch(detailUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
              },
            });

            if (detailRes.ok) {
              const detail = await detailRes.json();
              rateTableDetails.push({
                ...rt,
                detail: detail  // 詳細データを追加
              });
            } else {
              rateTableDetails.push(rt);  // 詳細取得失敗時は基本情報のみ
            }
          } catch (e) {
            rateTableDetails.push(rt);  // エラー時は基本情報のみ
          }
        }
        rateTables = rateTableDetails;
      }
    } catch (e) {
      console.warn('[Rate Table 取得] エラー:', e.message);
      // Rate Table 取得失敗時も続行
    }

    res.status(200).json({
      ok: true,
      marketplace,
      total: allPolicies.length,
      pages,
      reportedTotal: totalReported,
      hint: '生データを確認したい場合は raw を見てください',
      summary: allPolicies.map(p => ({
        id: p.fulfillmentPolicyId,
        name: p.name,
        handlingTime: p.handlingTime,
        shippingOptionsCount: (p.shippingOptions || []).length,
        excludedCountries: ((p.shipToLocations && p.shipToLocations.regionExcluded) || []).map(r => r.regionName),
      })),
      raw: {
        fulfillmentPolicies: allPolicies,
        total: allPolicies.length,
        rateTables: rateTables,
      },
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
