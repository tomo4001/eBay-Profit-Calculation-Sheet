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

// Vercel 関数のタイムアウト上限(秒)。Gemini+Google検索グラウンディングは
// 最悪 90秒超かかるため明示する。Hobby プランは最大60秒なので注意(その場合は
// レイテンシ削減=モデル試行数を減らす等が必要)。Pro 以上なら最大300まで可。
export const config = { maxDuration: 180 };

// AI 応答テキストから JSON オブジェクトを堅牢に抽出する。
//   1) ```json ... ``` のコードフェンスを除去
//   2) 最初の { から、文字列・エスケープを考慮した括弧バランスで対応する } までを抽出
//   3) 失敗時は旧来の greedy regex でフォールバック
// AI が説明文や Markdown フェンスを付けて返すケース(JSON解析失敗の主因)に対応。
function extractJsonFromAiText(text) {
  if (!text || typeof text !== 'string') return null;
  // 1) コードフェンス除去
  let cleaned = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, '')  // 先頭の ```json までを除去
    .replace(/```[\s\S]*$/, '')                // 末尾の ``` 以降を除去
    .trim();
  if (!cleaned) cleaned = text.trim();
  // 2) 括弧バランスで最初の完全な {...} を抽出
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try { return JSON.parse(slice); } catch (e) { /* 次のフォールバックへ */ }
          break;
        }
      }
    }
  }
  // 3) フォールバック: 旧 greedy regex(末尾カンマ補正も試す)
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) {}
    try { return JSON.parse(m[0].replace(/,(\s*[}\]])/g, '$1')); } catch (e) {}
  }
  return null;
}

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

【最重要: 参照元と商品タイトルの一致確認(必須)】
検索でヒットしたページが、入力された商品タイトル「${title}」と「同じブランド・同じカテゴリ・同じモデル系統」であることを必ず照合してください:
- 例1: 商品「Sony WH-1000XM5 ヘッドホン」に対し、参照元が「Pelco監視カメラ機器」のページなら、それは別商品です。**絶対に採用しないでください。**
- 例2: 商品「Pokemon Card Charizard」に対し、参照元が「ポケモンカード保管箱」なら近いカテゴリだが別商品。慎重に判定。
- ブランド名 or モデル番号 or 主要キーワードが参照元と一致しない場合、その参照元は信用できないと判定し、商品種別から推測モードに切り替える(source_type="AI推測"、confidence="低")
- 採用した参照元URL は、必ず商品タイトルと同じ商品 or 同等品のページであることを最終確認してから返すこと

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

【内部整合性チェック(必須)】
寸法と重量が**互いに矛盾しないか**最終確認してください:
- 例: 「本体重量185g」なのに「箱サイズ 33×27×17cm」 → このサイズの箱に入る商品は通常もっと重い。寸法か重量どちらかが別商品の値の可能性。
- 例: 「重量5kg」なのに「箱サイズ 15×10×5cm」 → このサイズに5kgは金属塊レベル。商品種別と照らして矛盾。
- 矛盾を発見したら、商品種別を起点に妥当な方を採用し直し、basis にその旨を明記、confidence="低" とする

【段ボール箱の外寸を返すこと(重要)】
返す寸法は、商品をプチプチ等で包んで「**国際発送用の段ボール外箱に入れた時の外寸**」とします:
- メーカーの「Packaging Info」「Box Dimensions」が見つかった場合は、それを基本値とする
- ただし、それは商品の内箱(リテール箱)の場合も多いため、国際発送のための **外側の段ボール** に入れることを考慮して、各辺に **+2〜4cm程度** 余裕を持たせる
- 商品本体サイズしか無い場合は、緩衝材+段ボール外箱として各辺に **+5〜8cm程度** 加算する
- basis 欄に「メーカー梱包+外箱余裕 +Xcm」など、どのような加算をしたか明記する

【確信度】
最終的な数値の確信度を "高"(参照元が商品タイトルと一致 + 信頼できる出典)/"中"(出典はあるが推定込み or 部分一致)/"低"(ほぼ推測 or 参照元が一致しない)で示してください。

