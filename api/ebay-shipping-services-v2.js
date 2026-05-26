// =============================================================================
// Vercel Serverless Function: eBay Trading API (GeteBayDetails) で
//   ShippingServiceDetails を取得 = ebay.com で「今」選択可能な配送サービス全件
//
// GET /api/ebay-shipping-services-v2[?siteId=0]
//   siteId: 0=US, 3=UK, 77=Germany, 71=France, 101=Italy, 100=Japan等
//   既定は 0 (US)
//
// 必要な環境変数:
//   EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
//   EBAY_DEV_ID (Trading API用、Developer Account で確認可能)
// =============================================================================

async function getAccessToken(appId, certId, refreshToken) {
  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  // Trading API 用 scope
  const scopes = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.account.readonly';

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

// 雑XML→簡易オブジェクト化(ShippingServiceDetails配列を抽出)
function extractShippingServices(xml) {
  const blocks = [];
  const re = /<ShippingServiceDetails>([\s\S]*?)<\/ShippingServiceDetails>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1] : null;
    };
    const getAll = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
      const arr = [];
      let x;
      while ((x = r.exec(block)) !== null) arr.push(x[1]);
      return arr;
    };
    blocks.push({
      shippingServiceID: get('ShippingServiceID'),
      shippingService: get('ShippingService'),
      description: get('Description'),
      internationalService: get('InternationalService') === 'true',
      validForSellingFlow: get('ValidForSellingFlow') === 'true',
      mappedToShippingServiceID: get('MappedToShippingServiceID'),
      shippingTimeMin: get('ShippingTimeMin'),
      shippingTimeMax: get('ShippingTimeMax'),
      shippingCarrier: getAll('ShippingCarrier'),
      shippingServiceCode: get('ShippingService'),
      surchargeApplicable: get('SurchargeApplicable') === 'true',
    });
  }
  return blocks;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;
  const devId = process.env.EBAY_DEV_ID; // Trading APIではDevIDも必要
  if (!appId || !certId || !refreshToken) {
    res.status(500).json({ error: 'EBAY_APP_ID / EBAY_CERT_ID / EBAY_REFRESH_TOKEN のいずれかが未設定です。' });
    return;
  }

  const siteId = req.query.siteId || '0'; // 0 = US

  try {
    const accessToken = await getAccessToken(appId, certId, refreshToken);

    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GeteBayDetailsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailName>ShippingServiceDetails</DetailName>
</GeteBayDetailsRequest>`;

    const headers = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1325',
      'X-EBAY-API-CALL-NAME': 'GeteBayDetails',
      'X-EBAY-API-SITEID': String(siteId),
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml',
    };
    if (devId) headers['X-EBAY-API-DEV-NAME'] = devId;
    if (appId) headers['X-EBAY-API-APP-NAME'] = appId;
    if (certId) headers['X-EBAY-API-CERT-NAME'] = certId;

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

    // Ack 取得
    const ackMatch = xmlText.match(/<Ack>(\w+)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : 'Unknown';
    const errors = [];
    const errRe = /<Errors>([\s\S]*?)<\/Errors>/g;
    let em;
    while ((em = errRe.exec(xmlText)) !== null) {
      const block = em[1];
      const sn = (block.match(/<ShortMessage>([\s\S]*?)<\/ShortMessage>/) || [])[1];
      const ln = (block.match(/<LongMessage>([\s\S]*?)<\/LongMessage>/) || [])[1];
      const sev = (block.match(/<SeverityCode>([\s\S]*?)<\/SeverityCode>/) || [])[1];
      errors.push({ severity: sev, short: sn, long: ln });
    }

    const services = extractShippingServices(xmlText);

    // 整形して返す
    res.status(200).json({
      ok: ack === 'Success' || ack === 'Warning',
      ack,
      errors,
      siteId,
      total: services.length,
      validForSellingFlowCount: services.filter(s => s.validForSellingFlow).length,
      services,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
