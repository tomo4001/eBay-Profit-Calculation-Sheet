// =============================================================================
// Vercel Serverless Function: 商品の寸法・重量をAI(Gemini+Google検索)で推定
// GET /api/estimate-dimensions?title=<商品タイトル>
//   → 高さ/長さ/幅(cm) / 重量(g) / 根拠(URL or 推測理由) を返す
//
// フォールバック優先順位:
//   1. 梱包サイズ(発送箱・緩衝材込み)をネット検索
//   2. なければ商品本体サイズを検索
//   3. それでもなければAIの推測
//
// 必要な環境変数(Vercel):
//   GEMINI_API_KEY = Google AI Studio の API キー
// =============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const title = (req.query.title || '').trim();
  if (!title) {
    res.status(400).json({ error: '商品タイトルが指定されていません。' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'サーバー側に GEMINI_API_KEY が設定されていません(Vercel環境変数)。' });
    return;
  }

  const prompt = `商品「${title}」について、国際発送(eBay販売)のための寸法と重量をネット検索して調べてください。

【寸法の優先順位】
1. まず「梱包サイズ(発送箱のサイズ、緩衝材込み、cm)」を検索する
2. 見つからなければ「商品本体のサイズ(cm)」を検索する
3. それでも見つからなければ、商品の種類から妥当な梱包サイズを推測する

【重量の優先順位】
1. 梱包後の総重量(g)を検索
2. 商品本体の重量(g)を検索
3. 推測

【重要: 妥当性チェック(必ず実施)】
ネットの情報には誤りも多いため、検索で見つけた数値が「その商品種別として物理的にありえるか」を必ず常識で検証してください:
- 例: 漫画本なのに厚さ30cm、キーホルダーなのに重量5kg、腕時計なのに2kg、ギターなのに長さ3cm 等は明らかにおかしい
- 単位の取り違え(lb↔kg↔g、cm↔inch、mm↔cm)を疑う
- 複数のソースで数値が矛盾する場合は、商品種別に照らして妥当な方を採用する
- 見つけた数値がありえないと判断したら、その値は採用せず、商品知識から妥当な値を推測し直す(その旨を basis に明記)
- 商品本体サイズしか無い場合、梱包の緩衝材分として各辺に1〜3cm程度、重量に緩衝材+箱分を加味して梱包サイズを推定してよい

【確信度】
最終的な数値の確信度を "高"(信頼できる出典あり)/"中"(出典はあるが推定込み)/"低"(ほぼ推測)で示してください。

必ず以下のJSON形式のみで返答してください(前後に説明文やマークダウンを付けない):
{
  "height_cm": 数値,
  "length_cm": 数値,
  "width_cm": 数値,
  "weight_g": 数値,
  "source_type": "梱包サイズ" または "商品サイズ" または "AI推測",
  "confidence": "高" または "中" または "低",
  "basis": "根拠の簡潔な説明。検索で見つかった場合はその商品名と数値の出典。妥当性チェックで弾いた値があればその旨も。推測の場合は推測理由を日本語で",
  "source_url": "参照した主なURL(検索で見つかった場合のみ。推測時は空文字)"
}`;

  // 複数モデル/Tools 組み合わせを順に試す
  const attempts = [
    { model: 'gemini-2.5-flash',    tool: 'google_search' },
    { model: 'gemini-2.0-flash',    tool: 'google_search' },
    { model: 'gemini-1.5-flash',    tool: 'google_search_retrieval' },
    { model: 'gemini-1.5-pro',      tool: 'google_search_retrieval' },
  ];

  let aiRes = null;
  let usedModel = '';
  let lastErrorDetail = '';

  try {
    for (const attempt of attempts) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ [attempt.tool]: {} }],
        generationConfig: { temperature: 0.2 },
      };
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        aiRes = r;
        usedModel = attempt.model + ' / ' + attempt.tool;
        break;
      }
      const text = await r.text();
      lastErrorDetail = `[${attempt.model}/${attempt.tool}] HTTP ${r.status}: ${text.slice(0, 200)}`;
      console.warn('Gemini attempt failed:', lastErrorDetail);
    }

    if (!aiRes) {
      res.status(500).json({ error: 'Gemini API 全モデル失敗', detail: lastErrorDetail });
      return;
    }

    const data = await aiRes.json();
    const candidate = data.candidates && data.candidates[0];
    let textOut = '';
    if (candidate && candidate.content && candidate.content.parts) {
      textOut = candidate.content.parts.map(p => p.text || '').join('');
    }

    // グラウンディングのソースURL収集
    const groundingUrls = [];
    if (candidate && candidate.groundingMetadata && Array.isArray(candidate.groundingMetadata.groundingChunks)) {
      candidate.groundingMetadata.groundingChunks.forEach(ch => {
        if (ch.web && ch.web.uri) groundingUrls.push(ch.web.uri);
      });
    }

    // JSON 抽出(マークダウンコードブロックが付く場合に対応)
    let parsed = null;
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (e) { parsed = null; }
    }

    if (!parsed) {
      res.status(200).json({
        ok: false,
        error: 'AIの返答をJSONとして解析できませんでした。',
        rawText: textOut.slice(0, 500),
        groundingUrls,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      height: parsed.height_cm != null ? Number(parsed.height_cm) : null,
      length: parsed.length_cm != null ? Number(parsed.length_cm) : null,
      width: parsed.width_cm != null ? Number(parsed.width_cm) : null,
      weight: parsed.weight_g != null ? Number(parsed.weight_g) : null,
      sourceType: parsed.source_type || '',
      confidence: parsed.confidence || '',
      basis: parsed.basis || '',
      sourceUrl: parsed.source_url || (groundingUrls[0] || ''),
      groundingUrls,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
