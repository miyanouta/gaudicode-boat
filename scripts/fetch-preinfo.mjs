// ============================================================
// GAUDICODE 競艇サイト 直前情報 (展示) 取得スクリプト
// ------------------------------------------------------------
// BOAT RACE公式の直前情報ページ (beforeinfo) から、発走が近いレースの
// 展示タイム・スタート展示・部品交換・チルト・水面気象を取得し、
// data/<date>.json の各レースに preinfo としてマージする。
//
// 展示が保存できたレースのうち「結果が無く・発走前」のものは、
// 展示反映スコア (事前スコア + (−z(展示タイム)) × 2.0、2026-11-14
// ユーザー決定・回収重視) で予想を再構築する (展示反映)。
// 事前の予想は prediction.pre に退避し、再構築した予想には
// basis:'tenji' / tenjiApplied:true を付ける。発走済み・結果確定済みの
// レースは絶対に再構築しない (的中判定は発走直前の最終予想で行うため)。
// 前回サイクルで preinfo だけ保存され再構築が済んでいないレースも、
// 起動時にまとめて再構築する (追いつき処理)。
//
// 使い方:
//   node scripts/fetch-preinfo.mjs [YYYY-MM-DD] [--venue=02]
// 対象: 発走時刻が [現在-20分, 現在+75分] の範囲で preinfo 未取得のレース。
// 展示タイムがまだ出ていないページ (発走直前まで空) は保存せず、
// 次の実行サイクルで再試行する。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { rebuildWithTenji } from './predict-lib.mjs';
import { applyBoatGensen } from './odds-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 600;
const TIMEOUT_MS = 20000;
const BASE = 'https://www.boatrace.jp/owpc/pc/race';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.httpStatus = res.status;
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      // HTTP 4xx はリトライしても直らないので即失敗。それ以外は1回だけ再試行。
      if (e.httpStatus && e.httpStatus < 500) break;
      if (attempt === 0) await sleep(1500);
    }
  }
  throw lastErr;
}

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const zen2han = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 直前情報ページ -> { tenji, chilt, parts, prop, startTenji, weather } | null
// 実ページの構造 (2026-11-14 戸田で確認):
//   メインテーブル (ヘッダー: 枠/写真/ボートレーサー/体重/展示タイム/チルト/プロペラ/部品交換/前走成績)
//     艇ごとに主行 (10セル) + 進入行 + 調整重量/ST行 + 着順行 (後ろ3行は前走成績)
//   スタート展示テーブル (ヘッダー: コース/並び/ST、データ行は colspan=3 の1セル)
//   水面気象情報は本文テキスト (例: 水面気象情報 3R時点 気温 16.0℃ 曇り 風速 1m 水温 13.0℃ 波高 1cm)
function parseBeforeInfo(html) {
  if (/<title>[^<]*システムエラー/.test(html)) return null;
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const tenji = {}, chilt = {}, parts = {}, prop = {};
  let startTenji = null, weather = null;
  for (const tb of doc.querySelectorAll('table')) {
    const rows = [...tb.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => clean(c.textContent)));
    if (!rows.length) continue;
    const flat = rows.map((r) => r.join(' ')).join(' ');
    if (flat.includes('展示タイム')) {
      for (const cells of rows) {
        if (cells.length < 9 || !/^[1-6]$/.test(cells[0])) continue;
        const num = Number(cells[0]);
        const tv = parseFloat(cells[4]);
        if (Number.isFinite(tv) && tv > 5 && tv < 9) tenji[num] = tv;
        const ch = parseFloat(cells[5]);
        if (Number.isFinite(ch)) chilt[num] = ch;
        if (cells[6]) prop[num] = cells[6];
        if (cells[7]) parts[num] = cells[7];
      }
    }
    if (flat.includes('スタート展示')) {
      // データ行テキストから (コース, ST) の組を抽出する (例: "1 .08")
      const pairs = [];
      for (const cells of rows.slice(2)) {
        const txt = cells.join(' ');
        const m = txt.match(/^([1-6])\s+(F?\.\d{2})/);
        if (m) pairs.push({ course: Number(m[1]), st: m[2] });
      }
      if (pairs.length >= 4) startTenji = pairs;
    }
  }
  const bodyText = doc.body ? doc.body.textContent.replace(/\s+/g, ' ') : '';
  const wm = bodyText.match(/水面気象情報\s*(\S+)\s*気温\s*([\d.]+)℃\s*(\S+)\s*風速\s*(\d+)m\s*水温\s*([\d.]+)℃\s*波高\s*(\d+)cm/);
  if (wm) weather = { at: wm[1], temp: Number(wm[2]), condition: wm[3], wind: Number(wm[4]), waterTemp: Number(wm[5]), wave: Number(wm[6]) };
  if (!Object.keys(tenji).length && !weather) return null;
  return { tenji, chilt, parts, prop, startTenji, weather };
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const venueArg = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const now = jstNow();
  const date = dateArg || now.date;
  const file = path.join(ROOT, 'data', `${date}.json`);
  if (!fs.existsSync(file)) { console.log(`data/${date}.json が無いのでスキップ`); return; }
  const day = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hd = date.replace(/-/g, '');
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  let fetched = 0, stored = 0, skipped = 0, failed = 0, rebuilt = 0;
  // 途中保存: ステップがタイムアウトで切られても、処理済みの展示を失わない (2026-11-21)
  const saveDay = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(day, null, 1));
    fs.renameSync(tmp, file);
  };

  // 展示反映の再構築: 結果が無く、発走前で、まだ展示未反映のレースだけ。
  // 発走済み・結果ありのレースには絶対に触らない (的中判定の記録を守る)。
  const tryRebuild = (v, r) => {
    if (!r.preinfo || !r.prediction || r.prediction.tenjiApplied) return false;
    if (r.status !== 'ready' || r.result || !r.startTime) return false;
    const future = date > now.date || (date === now.date && toMin(r.startTime) > now.minutes);
    if (!future) return false;
    // 朝固定版の印を残す (再構築で racers の mark が付け替わる前に保存)
    if (!r.morningMarks) r.morningMarks = Object.fromEntries(r.racers.map((x) => [x.num, x.mark || '']));
    const np = rebuildWithTenji(r.racers, r.preinfo.tenji);
    if (!np) return false;
    np.pre = { honmei: r.prediction.honmei, plans: r.prediction.plans, plansTan: r.prediction.plansTan };
    // 変更表示 (ユーザー指示 2026-11-25): 朝版を morning に引き継ぎ、変更時刻と
    // 理由を記録する。既に厳選差し替えで morning が付いている場合は最初の
    // 朝版を保持。展示反映で実際に買い目が変わった場合だけ理由 'tenji' を足す。
    np.morning = r.prediction.morning || JSON.parse(JSON.stringify({ honmei: r.prediction.honmei ?? null, ana: r.prediction.ana ?? null, plans: r.prediction.plans ?? null, plansTan: r.prediction.plansTan ?? null, sanrenpuku: r.prediction.sanrenpuku ?? null, sanrentan: r.prediction.sanrentan ?? null }));
    if (JSON.stringify([np.plans, np.plansTan]) !== JSON.stringify([np.morning.plans, np.morning.plansTan])) {
      np.changedAt = new Date().toISOString();
      np.changeReasons = [...new Set([...(r.prediction.changeReasons || []), 'tenji'])];
    } else if (r.prediction.changedAt) {
      np.changedAt = r.prediction.changedAt;
      np.changeReasons = r.prediction.changeReasons;
    }
    np.basis = 'tenji';
    np.tenjiApplied = true;
    r.prediction = np;
    // 展示反映で買い目が組み直されたので、オッズがあれば厳選も組み直す
    if (r.odds) applyBoatGensen(r);
    rebuilt++;
    console.log(`${v.name} ${r.no}R (${r.startTime}): 展示反映で予想を更新 (本命 ${np.pre.honmei.num}→${np.honmei.num})`);
    return true;
  };

  // 追いつき処理: preinfo 保存済みだが再構築が済んでいないレース
  for (const v of day.venues) {
    if (venueArg && v.id !== venueArg) continue;
    for (const r of v.races) tryRebuild(v, r);
  }
  if (rebuilt > 0) saveDay();

  for (const v of day.venues) {
    if (venueArg && v.id !== venueArg) continue;
    for (const r of v.races) {
      if (r.preinfo || !r.startTime) continue;
      const start = toMin(r.startTime);
      if (date === now.date && (start < now.minutes - 30 || start > now.minutes + 150)) continue;
      fetched++;
      try {
        const html = await fetchHtml(`${BASE}/beforeinfo?rno=${r.no}&jcd=${v.id}&hd=${hd}`);
        const info = parseBeforeInfo(html);
        if (info && Object.keys(info.tenji).length >= 4) {
          r.preinfo = { tenji: info.tenji, source: 'official', fetchedAt: new Date().toISOString() };
          if (Object.keys(info.chilt).length) r.preinfo.chilt = info.chilt;
          if (Object.keys(info.parts).length) r.preinfo.parts = info.parts;
          if (Object.keys(info.prop).length) r.preinfo.prop = info.prop;
          if (info.startTenji) r.preinfo.startTenji = info.startTenji;
          if (info.weather) r.preinfo.weather = info.weather;
          stored++;
          console.log(`${v.name} ${r.no}R (${r.startTime}): 展示 ${Object.keys(info.tenji).length}艇 保存`);
          tryRebuild(v, r);
          saveDay();
        } else {
          skipped++;
          console.log(`${v.name} ${r.no}R (${r.startTime}): 展示未公開のため見送り`);
        }
      } catch (e) {
        failed++;
        console.log(`${v.name} ${r.no}R: ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
  }
  if (stored > 0 || rebuilt > 0) saveDay();
  console.log(`完了: 対象${fetched}件 / 保存${stored}件 / 未公開${skipped}件 / 失敗${failed}件 / 展示再構築${rebuilt}件`);
}

main().catch((e) => { console.error(e); process.exit(1); });
