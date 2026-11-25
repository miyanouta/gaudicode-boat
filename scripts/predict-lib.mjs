// ============================================================
// GAUDICODE 競艇 予想エンジン共有ライブラリ
// ------------------------------------------------------------
// fetch-and-build.mjs (朝の事前予想) と fetch-preinfo.mjs
// (展示反映の再構築) が同じ予想ロジックを使うための共有モジュール。
//
//
// スコア = レース内zスコア化した各指標の加重合計 + 固定ボーナス
// 全国勝率 × 2.2
// モーター2連率 × 1.6
// 当地勝率 × 1.2 (全て0.00 = 当地実績なしの艇は z=0 で中立扱い)
// ボート2連率 × 0.8
// 級別ボーナス: A1 +0.9 / A2 +0.45 / B1 0 / B2 -0.45
// 枠番ボーナス: 1号艇 +1.1 / 2号艇 +0.35 / 3号艇 +0.1 / 4号艇 0 /
// 5号艇 -0.1 / 6号艇 -0.25
//
//
// 合成スコア = 事前スコア + (−z(展示タイム)) × 2.0
// z(展示タイム) は展示タイムがある艇の中でのレース内zスコア
// (速いほど z が負 → −z で加点)。展示がない艇は z=0 (中立)。
// 2026-11-13 の153レースでの検証: 本命1着 35.3%→38.6%・3着内 77.8% /
// 三連単回収 鉄板 37.0%→60.4% / バランス 44.0%→60.3% / 勝負 32.5%→59.6%。
// 展示は発走約20分前に出るため、朝の予想は事前のまま保存し、
// 展示取得後に発走前のレースだけをこの合成スコアで再構築する。
// ============================================================

export const TENJI_W = 2.0;

export function zscores(values) {
const n = values.length;
const mean = values.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
return values.map((v) => (sd > 1e-9? (v - mean) / sd: 0));
}

const CLASS_BONUS = { A1: 0.9, A2: 0.45, B1: 0, B2: -0.45};
const FRAME_BONUS = { 1: 1.1, 2: 0.35, 3: 0.1, 4: 0, 5: -0.1, 6: -0.25};

// 事前スコアを各艇の score にセットする (v1 と同一計算)
export function scoreRacers(racers) {
const zAll = zscores(racers.map((r) => r.winRateAll));
const zMot = zscores(racers.map((r) => r.motorRate));
const zBoat = zscores(racers.map((r) => r.boatRate));
const zLocRaw = zscores(racers.map((r) => r.winRateLocal));
racers.forEach((r, i) => {
const noLocal = r.winRateLocal === 0 && (r.winRateLocal2 === 0 || r.winRateLocal2 == null);
const zLoc = noLocal? 0: zLocRaw[i];
r.score = Math.round((2.2 * zAll[i] + 1.6 * zMot[i] + 1.2 * zLoc + 0.8 * zBoat[i]
+ (CLASS_BONUS[r.class]?? 0) + (FRAME_BONUS[r.num]?? 0)) * 100) / 100;
});
}

