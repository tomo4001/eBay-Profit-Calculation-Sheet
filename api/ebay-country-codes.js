// =============================================================================
// Vercel Serverless Function: eBay 全国コード取得
// Trading API GeteBayDetails (DetailName=CountryDetails) で全約250カ国を取得
//
// GET /api/ebay-country-codes
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
// =============================================================================

async function getAccessToken(appId, certId, refreshToken) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const scopes = 'https://api.ebay.com/oauth/api_scope';
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

// 雑XML→簡易オブジェクト化(CountryDetails配列を抽出)
function extractCountries(xml) {
  const countries = [];
  const re = /<CountryDetails>([\s\S]*?)<\/CountryDetails>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1] : null;
    };
    countries.push({
      code: get('Country'),
      name: get('Description'),
    });
  }
  return countries;
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

  const siteId = req.query.siteId || '0';

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GeteBayDetailsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailName>CountryDetails</DetailName>
</GeteBayDetailsRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1325',
      'X-EBAY-API-CALL-NAME': 'GeteBayDetails',
      'X-EBAY-API-SITEID': String(siteId),
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml',
    };

    const apiRes = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers,
      body: xmlBody,
    });
    const xmlText = await apiRes.text();

    if (!apiRes.ok) {
      res.status(apiRes.status).json({
        error: `Trading API失敗 (HTTP ${apiRes.status})`,
        rawSnippet: xmlText.slice(0, 800),
      });
      return;
    }

    const ackMatch = xmlText.match(/<Ack>(\w+)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';
    const countries = extractCountries(xmlText);

    res.status(200).json({
      ok: ack === 'Success' || ack === 'Warning',
      ack,
      siteId,
      total: countries.length,
      countries,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
