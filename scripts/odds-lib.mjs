// ============================================================
// GAUDICODE 競艇サイト オッズ解析ライブラリ
// ------------------------------------------------------------
// BOAT RACE公式のオッズページ (odds3f = 三連複 / odds3t = 三連単) は、
// 1着(列グループ) × 2着・3着(行) の三角行列テーブルで表示される。
// rowspan/colspan を展開したグリッドから買い目→オッズの対応を取り出す。
//   三連複: キーはソート済み "1-2-3" 形式 (全20通り)
//   三連単: キーは着順どおり "1-2-3" 形式 (全120通り)
// 値が数値でないセル (発売前・不成立など) は取り込まない。
// ============================================================
import { JSDOM } from 'jsdom';

// rowspan/colspan を展開して [行][列] のセル参照グリッドを作る
function expandGrid(table) {
  const rows = [...table.querySelectorAll('tr')];
  const g = [];
  const carry = {};
  rows.forEach((tr, ri) => {
    g[ri] = g[ri] || [];
    let ci = 0;
    [...tr.children].forEach((td) => {
      while (carry[ci] && carry[ci].until >= ri) { g[ri][ci] = carry[ci].cell; ci++; }
      const rs = +(td.getAttribute('rowspan') || 1);
      const cs = +(td.getAttribute('colspan') || 1);
      for (let k = 0; k < cs; k++) {
        g[ri][ci + k] = td;
        if (rs > 1) carry[ci + k] = { until: ri + rs - 1, cell: td };
      }
      ci += cs;
    });
    let c = ci;
    while (carry[c] && carry[c].until >= ri) { g[ri][c] = carry[c].cell; c++; }
  });
  return g;
}

// オッズ表 (2番目の table) を { "a-b-c": odds } に変換する
// ordered=true (三連単) のときは着順キー、false (三連複) のときはソート済みキー
function parseOddsTable(html, ordered) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const tables = doc.querySelectorAll('table');
  if (tables.length < 2) return {};
  const g = expandGrid(tables[1]);
  if (!g.length || !g[0].length) return {};
  const out = {};
  // 列グループ (3列ごと) の先頭列が1着の艇番 (ヘッダー行)
  const groups = Math.floor(g[0].length / 3);
  for (let ri = 1; ri < g.length; ri++) {
    for (let gr = 0; gr < groups; gr++) {
      const headCell = g[0][gr * 3];
      const a = parseInt(headCell && headCell.textContent, 10);
      const bCell = g[ri][gr * 3];
      const cCell = g[ri][gr * 3 + 1];
      const oCell = g[ri][gr * 3 + 2];
      if (!bCell || !cCell || !oCell) continue;
      const b = parseInt(bCell.textContent, 10);
      const c = parseInt(cCell.textContent, 10);
      if (![a, b, c].every((n) => Number.isInteger(n) && n >= 1 && n <= 6)) continue;
      if (new Set([a, b, c]).size !== 3) continue;
      if (!oCell.classList || !oCell.classList.contains('oddsPoint')) continue;
      const v = parseFloat(String(oCell.textContent).replace(/,/g, ''));
      if (!Number.isFinite(v) || v <= 0) continue;
      const key = ordered ? [a, b, c].join('-') : [a, b, c].sort((x, y) => x - y).join('-');
      out[key] = v;
    }
  }
  return out;
}

export function parseOdds3f(html) { return parseOddsTable(html, false); }
export function parseOdds3t(html) { return parseOddsTable(html, true); }

// 1レース分のオッズ (三連複+三連単) を取得する。fetchHtml は呼び出し側の
// 取得関数 (UA・リトライ付き) を渡す。片方でも失敗したら例外にする。
export async function fetchRaceOdds(fetchHtml, base, { rno, jcd, hd }) {
  const [fHtml, tHtml] = await Promise.all([
    fetchHtml(`${base}/odds3f?rno=${rno}&jcd=${jcd}&hd=${hd}`),
    fetchHtml(`${base}/odds3t?rno=${rno}&jcd=${jcd}&hd=${hd}`),
  ]);
  return { odds: parseOdds3f(fHtml), oddsTan: parseOdds3t(tHtml) };
}