// スコア取得関数 scoreOf(racer) を使って印・本命・穴・買い目を構築する。
// 印は各艇の mark にセットする。scoreOf が事前スコアを返せば従来の予想と
// 完全に同一、合成スコアを返せば展示反映の予想になる。
export function buildPredictionWithScores(racers, scoreOf, anaRule = 'motor') {
const ranked = [...racers].sort((a, b) => scoreOf(b) - scoreOf(a) || a.num - b.num);
const MARKS = ['◎', '○', '▲', '△', '△', '△'];
ranked.forEach((r, i) => { r.mark = MARKS[i] || '△';});
const [hon, tai, san] = ranked;
// 穴候補: 既定はスコア4〜6位からモーター2連率トップ (同点は当地勝率→スコア順)。
// 'score4' はスコア4位をそのまま穴にする (C3-lite、ユーザー採用 2026-11-25)。
// 測定 (2026-11-13〜24、12日間・1,753レース): 朝の事前予想だけに score4 を
// 適用すると三連単が全段で両方アップ (鉄板 7.6%/64.6%→9.6%/94.7%、
// バランス 15.8%/65.4%→18.5%/95.2%、勝負 30.5%/61.6%→35.3%/81.5%)。
// 展示反映にまで適用すると回収が落ちたため、展示版は motor のまま。
const anaPool = ranked.slice(3);
const ana = anaRule === 'score4'
? ranked[3]
: [...anaPool].sort((a, b) => b.motorRate - a.motorRate || b.winRateLocal - a.winRateLocal || scoreOf(b) - scoreOf(a))[0];
// 得点上位D: 本命・対抗・▲・穴を除いた最高スコア
const coreNums = new Set([hon.num, tai.num, san.num, ana.num]);
const bestD = ranked.find((r) =>!coreNums.has(r.num)) || null;
const maxMotor = Math.max(...racers.map((r) => r.motorRate));
let anaReason;
if (anaRule === 'score4') {
if (ana.motorRate >= maxMotor) anaReason = `モーター2連率${ana.motorRate}%は全艇トップの好モーター`;
else anaReason = `スコア4位の一発候補・モーター2連率${ana.motorRate}%`;
}
else if (ana.motorRate >= maxMotor) anaReason = `モーター2連率${ana.motorRate}%は全艇トップの好モーター`;
else if (ana.class === 'A1' || ana.class === 'A2') anaReason = `${ana.class}級の実力派・モーター2連率${ana.motorRate}%`;
else anaReason = `モーター2連率${ana.motorRate}%で下位スコアからの一発候補`;

// ---- 買い目プラン (競輪の構成をそのまま踏襲) ----
const combo = (...ns) => {
const u = [...new Set(ns.filter((n) => n!= null))];
return u.length === 3? u.sort((a, b) => a - b).join('-'): null;
};
const add = (list, c) => { if (c &&!list.includes(c)) list.push(c);};
// 三連複・鉄板: 全点に穴候補を含む4点
const teppan = [];
add(teppan, combo(ana.num, hon.num, tai.num));
add(teppan, combo(ana.num, hon.num, san.num));
add(teppan, combo(ana.num, hon.num, bestD? bestD.num: null));
add(teppan, combo(ana.num, tai.num, san.num));
// バランス = 鉄板 + スコア純正 (上位同士の組み合わせ)
const purePuku = [];
add(purePuku, combo(hon.num, tai.num, san.num));
add(purePuku, combo(hon.num, tai.num, bestD? bestD.num: null));
add(purePuku, combo(hon.num, san.num, bestD? bestD.num: null));
const balance = [...teppan];
for (const c of purePuku) add(balance, c);
// 勝負 = バランス + 中核5艇ボックス
const core5 = [hon.num, tai.num, san.num, ana.num,...(bestD? [bestD.num]: [])];
const shoubu = [...balance];
for (let i = 0; i < core5.length; i++)
for (let j = i + 1; j < core5.length; j++)
for (let k = j + 1; k < core5.length; k++)
add(shoubu, combo(core5[i], core5[j], core5[k]));
// 三連単
const T = (...ns) => {
const u = ns.filter((n) => n!= null);
return u.length === 3 && new Set(u).size === 3? u.join('→'): null;
};
const addT = (list, c) => { if (c &&!list.includes(c)) list.push(c);};
const tanTeppan = [];
addT(tanTeppan, T(hon.num, tai.num, ana.num));
addT(tanTeppan, T(hon.num, ana.num, tai.num));
addT(tanTeppan, T(ana.num, hon.num, tai.num));
addT(tanTeppan, T(tai.num, hon.num, ana.num));
const pureTan = [];
addT(pureTan, T(hon.num, tai.num, san.num));
addT(pureTan, T(hon.num, san.num, tai.num));
const tanBalance = [...tanTeppan];
for (const c of pureTan) addT(tanBalance, c);
addT(tanBalance, T(ana.num, tai.num, hon.num)); // 穴頭
// 勝負 = バランス + 案D改の追加5点 (2026-11-14 採用)
// 旧構成 (本命頭フォーメーション) は追加分が三連複の組の内側だけにあり、
// 三連単だけの単独的中が構造的に0件だったため差し替えた。
// 追加: {◎○▲} の順序拡大3点 + ○→▲→穴 + ◎→○→E
// (E = ◎○▲・穴・D のいずれでもない残り1艇)。
// 検証 (2026-11-13+14 の終了309レース): 的中 23.3%→26.9% / 回収 45.7%→57.4% /
// 単独的中 0→6件 / 万舟 3→4件 / 点数は 12点のまま不変。
const tanShoubu = [...tanBalance];
const usedTanNums = new Set([hon.num, tai.num, san.num, ana.num, bestD? bestD.num: null]);
const restE = ranked.find((r) =>!usedTanNums.has(r.num)) || null;
addT(tanShoubu, T(tai.num, hon.num, san.num)); // ○→◎→▲
addT(tanShoubu, T(san.num, hon.num, tai.num)); // ▲→◎→○
addT(tanShoubu, T(tai.num, san.num, hon.num)); // ○→▲→◎
addT(tanShoubu, T(tai.num, san.num, ana.num)); // ○→▲→穴
addT(tanShoubu, T(hon.num, tai.num, restE? restE.num: null)); // ◎→○→E

const comment = [
`◎${hon.num}号艇 ${hon.name}（スコア${scoreOf(hon).toFixed(2)}）。全国勝率${hon.winRateAll.toFixed(2)}・モーター2連率${hon.motorRate}%${hon.num === 1? '・1号艇の枠番有利も大きい': ''}。`,
`対抗は○${tai.num}号艇 ${tai.name}、▲は${san.num}号艇 ${san.name}。`,
`穴候補は${ana.num}号艇 ${ana.name}（${anaReason}）。`,
].join('\n');

return {
honmei: { num: hon.num, name: hon.name},
sanrenpuku: purePuku,
sanrentan: pureTan,
plans: { teppan, balance, shoubu},
plansTan: { teppan: tanTeppan, balance: tanBalance, shoubu: tanShoubu},
ana: { num: ana.num, name: ana.name, reason: anaReason},
comment,
};
}

