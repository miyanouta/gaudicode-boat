// データ品質チェック (自己監査): 静かな劣化を「見える異常」に変えるための検証。
// 競輪版 validateDay と同じ役割を競艇データに対して行う。
const norm = (s) => s.split('-').map(Number).sort((a, b) => a - b).join('-');
const setOf = (list) => new Set((list || []).map(norm));
const setOfTan = (list) => new Set(list || []);

export function validateDay(data) {
  const errors = [], warnings = [];
  let races = 0;
  for (const v of data.venues || []) {
    for (const r of v.races || []) {
      races++;
      const tag = `${v.name}${r.no}R`;
      if (r.status === 'error') { errors.push(`${tag}: 取得エラー状態`); continue; }
      const p = r.prediction;
      if (!p) { errors.push(`${tag}: 予想なし`); continue; }
      const racers = r.racers || [];
      if (racers.length < 5 || racers.length > 6) errors.push(`${tag}: 出走艇が${racers.length}艇 (5〜6艇が正常)`);
      const nums = new Set(racers.map((x) => x.num));
      if (nums.size !== racers.length) errors.push(`${tag}: 艇番が重複`);
      // 印の完全性: ◎○▲が各1つ、残りは△
      const marks = racers.map((x) => x.mark);
      for (const mk of ['◎', '○', '▲']) {
        if (marks.filter((m) => m === mk).length !== 1) errors.push(`${tag}: 印${mk}が1つでない`);
      }
      if (racers.some((x) => !Number.isFinite(x.score))) errors.push(`${tag}: スコア欠落`);
      if (!p.honmei) errors.push(`${tag}: 本命なし`);
      else {
        const hon = racers.find((x) => x.num === p.honmei.num);
        if (!hon || hon.mark !== '◎') errors.push(`${tag}: 本命と◎印が一致しない`);
      }
      // プラン検証 (三連複・三連単とも 鉄板⊆バランス⊆勝負、買い目の妥当性)
      const checkPlans = (plans, normFn, label) => {
        if (!plans) { errors.push(`${tag}: ${label}プランなし`); return; }
        for (const tier of ['teppan', 'balance', 'shoubu']) {
          if (!Array.isArray(plans[tier]) || !plans[tier].length) errors.push(`${tag}: ${label}・${tier}プランが空`);
        }
        if (plans.teppan && plans.balance && plans.shoubu) {
          const T = new Set(plans.teppan.map(normFn)), B = new Set(plans.balance.map(normFn)), S = new Set(plans.shoubu.map(normFn));
          // 厳選版の三連単・勝負は区分⊆の関係を持たない (競輪と同じ)。
          // 代わりに、保存されたピックの全順序と一致するか検証する。
          const isGensenTan = label === '三連単' && p.tanBasis === 'gensen';
          if (isGensenTan) {
            const picks = p.gensenPicks || {};
            const used = (picks.selectedPortion === 'shoubu' && picks.set3) ? [picks.set3, picks.set2] : [picks.set1, picks.set2];
            if (used.some((s) => !s)) errors.push(`${tag}: 厳選ピックが欠落`);
            else {
              const expected = new Set();
              for (const s of used) {
                const [a, b, c] = s.split('-').map(Number);
                for (const q of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) expected.add(q.join('→'));
              }
              if (expected.size !== S.size || [...expected].some((o) => !S.has(o)))
                errors.push(`${tag}: 厳選の三連単・勝負がピックと一致しない`);
            }
          } else {
            for (const c of T) if (!B.has(c)) errors.push(`${tag}: ${label}・鉄板の買い目がバランスに無い`);
            for (const c of B) if (!S.has(c)) errors.push(`${tag}: ${label}・バランスの買い目が勝負に無い`);
          }
          for (const tier of ['teppan', 'balance', 'shoubu']) for (const c of plans[tier]) {
            const ns = c.split(/[-→]/).map(Number);
            if (ns.length !== 3 || new Set(ns).size !== 3 || ns.some((n) => !nums.has(n)))
              errors.push(`${tag}: ${label}・${tier}に不正な買い目 ${c}`);
          }
        }
      };
      checkPlans(p.plans, norm, '三連複');
      checkPlans(p.plansTan, (s) => s, '三連単');
      // 穴候補は三連複・鉄板の全点に含まれる (競輪と同じ設計ルール)
      if (p.ana && p.plans?.teppan) {
        if (!p.plans.teppan.every((c) => c.split('-').map(Number).includes(p.ana.num)))
          errors.push(`${tag}: 穴候補${p.ana.num}番が鉄板の全点に入っていない`);
      }
      if (!r.startTime) warnings.push(`${tag}: 締切時刻なし`);
      if (r.result) {
        const z = r.result;
        if (!Array.isArray(z.top3) || z.top3.length !== 3 || new Set(z.top3).size !== 3)
          errors.push(`${tag}: 結果の着順が不正`);
        else if (z.top3.some((n) => !nums.has(n))) errors.push(`${tag}: 結果に存在しない艇番`);
        for (const k of ['sanrenpuku', 'sanrentan']) {
          if (z[k] && z[k].payout != null && !(z[k].payout > 0)) errors.push(`${tag}: ${k}の払戻が不正`);
        }
      }
    }
  }
  return { races, errors, warnings };
}
