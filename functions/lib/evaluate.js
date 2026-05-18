import { getBets, getPlanStatus, getTotalReturn } from './plan-adapter.js';

function determineResult(match) {
  if (!match.score) return null;
  const parts = match.score.split('-');
  const home = parseInt(parts[0]), away = parseInt(parts[1]);
  const diff = home - away;
  const handicapLine = match.handicap ? match.handicap.line : 0;
  const adjustedDiff = diff + handicapLine;
  return {
    '1x2': diff > 0 ? 'home_win' : diff === 0 ? 'draw' : 'away_win',
    'handicap': adjustedDiff > 0 ? 'home_win' : adjustedDiff === 0 ? 'draw' : 'away_win',
    score: match.score
  };
}

function findMatch(matches, leg) {
  let m = matches.find(x => x.id === leg.match_id);
  if (!m && leg.code) {
    m = matches.find(x => x.code === leg.code || (x.code && x.code.endsWith(leg.code)));
  }
  if (!m && leg.match_desc) {
    const home = leg.match_desc.split('vs')[0];
    if (home) m = matches.find(x => x.home && x.home.includes(home.trim()));
  }
  return m;
}

export function evaluatePlan(plan, matches) {
  // 通过 adapter 拿到归一的 bets[] —— v2.0 原生 / v1.x combinations / v1.0 legs 都能处理
  const bets = getBets(plan);
  if (bets.length === 0) return plan;

  let allEvaluated = true;

  // 评估每个 bet 的每个 leg（同时回写 plan 的源字段，让前端展示 leg.correct/actual_score）
  bets.forEach(bet => {
    let comboAllCorrect = true;
    let comboAllEvaluated = true;
    (bet.legs || []).forEach(l => {
      const m = findMatch(matches, l);
      if (m && m.score) {
        const result = determineResult(m);
        const market = l.market || '1x2';
        l.correct = result[market] === l.pick;
        l.actual_score = result.score;
        if (!l.correct) comboAllCorrect = false;
      } else {
        comboAllEvaluated = false;
        allEvaluated = false;
      }
    });
    if (comboAllEvaluated) {
      bet.hit = comboAllCorrect;
      bet.actual_return = comboAllCorrect ? bet.potential_return : 0;
    }
  });

  // 写回 plan：保持原有字段结构，加上 hit/actual_return
  if (Array.isArray(plan.bets)) {
    plan.bets.forEach((b, i) => {
      const evaluated = bets[i];
      b.hit = evaluated.hit;
      b.actual_return = evaluated.actual_return;
      // legs 已经被原地修改（同对象引用）
    });
  } else if (Array.isArray(plan.combinations)) {
    plan.combinations.forEach((c, i) => {
      const evaluated = bets[i];
      c.hit = evaluated.hit;
    });
  }

  if (allEvaluated) {
    plan.status = bets.some(b => b.hit === true) ? 'won' : 'lost';
    plan.total_return = bets.reduce((s, b) => s + (b.actual_return || 0), 0);
    plan.profit = plan.total_return - (plan.total_stake || bets.reduce((s, b) => s + (b.stake || 0), 0));
  }

  return plan;
}
