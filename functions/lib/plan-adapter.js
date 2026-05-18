// Plan format adapter (v2.0 schema 契约) - 后端版本
// 与 assets/plan-adapter.js 等价，纯 ESM
// 详见 memory/project_ai_betting_algorithm.md "正式方案数据 Schema"

export function getBets(plan) {
  if (!plan) return [];

  if (Array.isArray(plan.bets) && plan.bets.length > 0) {
    return plan.bets.map(b => ({
      combo_id: b.combo_id || '',
      stake: b.stake,
      combined_odds: b.combined_odds,
      potential_return: b.potential_return != null
        ? b.potential_return
        : Math.round((b.stake || 0) * (b.combined_odds || 0)),
      p_hit: b.p_hit ?? null,
      is_user_combo: b.is_user_combo !== false,
      legs: b.legs || [],
      hit: b.hit ?? null,
      actual_return: b.actual_return ?? null,
      ...b
    }));
  }

  if (Array.isArray(plan.combinations) && plan.combinations.length > 0) {
    return plan.combinations.map((c, i) => ({
      combo_id: c.combo_id || ('C' + (i + 1)),
      stake: c.stake,
      combined_odds: c.combined_odds,
      potential_return: c.potential_return ?? Math.round((c.stake || 0) * (c.combined_odds || 0)),
      p_hit: null,
      is_user_combo: true,
      legs: c.legs || [],
      hit: c.hit ?? null,
      actual_return: c.hit === true ? c.potential_return : (c.hit === false ? 0 : null)
    }));
  }

  if (Array.isArray(plan.legs) && plan.legs.length > 0) {
    const stake = plan.stake || plan.budget || 100;
    const odds = plan.combined_odds || plan.legs.reduce((a, l) => a * (l.odds || 1), 1);
    const hit = plan.legs.every(l => l.correct === true)
      ? true
      : plan.legs.some(l => l.correct === false)
        ? false
        : null;
    return [{
      combo_id: 'C1',
      stake,
      combined_odds: odds,
      potential_return: Math.round(stake * odds),
      p_hit: null,
      is_user_combo: true,
      legs: plan.legs,
      hit,
      actual_return: hit === true ? Math.round(stake * odds) : (hit === false ? 0 : null)
    }];
  }

  return [];
}

export function getTotalStake(plan) {
  if (plan.total_stake != null) return plan.total_stake;
  return getBets(plan).reduce((s, b) => s + (b.stake || 0), 0);
}

export function getTotalReturn(plan) {
  if (plan.total_return != null) return plan.total_return;
  return getBets(plan).reduce((s, b) => {
    if (b.hit === true) return s + (b.actual_return ?? b.potential_return);
    return s;
  }, 0);
}

export function getPlanStatus(plan) {
  if (plan.status === 'won' || plan.status === 'lost') return plan.status;
  const bets = getBets(plan);
  if (bets.length === 0) return 'pending';
  const allEvaluated = bets.every(b => b.hit === true || b.hit === false);
  if (!allEvaluated) return 'pending';
  return bets.some(b => b.hit === true) ? 'won' : 'lost';
}