// ============================================================
// 厳選セット (三連単・勝負) — 競輪と同じ理屈 (2026-11-15 採用)。
// 323レース測定 (確定オッズ・参考値): 厳選FX 的中 36.6% / 回収 69.6%
// (現行の勝負 23.8% / 65.0%、点数は同じ12点)。両日とも的中が安定。
// 方式 (競輪 X4 と同一): 三連複の区分 (鉄板 / バランス追加分 /
// 勝負追加分) ごとに最小オッズの組を1つ選び、区分平均が最小の区分を
// 選定とする。三連単・勝負 = バランス追加の組 (set2) を固定し、
// もう1組は鉄板の組 (set1)。ただし勝負追加分が選定のときは
// set1 の代わりに勝負追加の組 (set3) を使う (入替)。常に2組の
// 全順序 = 12点。発走前のみ適用し、発走後は凍結する (呼出側で制御)。
// ============================================================
const norm = (c) => String(c).split('-').map(Number).sort((a, b) => a - b).join('-');

function pickGensenSet(oddsMap, planList) {
  if (!oddsMap || !Array.isArray(planList) || !planList.length) return null;
  const sets = [...new Set(planList.map(norm))].filter((c) => oddsMap[c] != null);
  if (!sets.length) return null;
  return sets.reduce((m, c) => (oddsMap[c] < oddsMap[m] ? c : m), sets[0]);
}

export function buildBoatGensen(plans, oddsMap) {
  if (!plans || !oddsMap) return null;
  const tep = (plans.teppan || []).map(norm);
  const bal = (plans.balance || []).map(norm);
  const sho = (plans.shoubu || []).map(norm);
  const tepSet = new Set(tep);
  const set1 = pickGensenSet(oddsMap, tep);
  const balAdd = bal.filter((c) => !tepSet.has(c));
  const set2 = pickGensenSet(oddsMap, balAdd);
  const covered = new Set([...tep, ...bal]);
  const shoAdd = sho.filter((c) => !covered.has(c));
  const portionAvg = (list) => {
    const vals = [...new Set(list)].filter((c) => oddsMap[c] != null).map((c) => oddsMap[c]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Infinity;
  };
  const aT = portionAvg(tep);
  const aB = portionAvg(balAdd);
  const aS = portionAvg(shoAdd);
  const selectedPortion = (aS <= aT && aS <= aB) ? 'shoubu' : (aT <= aB ? 'teppan' : 'balance');
  let set3 = null;
  if (selectedPortion === 'shoubu') {
    const shoValid = shoAdd.filter((c) => oddsMap[c] != null && oddsMap[c] !== 9999.9);
    set3 = pickGensenSet(oddsMap, shoValid);
  }
  const sets = (selectedPortion === 'shoubu' && set3) ? [set3, set2] : [set1, set2];
  if (!set1 || !set2) return null; // 測定時の定義どおり、両ピックが揃わないレースは従来構成のまま
  const out = [];
  for (const s of sets) {
    if (!s) continue;
    const [a, b, c] = s.split('-').map(Number);
    for (const p of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      const t = p.join('→');
      if (!out.includes(t)) out.push(t);
    }
  }
  if (!out.length) return null;
  return { orders: out, picks: { set1, set2, set3, selectedPortion } };
}

// レースに保存されたオッズから厳選版の三連単・勝負を構築し prediction に
// 反映する。反映できたら true。構築できない場合は何もしない (勝負は
// 従来構成のまま)。ピックは prediction.gensenPicks に保存し、
// prediction.tanBasis='gensen' を立てる (競輪と同じ方式)。
export function applyBoatGensen(race) {
  const p = race && race.prediction;
  if (!p || !p.plans || !p.plansTan || !race.odds) return false;
  const g = buildBoatGensen(p.plans, race.odds);
  if (!g) return false;
  p.plansTan.shoubu = g.orders;
  p.tanBasis = 'gensen';
  p.gensenPicks = g.picks;
  return true;
}
