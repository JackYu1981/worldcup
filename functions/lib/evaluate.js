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
  if (!plan.legs || plan.legs.length === 0) return plan;

  let allEvaluated = true;
  let anyHit = false;

  const byMatch = {};
  plan.legs.forEach(l => {
    const mid = l.match_id;
    if (!byMatch[mid]) byMatch[mid] = [];
    byMatch[mid].push(l);
  });

  plan.legs.forEach(l => {
    const m = findMatch(matches, l);
    if (m && m.score) {
      const result = determineResult(m);
      const market = l.market || '1x2';
      l.correct = result[market] === l.pick;
      l.actual_score = result.score;
    } else {
      allEvaluated = false;
    }
  });

  if (!plan.combinations) {
    const groups = Object.values(byMatch);
    const combos = [];
    function cartesian(idx, current) {
      if (idx === groups.length) {
        const odds = current.reduce((acc, l) => acc * l.odds, 1);
        combos.push({
          legs: current.slice(),
          combined_odds: parseFloat(odds.toFixed(4)),
          stake: 2,
          potential_return: Math.round(odds * 2),
          hit: null
        });
        return;
      }
      groups[idx].forEach(l => {
        current.push(l);
        cartesian(idx + 1, current);
        current.pop();
      });
    }
    cartesian(0, []);
    if (combos.length === 1) {
      combos[0].stake = plan.stake || 100;
      combos[0].potential_return = Math.round(combos[0].combined_odds * (plan.stake || 100));
    }
    plan.combinations = combos;
  }

  if (plan.combinations) {
    plan.combinations.forEach(c => {
      let comboAllCorrect = true;
      let comboAllEvaluated = true;
      c.legs.forEach(l => {
        const m = findMatch(matches, l);
        if (m && m.score) {
          const result = determineResult(m);
          const market = l.market || '1x2';
          l.correct = result[market] === l.pick;
          l.actual_score = result.score;
          if (!l.correct) comboAllCorrect = false;
        } else {
          comboAllEvaluated = false;
        }
      });
      if (comboAllEvaluated) {
        c.hit = comboAllCorrect;
        if (comboAllCorrect) anyHit = true;
      }
    });
  }

  if (allEvaluated) {
    plan.status = anyHit ? 'won' : 'lost';
  }

  return plan;
}
