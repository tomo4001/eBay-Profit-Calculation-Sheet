=============================================================================
// Vercel Serverless Function: eBay Fulfillment Policy 更新
//
// POST /api/ebay-policy-update
//   body: {
//     action: 'update'|'create'|'delete',
//     policyId: "xxx",           // 既存ポリシーの fulfillmentPolicyId
//     policy: { ... },           // 更新後の policy オブジェクト(eBay構造)
//     dryRun: true|false         // true なら検証のみ、PUT しない
//   }
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
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


// クライアントサイド検証(必須項目チェック)
function validatePolicy(policy) {
  const errors = [];
  if (!policy.name || !policy.name.trim()) errors.push('name が空です');
  if (policy.name && policy.name.length > 65) errors.push(`name が65文字超(${policy.name.length}文字)`);
  if (!policy.marketplaceId) errors.push('marketplaceId が無い(EBAY_US 等)');
  if (!policy.categoryTypes || policy.categoryTypes.length === 0) errors.push('categoryTypes が無い');
  if (!Array.isArray(policy.shippingOptions) || policy.shippingOptions.length === 0) {
    errors.push('shippingOptions が無い');
  } else {
    policy.shippingOptions.forEach((o, i) => {
      if (!o.optionType) errors.push(`shippingOptions[${i}].optionType が無い`);
      if (!o.costType) errors.push(`shippingOptions[${i}].costType が無い`);
      if (!Array.isArray(o.shippingServices) || o.shippingServices.length === 0) {
        errors.push(`shippingOptions[${i}].shippingServices が無い`);
      } else {
        o.shippingServices.forEach((s, j) => {
          if (!s.shippingServiceCode) errors.push(`shippingOptions[${i}].shippingServices[${j}].shippingServiceCode が無い`);
          if (!s.shippingCost) errors.push(`shippingOptions[${i}].shippingServices[${j}].shippingCost が無い`);
        });
      }
    });
  }
  if (!policy.handlingTime || policy.handlingTime.value == null) errors.push('handlingTime が無い');
  return errors;
}