【返答形式: ベース寸法 + 推奨余裕 を別々に】
寸法は「ベース(元の箱 or 商品本体)」と「推奨余裕(段ボール外箱+緩衝材)」を **別フィールド** で返してください。最終値 = ベース + 余裕 になります。

必ず以下のJSON形式のみで返答してください(前後に説明文やマークダウンを付けない):
{
  "base_height_cm": 数値,        // 余裕を足す前のベース高さ(メーカー箱 or 商品本体)
  "base_length_cm": 数値,        // 同上
  "base_width_cm": 数値,         // 同上
  "margin_cm": 数値,             // 推奨余裕 cm(メーカー箱なら 2〜4、商品本体しか無いなら 5〜8、それ以外なら適切な値)
  "weight_g": 数値,              // 梱包後の総重量(余裕分の段ボール・緩衝材も含む)
  "source_type": "梱包サイズ" または "商品サイズ" または "AI推測",
  "confidence": "高" または "中" または "低",
  "ref_match": "一致" または "部分一致" または "不一致",  // 参照元が商品タイトルとどの程度一致するか
  "ref_product": "参照元ページに記載されている商品名(原文ママ。推測時は空文字)",
  "basis": "根拠の簡潔な説明。ベース寸法の出典 + 推奨余裕Xcmの根拠 + 妥当性/整合性チェックの結果を日本語で簡潔に",
  "source_url": "参照した主なURL(検索で見つかった場合のみ。商品タイトルと不一致の参照元は空文字にする)"
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

    // JSON 抽出(コードフェンス除去 + 括弧バランス検出。詳細は extractJsonFromAiText)
    let parsed = extractJsonFromAiText(textOut);

    if (!parsed) {
      res.status(200).json({
        ok: false,
        error: 'AIの返答をJSONとして解析できませんでした。',
        rawText: textOut.slice(0, 1500),  // デバッグ用に長めに返す
        groundingUrls,
      });
      return;
    }

    // ベース寸法 + 推奨余裕(新方式)。旧 *_cm キーが返ってきた場合のフォールバックも
    const baseH = parsed.base_height_cm != null ? Number(parsed.base_height_cm)
                  : (parsed.height_cm != null ? Number(parsed.height_cm) : null);
    const baseL = parsed.base_length_cm != null ? Number(parsed.base_length_cm)
                  : (parsed.length_cm != null ? Number(parsed.length_cm) : null);
    const baseW = parsed.base_width_cm != null ? Number(parsed.base_width_cm)
                  : (parsed.width_cm != null ? Number(parsed.width_cm) : null);
    const margin = parsed.margin_cm != null ? Number(parsed.margin_cm) : 0;

    // 参照元の信頼性: AI が "不一致" と判定 or 商品タイトル(${title})と参照元商品名が乖離している場合は
    // source_url を空にして UI 側で「参照元なし」と扱えるようにする
    const refMatch = parsed.ref_match || '';
    const refProduct = parsed.ref_product || '';
    let sourceUrl = parsed.source_url || '';
    if (refMatch === '不一致') {
      sourceUrl = '';
    }

    res.status(200).json({
      ok: true,
      baseHeight: baseH,
      baseLength: baseL,
      baseWidth: baseW,
      margin: margin,
      // 後方互換: 合計値(base + margin)も返しておく
      height: baseH != null ? baseH + margin : null,
      length: baseL != null ? baseL + margin : null,
      width: baseW != null ? baseW + margin : null,
      weight: parsed.weight_g != null ? Number(parsed.weight_g) : null,
      sourceType: parsed.source_type || '',
      confidence: parsed.confidence || '',
      basis: parsed.basis || '',
      sourceUrl: sourceUrl || (refMatch === '不一致' ? '' : (groundingUrls[0] || '')),
      refMatch,
      refProduct,
      queryTitle: title,  // フロント側で目視確認用に元タイトルも返す
      groundingUrls,
    });

  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
