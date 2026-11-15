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
