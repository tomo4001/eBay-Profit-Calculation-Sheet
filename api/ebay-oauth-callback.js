// =============================================================================
// Vercel Serverless Function: eBay OAuth コールバック
// GET /api/ebay-oauth-callback?code=...
//   → 認可コードをトークンに交換 → refresh_token を画面表示
//
// 必要な環境変数(Vercel):
//   EBAY_APP_ID   = Production App ID
//   EBAY_CERT_ID  = Production Cert ID
//   EBAY_RU_NAME  = RuName
// =============================================================================

export default async function handler(req, res) {
  const code = req.query.code;
  const errorParam = req.query.error;
  const errorDesc = req.query.error_description;

  // eBay画面で拒否した場合
  if (errorParam) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(`
      <html><body style="font-family: sans-serif; padding: 30px;">
        <h1>❌ 認証がキャンセル/拒否されました</h1>
        <p>${errorDesc || errorParam}</p>
        <p><a href="/api/ebay-oauth-start">もう一度試す</a></p>
      </body></html>
    `);
    return;
  }

  if (!code) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(`
      <html><body style="font-family: sans-serif; padding: 30px;">
        <h1>⚠ 認可コードが見つかりません</h1>
        <p>URLに ?code=... が含まれていません。</p>
        <p><a href="/api/ebay-oauth-start">最初から始める</a></p>
      </body></html>
    `);
    return;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const ruName = process.env.EBAY_RU_NAME;

  if (!appId || !certId || !ruName) {
    res.status(500).send('サーバー設定不足: EBAY_APP_ID / EBAY_CERT_ID / EBAY_RU_NAME を確認');
    return;
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  try {
    // 認可コードをアクセストークン + リフレッシュトークンに交換
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: ruName,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(500).send(`
        <html><body style="font-family: sans-serif; padding: 30px;">
          <h1>❌ トークン交換失敗</h1>
          <p>HTTP ${tokenRes.status}</p>
          <pre style="background:#f3f4f6; padding:12px; border-radius:6px; overflow:auto;">${text.replace(/</g, '&lt;')}</pre>
          <p><a href="/api/ebay-oauth-start">もう一度試す</a></p>
        </body></html>
      `);
      return;
    }

    const data = await tokenRes.json();
    const refreshToken = data.refresh_token || '';
    const accessToken = data.access_token || '';
    const expiresIn = data.expires_in || 0;
    const refreshExpiresIn = data.refresh_token_expires_in || 0;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <html>
      <head>
        <title>eBay OAuth 成功</title>
        <style>
          body { font-family: -apple-system, "Hiragino Sans", sans-serif; padding: 30px; max-width: 850px; margin: 0 auto; background: #f9fafb; color: #111827; line-height: 1.6; }
          h1 { color: #16a34a; }
          .token-box { background: #1f2937; color: #f9fafb; padding: 14px 16px; border-radius: 8px; word-break: break-all; font-family: 'SF Mono', Consolas, monospace; font-size: 11px; margin: 10px 0; }
          .step { background: #eff6ff; padding: 18px 22px; border-radius: 10px; margin: 18px 0; border-left: 4px solid #2563eb; }
          .step h3 { margin-top: 0; color: #1e40af; }
          button { padding: 8px 18px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
          button:hover { background: #1d4ed8; }
          code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Consolas, monospace; font-size: 12px; }
          ol li { margin-bottom: 8px; }
          .info { font-size: 12px; color: #6b7280; }
        </style>
      </head>
      <body>
        <h1>✓ eBay OAuth 認証成功</h1>
        <p>Refresh Token を取得しました。これを Vercel の環境変数に登録してください。</p>

        <div class="step">
          <h3>📋 取得した Refresh Token</h3>
          <div class="info">有効期間: ${refreshExpiresIn ? Math.round(refreshExpiresIn / 86400) + '日' : '不明'}(自動延長されます)</div>
          <div class="token-box" id="rtoken">${refreshToken}</div>
          <button onclick="navigator.clipboard.writeText(document.getElementById('rtoken').textContent).then(()=>{this.textContent='✓ コピー済み';setTimeout(()=>this.textContent='📋 Refresh Tokenをコピー',2000);})">📋 Refresh Tokenをコピー</button>
        </div>

        <div class="step">
          <h3>📝 次の手順</h3>
          <ol>
            <li>上の <strong>Refresh Token</strong> を「コピー」ボタンでコピー</li>
            <li><a href="https://vercel.com/dashboard" target="_blank" rel="noopener">Vercel ダッシュボード</a> → <code>eBay-Profit-Calculation-Sheet</code> プロジェクト</li>
            <li>Settings → Environment Variables → <strong>Add New</strong></li>
            <li>以下を入力:
              <ul>
                <li>Name: <code>EBAY_REFRESH_TOKEN</code></li>
                <li>Value: コピーしたトークン</li>
                <li>Environment: <strong>Production</strong> にチェック</li>
              </ul>
            </li>
            <li><strong>Save</strong> をクリック</li>
            <li>GitHubで何かしらコミット(README更新等)してVercel再デプロイをトリガー(または Vercel画面で Redeploy)</li>
            <li>デプロイ完了後、<a href="/api/ebay-policies-list" target="_blank"><code>/api/ebay-policies-list</code></a> にアクセスしてポリシー一覧が返ってくれば成功</li>
          </ol>
        </div>

        <details>
          <summary class="info">参考: その他のレスポンスデータ</summary>
          <pre style="background:#f3f4f6; padding:12px; border-radius:6px; font-size: 11px; overflow:auto;">${JSON.stringify({
            ...data,
            refresh_token: '*** (上に表示済み)',
            access_token: accessToken.slice(0, 20) + '...(以下省略)'
          }, null, 2)}</pre>
        </details>
      </body>
      </html>
    `);
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(500).send(`
      <html><body style="font-family: sans-serif; padding: 30px;">
        <h1>❌ エラー</h1>
        <pre>${(e.message || String(e)).replace(/</g, '&lt;')}</pre>
      </body></html>
    `);
  }
}
