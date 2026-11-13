// ============================================================
// GAUDICODE 競艇サイト 結果取得スクリプト
// ------------------------------------------------------------
// 指定日のレース結果 (着順・三連複/三連単の払戻) をBOAT RACE公式から
// 取得し、data/<date>.json の各レースに result としてマージする。
// あわせて予想プラン (鉄板/バランス/勝負) の的中判定も記録する。
// まだ結果が出ていないレースは result を付けずに残す (再実行で埋まる)。
//
// 使い方:
//   node scripts/fetch-results.mjs [YYYY-MM-DD] [--venue=02]
// 前提: その日の data/<date>.json が存在すること (先に出走表を取得)。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 500;
const BASE = 'https://www.boatrace.jp/owpc/pc/race';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function jstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const zen2han = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 結果ページ -> { top3:[艇番...], sanrenpuku:{combo,payout}, sanrentan:{combo,payout} }
// 実ページの構造 (2026-11-13 戸田1Rで確認):
//   着順テーブル (ヘッダー: 着/枠/ボートレーサー/レースタイム) から上位3艇の枠番
//   払戻テーブル (ヘッダー: 勝式/組番/払戻金/人気) の「3連単」「3連複」行
function parseResult(html) {
  if (/<title>[^<]*システムエラー/.test(html)) return null;
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  let top3 = null;
  let sanrenpuku = null, sanrentan = null;
  for (const tb of doc.querySelectorAll('table')) {
    const rows = [...tb.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    if (!rows.length) continue;
    const head = rows[0];
    if (head.includes('着') && head.includes('枠') && !top3) {
      const ri = head.indexOf('着'); const ni = head.indexOf('枠');
      const placed = [];
      for (const cells of rows.slice(1)) {
        const rank = Number(zen2han(cells[ri] || ''));
        const num = Number(zen2han(cells[ni] || ''));
        if (rank >= 1 && rank <= 3 && num >= 1 && num <= 6) placed.push({ rank, num });
      }
      if (placed.length >= 3) top3 = placed.sort((a, b) => a.rank - b.rank).slice(0, 3).map((p) => p.num);
    }
    if (head.includes('勝式') && head.includes('払戻金')) {
      for (const cells of rows.slice(1)) {
        const kind = cells[0];
        if (kind !== '3連単' && kind !== '3連複') continue;
        const combo = (cells[1] || '').replace(/\s*[-=]\s*/g, '-');
        const payout = Number(((cells[2] || '').match(/([\d,]+)/) || [])[1]?.replace(/,/g, ''));
        if (!/^\d-\d-\d$/.test(combo)) continue;
        const rec = { combo, payout: Number.isFinite(payout) ? payout : null };
        if (kind === '3連単' && !sanrentan) sanrentan = rec;
        if (kind === '3連複' && !sanrenpuku) sanrenpuku = rec;
      }
    }
  }
  if (!top3) return null;
  return { top3, sanrenpuku, sanrentan };
}

const norm = (s) => s.split('-').map(Number).sort((a, b) => a - b).join('-');

function evaluate(race, result) {
  const hits = {};
  const p = race.prediction;
  if (p?.plans && result.sanrenpuku) {
    const key = norm(result.sanrenpuku.combo);
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plans[tier])) hits[tier] = p.plans[tier].map(norm).includes(key);
    }
  }
  if (p?.plansTan && result.sanrentan) {
    const ordered = result.sanrentan.combo.replace(/-/g, '→');
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plansTan[tier])) hits['tan' + tier[0].toUpperCase() + tier.slice(1)] = p.plansTan[tier].includes(ordered);
    }
    hits.sanrentan = hits.tanTeppan;
  }
  return hits;
}

async function main() {
  const args = process.argv.slice(2);
  const dateStr = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstToday();
  const venueFilter = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const dataPath = path.join(ROOT, 'data', `${dateStr}.json`);
  if (!fs.existsSync(dataPath)) throw new Error(`data/${dateStr}.json がありません。先に出走表を取得してください。`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const hd = dateStr.replace(/-/g, '');

  let updated = 0, pending = 0, failed = 0;
  for (const v of data.venues) {
    if (venueFilter && v.id !== venueFilter.padStart(2, '0')) continue;
    for (const r of v.races) {
      if (r.status !== 'ready') { pending++; continue; }
      try {
        const html = await fetchHtml(`${BASE}/raceresult?rno=${r.no}&jcd=${v.id}&hd=${hd}`);
        const result = parseResult(html);
        if (!result) { pending++; }
        else {
          r.result = { ...result, hits: evaluate(r, result) };
          updated++;
        }
      } catch (e) {
        failed++;
        console.log(`[results] ${v.name} ${r.no}R 取得失敗: ${e.message || e}`);
      }
      await sleep(DELAY_MS);
    }
  }
  data.resultsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[done] 結果を記録: ${updated}レース / 未確定: ${pending} / 失敗: ${failed}`);
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
