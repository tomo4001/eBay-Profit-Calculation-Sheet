// =============================================================================
// Vercel Serverless Function: 既存ポリシーから除外国データをサービス種別別に集計
// GET /api/ebay-excluded-analysis
//   → サービス種別(Expedited/Economy/Standard) × VeRO有無 で
//     除外国の出現頻度を集計
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

// ポリシー名からサービス種別とVeROフラグを判定
function classifyPolicy(name) {
  const n = (name || '').toLowerCase();
  const vero = n.includes('vero');
  let service = 'Other';
  if (n.startsWith('expedited')) service = 'Expedited';
  else if (n.startsWith('economy')) service = 'Economy';
  else if (n.startsWith('standard')) service = 'Standard';
  return { service, vero };
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

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US`;
    const apiRes = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
    });
    if (!apiRes.ok) {
      const text = await apiRes.text();
      res.status(apiRes.status).json({ error: `ポリシー取得失敗 (HTTP ${apiRes.status})`, detail: text.slice(0, 300) });
      return;
    }
    const data = await apiRes.json();
    const policies = data.fulfillmentPolicies || [];

    // グループ別に集計
    // groups[svc][vero/nonVero] = { policyCount, countries: { CODE: count, ... } }
    const groups = {};
    const groupKeys = ['Expedited', 'Economy', 'Standard', 'Other'];
    groupKeys.forEach(k => {
      groups[k] = {
        nonVero: { policyCount: 0, countries: {}, samplePolicy: null },
        vero:    { policyCount: 0, countries: {}, samplePolicy: null },
      };
    });

    policies.forEach(p => {
      const { service, vero } = classifyPolicy(p.name);
      const bucket = groups[service][vero ? 'vero' : 'nonVero'];
      bucket.policyCount++;
      if (!bucket.samplePolicy) bucket.samplePolicy = p.name;
      const excluded = ((p.shipToLocations || {}).regionExcluded || []).map(r => r.regionName);
      excluded.forEach(code => {
        bucket.countries[code] = (bucket.countries[code] || 0) + 1;
      });
    });

    // 表示用に整形: 各グループの「共通除外国」(=そのグループの全ポリシーに入っている国)を抽出
    const summary = {};
    Object.entries(groups).forEach(([svc, byVero]) => {
      summary[svc] = {};
      Object.entries(byVero).forEach(([veroKey, bucket]) => {
        if (bucket.policyCount === 0) {
          summary[svc][veroKey] = { policyCount: 0, common: [], partial: [] };
          return;
        }
        const common = [];   // 全ポリシーで除外されている国(100%)
        const partial = [];  // 一部のみ
        Object.entries(bucket.countries)
          .sort((a, b) => b[1] - a[1])
          .forEach(([code, cnt]) => {
            if (cnt === bucket.policyCount) {
              common.push(code);
            } else {
              partial.push({ code, count: cnt, ratio: `${cnt}/${bucket.policyCount}` });
            }
          });
        summary[svc][veroKey] = {
          policyCount: bucket.policyCount,
          samplePolicy: bucket.samplePolicy,
          commonCount: common.length,
          common,    // このサービス種別+VeRO区分で 100% 共通の除外国
          partial,   // 一部にだけ含まれる(数値で表示)
        };
      });
    });

    // ExpeditedとEconomyの差分を計算
    const expedNonVero = new Set(summary.Expedited.nonVero.common || []);
    const econNonVero = new Set(summary.Economy.nonVero.common || []);
    const expedVero = new Set(summary.Expedited.vero.common || []);
    const econVero = new Set(summary.Economy.vero.common || []);

    const diff = {
      nonVero: {
        onlyInExpedited: [...expedNonVero].filter(c => !econNonVero.has(c)),
        onlyInEconomy:   [...econNonVero].filter(c => !expedNonVero.has(c)),
        common:          [...expedNonVero].filter(c => econNonVero.has(c)),
      },
      vero: {
        onlyInExpedited: [...expedVero].filter(c => !econVero.has(c)),
        onlyInEconomy:   [...econVero].filter(c => !expedVero.has(c)),
        common:          [...expedVero].filter(c => econVero.has(c)),
      }
    };

    res.status(200).json({
      ok: true,
      totalPolicies: policies.length,
      summary,
      diff,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