// 不要フィールドの除去
function cleanPolicy(policy) {
  const cleaned = JSON.parse(JSON.stringify(policy));
  delete cleaned.fulfillmentPolicyId;  // URL に含めるので body には不要
  delete cleaned.warnings;
  delete cleaned.errors;

  // 念のため shipToLocations 内の local-only フィールドを除去
  if (Array.isArray(cleaned.shippingOptions)) {
    cleaned.shippingOptions.forEach(o => {
      if (Array.isArray(o.shippingServices)) {
        o.shippingServices.forEach(s => {
          if (s.shipToLocations && '_disabledRegions' in s.shipToLocations) {
            delete s.shipToLocations._disabledRegions;
          }
        });
      }
    });
  }

  return cleaned;
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
  const policy = body.policy;
  const dryRun = body.dryRun === true;
  const action = body.action || 'update';  // 'update' | 'delete' | 'create'

  // === ➕ CREATE 処理(新規ポリシー作成 / Phase 2-G.3) ===
  if (action === 'create') {
    if (!policy || typeof policy !== 'object') { res.status(400).json({ error: 'policy オブジェクトが必要' }); return; }
    const validationErrors = validatePolicy(policy);
    if (validationErrors.length > 0) {
      res.status(400).json({
        ok: false, action: 'create', dryRun, validationFailed: true,
        errors: validationErrors, message: '事前検証エラー: 必須項目が不足しています',
      });
      return;
    }
    try {
      const accessToken = await getAccessToken(appId, certId, refreshToken);
      const cleaned = cleanPolicy(policy);
      if (dryRun) {
        res.status(200).json({
          ok: true, action: 'create', dryRun: true,
          message: '✓ 検証 OK(dry-run: eBay にはまだ送信していません)',
          cleanedPolicy: cleaned,
        });
        return;
      }
      const apiUrl = 'https://api.ebay.com/sell/account/v1/fulfillment_policy';
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(cleaned),
      });
      const text = await apiRes.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}
      if (!apiRes.ok) {
        res.status(apiRes.status).json({
          ok: false, action: 'create', status: apiRes.status,
          error: `eBay POST 失敗 (HTTP ${apiRes.status})`,
          detail: json || text.slice(0, 1500),
          sentBody: cleaned,
        });
        return;
      }
      const newPolicyId = (json && json.fulfillmentPolicyId) || null;
      res.status(200).json({
        ok: true, action: 'create', status: apiRes.status,
        newPolicyId,
        message: '✓ eBay POST 成功(新規作成)',
        created: json,
      });
      return;
    } catch (e) {
      res.status(500).json({ ok: false, action: 'create', error: e.message || String(e) });
      return;
    }
  }

  if (!policyId) { res.status(400).json({ error: 'policyId が必要' }); return; }

  // === 🗑️ DELETE 処理 ===
  if (action === 'delete') {
    // ローカル専用 ID は eBay に存在しない
    if (typeof policyId === 'string' && policyId.startsWith('local_new_')) {
      res.status(400).json({
        ok: false,
        error: 'ローカル専用ポリシー(local_new_*)は eBay に存在しないため API 削除不要',
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
      if (apiRes.status === 204 || apiRes.status === 200) {
        res.status(200).json({
          ok: true,
          action: 'delete',
          policyId,
          status: apiRes.status,
          message: '✓ eBay 上のポリシーを削除しました',
        });
        return;
      }
      const text = await apiRes.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}
      if (apiRes.status === 404) {
        res.status(200).json({
          ok: true,
          action: 'delete',
          policyId,
          status: 404,
          notFound: true,
          message: '⚪ eBay 上に該当ポリシー無し(既に削除済み)',
        });
        return;
      }
      res.status(apiRes.status).json({
        ok: false,
        action: 'delete',
        policyId,
        status: apiRes.status,
        error: `eBay DELETE 失敗 (HTTP ${apiRes.status})`,
        detail: json || text.slice(0, 1500),
      });
      return;
    } catch (e) {
      res.status(500).json({ ok: false, action: 'delete', error: e.message || String(e), policyId });
      return;
    }
  }

  // === 🔄 UPDATE 処理 ===
  if (!policy || typeof policy !== 'object') { res.status(400).json({ error: 'policy オブジェクトが必要' }); return; }

  // 検証
  const validationErrors = validatePolicy(policy);
  if (validationErrors.length > 0) {
    res.status(400).json({
      ok: false,
      dryRun,
      policyId,
      validationFailed: true,
      errors: validationErrors,
      message: '事前検証エラー: 必須項目が不足しています',
    });
    return;
  }

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);
    const cleaned = cleanPolicy(policy);

    if (dryRun) {
      res.status(200).json({
        ok: true, dryRun: true,
        message: '✓ 検証 OK(dry-run: eBay にはまだ送信していません)',
        policyId,
        cleanedPolicy: cleaned,
      });
      return;
    }

    // PUT リクエスト
    const apiUrl = `https://api.ebay.com/sell/account/v1/fulfillment_policy/${encodeURIComponent(policyId)}`;
    const apiRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
      },
      body: JSON.stringify(cleaned),
    });

    const text = await apiRes.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}

    if (!apiRes.ok) {
      res.status(apiRes.status).json({
        ok: false,
        status: apiRes.status,
        policyId,
        error: `eBay PUT 失敗 (HTTP ${apiRes.status})`,
        detail: json || text.slice(0, 1500),
        sentBody: cleaned,
      });
      return;
    }

    // eBay は PUT で body を返さないことが多いので、noChange を判定
    const noChange = apiRes.status === 200 && !json;
    res.status(200).json({
      ok: true,
      status: apiRes.status,
      policyId,
      noChange,
      message: noChange ? '⚪ eBay 上のデータは既に同一(変更不要)' : '✓ eBay PUT 成功',
      updated: json,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e), policyId });
  }
}
