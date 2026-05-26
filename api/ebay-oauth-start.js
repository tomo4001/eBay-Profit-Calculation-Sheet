// =============================================================================
// Vercel Serverless Function: eBay OAuth開始
// GET /api/ebay-oauth-start
//   → eBay の Sign In ページにリダイレクトして「許可」をクリックしてもらう
//
// 必要な環境変数(Vercel):
//   EBAY_APP_ID   = Production App ID (Client ID)
//   EBAY_RU_NAME  = eBay Developer で登録した RuName
//                   (例: Tadatomo_Sagara-Tadatomo-bleade-nldzyrwqo)
// =============================================================================

export default function handler(req, res) {
  const appId = process.env.EBAY_APP_ID;
  const ruName = process.env.EBAY_RU_NAME;

  if (!appId) {
    res.status(500).send('サーバー側に EBAY_APP_ID が未設定です。');
    return;
  }
  if (!ruName) {
    res.status(500).send('サーバー側に EBAY_RU_NAME が未設定です。Vercel環境変数に Tadatomo_Sagara-Tadatomo-bleade-nldzyrwqo を追加してください。');
    return;
  }

  // ビジネスポリシー管理 + Trading API 用スコープ
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',                       // Trading API / Browse 基本
    'https://api.ebay.com/oauth/api_scope/sell.account',           // ポリシー管理
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly',  // ポリシー読み取り
    'https://api.ebay.com/oauth/api_scope/sell.inventory',         // 出品在庫(将来用)
    'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  ].join(' ');

  // CSRF対策のstate(本来はサーバーセッションで管理。MVPなのでシンプルに)
  const state = Math.random().toString(36).slice(2);

  // eBay OAuth Authorize エンドポイント
  const authUrl = new URL('https://auth.ebay.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', appId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', ruName);  // ★ ここはRuName を入れる(URLではない)
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'login');

  res.redirect(302, authUrl.toString());
}
