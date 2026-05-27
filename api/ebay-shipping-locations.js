// =============================================================================
// Vercel Serverless Function: eBay 発送地域構造 取得
// Trading API GeteBayDetails (DetailName=ShippingLocationDetails) で
// eBay発送除外画面と同じ地域構造を取得
//
// GET /api/ebay-shipping-locations
//
// レスポンス例:
//   {
//     ok: true,
//     locations: [
//       { region: "Europe", description: "Europe", countries: ["AT","BE",...] },
//       { region: "Asia", description: "Asia", countries: ["AF","BD",...] },
//       ...
//     ]
//   }
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

// ShippingLocationDetails ブロックを抽出
function extractShippingLocations(xml) {
  const locations = [];
  const re = /<ShippingLocationDetails>([\s\S]*?)<\/ShippingLocationDetails>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1] : null;
    };
    locations.push({
      shippingLocation: get('ShippingLocation'),
      description: get('Description'),
      detailVersion: get('DetailVersion'),
    });
  }
  return locations;
}

// CountryDetails も同時抽出 (リージョン所属を判定するため)
function extractCountriesWithRegion(xml) {
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

// RegionDetails(リージョン名のマスタ)
function extractRegions(xml) {
  const regions = [];
  const re = /<RegionDetails>([\s\S]*?)<\/RegionDetails>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1] : null;
    };
    regions.push({
      regionName: get('Region'),
      description: get('Description'),
    });
  }
  return regions;
}

async function callGeteBayDetails(accessToken, detailName) {
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GeteBayDetailsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailName>${detailName}</DetailName>
</GeteBayDetailsRequest>`;
  const apiRes = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1325',
      'X-EBAY-API-CALL-NAME': 'GeteBayDetails',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml',
    },
    body: xmlBody,
  });
  return await apiRes.text();
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

    // 3つのDetailNameを並列で取得
    const [shippingXml, countryXml, regionXml] = await Promise.all([
      callGeteBayDetails(accessToken, 'ShippingLocationDetails'),
      callGeteBayDetails(accessToken, 'CountryDetails'),
      callGeteBayDetails(accessToken, 'RegionDetails'),
    ]);

    const shippingLocations = extractShippingLocations(shippingXml);
    const countries = extractCountriesWithRegion(countryXml);
    const regions = extractRegions(regionXml);

    res.status(200).json({
      ok: true,
      shippingLocations,   // eBay の "ShipToLocations" 階層構造で使われる単位
      countries,           // 全国コード+名前
      regions,             // 地域マスタ
      counts: {
        shippingLocations: shippingLocations.length,
        countries: countries.length,
        regions: regions.length,
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
