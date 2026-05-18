// Plan format adapter (v2.0 schema 契约)
// 详见 memory/project_ai_betting_algorithm.md "正式方案数据 Schema"
// 把任意版本的 plan 归一为 v2.0 原生 bets[] 多注格式
(function (global) {
  'use strict';

  function getBets(plan) {
    if (!plan) return [];

    // v2.0 原生
    if (Array.isArray(plan.bets) && plan.bets.length > 0) {
      return plan.bets.map(function (b) {
        return Object.assign({
          combo_id: b.combo_id || '',
          stake: b.stake,
          combined_odds: b.combined_odds,
          potential_return: b.potential_return != null
            ? b.potential_return
            : Math.round((b.stake || 0) * (b.combined_odds || 0)),
          p_hit: b.p_hit != null ? b.p_hit : null,
          is_user_combo: b.is_user_combo !== false,
          legs: b.legs || [],
          hit: b.hit != null ? b.hit : null,
          actual_return: b.actual_return != null ? b.actual_return : null
        }, b);
      });
    }

    // v1.x: combinations[]
    if (Array.isArray(plan.combinations) && plan.combinations.length > 0) {
      return plan.combinations.map(function (c, i) {
        return {
          combo_id: c.combo_id || ('C' + (i + 1)),
          stake: c.stake,
          combined_odds: c.combined_odds,
          potential_return: c.potential_return != null
            ? c.potential_return
            : Math.round((c.stake || 0) * (c.combined_odds || 0)),
          p_hit: null,
          is_user_combo: true,
          legs: c.legs || [],
          hit: c.hit != null ? c.hit : null,
          actual_return: c.hit === true ? c.potential_return : (c.hit === false ? 0 : null)
        };
      });
    }

    // v1.0: 单注 legs[]
    if (Array.isArray(plan.legs) && plan.legs.length > 0) {
      var stake = plan.stake || plan.budget || 100;
      var odds = plan.combined_odds || plan.legs.reduce(function (a, l) { return a * (l.odds || 1); }, 1);
      var hit = plan.legs.every(function (l) { return l.correct === true; })
        ? true
        : plan.legs.some(function (l) { return l.correct === false; })
          ? false
          : null;
      return [{
        combo_id: 'C1',
        stake: stake,
        combined_odds: odds,
        potential_return: Math.round(stake * odds),
        p_hit: null,
        is_user_combo: true,
        legs: plan.legs,
        hit: hit,
        actual_return: hit === true ? Math.round(stake * odds) : (hit === false ? 0 : null)
      }];
    }

    return [];
  }

  function getTotalStake(plan) {
    if (plan.total_stake != null) return plan.total_stake;
    var bets = getBets(plan);
    return bets.reduce(function (s, b) { return s + (b.stake || 0); }, 0);
  }

  function getTotalReturn(plan) {
    if (plan.total_return != null) return plan.total_return;
    var bets = getBets(plan);
    return bets.reduce(function (s, b) {
      if (b.hit === true) return s + (b.actual_return != null ? b.actual_return : b.potential_return);
      return s;
    }, 0);
  }

  function getPlanStatus(plan) {
    if (plan.status === 'won' || plan.status === 'lost') return plan.status;
    var bets = getBets(plan);
    if (bets.length === 0) return 'pending';
    var allEvaluated = bets.every(function (b) { return b.hit === true || b.hit === false; });
    if (!allEvaluated) return 'pending';
    return bets.some(function (b) { return b.hit === true; }) ? 'won' : 'lost';
  }

  var api = { getBets: getBets, getTotalStake: getTotalStake, getTotalReturn: getTotalReturn, getPlanStatus: getPlanStatus };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.PlanAdapter = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