// 朝の事前予想。穴は C3-lite (スコア4位) で構築する (2026-11-25 採用、
// 2026-11-26 朝生成から)。展示反映 (rebuildWithTenji) はモーター穴のまま。
export function buildPrediction(racers) {
if (!racers || racers.length < 4) return null;
scoreRacers(racers);
return buildPredictionWithScores(racers, (r) => r.score, 'score4');
}

// 展示タイムの合成スコア表 (艇番 -> 合成スコア・丸めなし) を返す。
// 展示がある艇同士で z を計算し、展示がない艇は z=0。
// 展示がある艇が4艇未満なら null (再構築しない)。
export function combinedScoreMap(racers, tenji) {
if (!tenji) return null;
const present = racers.filter((r) => Number.isFinite(tenji[r.num]));
if (present.length < 4) return null;
const zt = zscores(present.map((r) => tenji[r.num]));
const zmap = new Map(present.map((r, i) => [r.num, zt[i]]));
const map = new Map();
for (const r of racers) {
const z = zmap.has(r.num)? zmap.get(r.num): 0;
map.set(r.num, r.score + (-z) * TENJI_W);
}
return map;
}

// 展示反映で予想を再構築する。各艇の mark を付け替え、
// 表示用の合成スコアを scoreT (小数2桁) にセットする。
// 再構築できなければ null。
export function rebuildWithTenji(racers, tenji) {
if (!racers || racers.length < 4) return null;
scoreRacers(racers);
const map = combinedScoreMap(racers, tenji);
if (!map) return null;
const pred = buildPredictionWithScores(racers, (r) => map.get(r.num));
if (!pred) return null;
for (const r of racers) r.scoreT = Math.round(map.get(r.num) * 100) / 100;
return pred;
}
