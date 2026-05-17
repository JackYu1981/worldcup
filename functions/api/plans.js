const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

function evaluatePlan(plan, matches) {
  if (!plan.legs || plan.legs.length === 0) return plan;

  let allEvaluated = true;
  let anyHit = false;

  // Group legs by match for combination logic
  const byMatch = {};
  plan.legs.forEach(l => {
    const mid = l.match_id;
    if (!byMatch[mid]) byMatch[mid] = [];
    byMatch[mid].push(l);
  });

  // Evaluate each leg
  plan.legs.forEach(l => {
    let m = matches.find(x => x.id === l.match_id);
    // Fallback: match by code (handle old "011" vs new "周六011" format)
    if (!m && l.code) {
      m = matches.find(x => x.code === l.code || x.code.endsWith(l.code));
    }
    // Fallback: match by team name
    if (!m && l.match_desc) {
      const home = l.match_desc.split('vs')[0];
      if (home) m = matches.find(x => x.home && x.home.includes(home.trim()));
    }
    if (m && m.score) {
      const result = determineResult(m);
      const market = l.market || '1x2';
      l.correct = result[market] === l.pick;
      l.actual_score = result.score;
    } else {
      allEvaluated = false;
    }
  });

  // Build combinations if not present
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

  // Evaluate combinations
  if (plan.combinations) {
    plan.combinations.forEach(c => {
      let comboAllCorrect = true;
      let comboAllEvaluated = true;
      c.legs.forEach(l => {
        let m = matches.find(x => x.id === l.match_id);
        if (!m && l.code) {
          m = matches.find(x => x.code === l.code || x.code.endsWith(l.code));
        }
        if (!m && l.match_desc) {
          const home = l.match_desc.split('vs')[0];
          if (home) m = matches.find(x => x.home && x.home.includes(home.trim()));
        }
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

export async function onRequestGet(context) {
  try {
    const kv = context.env.MATCH_DATA;

    // 1. Read settled plans (already evaluated, won/lost)
    const settledData = await kv.get('plans:settled', 'json');
    const settled = settledData ? settledData.plans : [];

    // 2. Read pending plans
    const pendingData = await kv.get('plans:pending', 'json');
    let pending = pendingData ? pendingData.plans : [];

    // 3. If no pending data exists, migrate from picks
    if (!pendingData && settled.length === 0) {
      pending = await migratePlansFromPicks(kv, context.env);
    }

    // 4. Evaluate pending plans against match data
    const newlySettled = [];
    const stillPending = [];

    if (pending.length > 0) {
      const dates = [...new Set(pending.map(p => p.date).filter(Boolean))];
      const matchCache = {};
      for (const date of dates) {
        const mData = await kv.get(`matches:${date}`, 'json');
        matchCache[date] = mData ? mData.matches : [];
      }

      for (const plan of pending) {
        const matches = matchCache[plan.date] || [];
        const evaluated = evaluatePlan(plan, matches);
        if (evaluated.status === 'won' || evaluated.status === 'lost') {
          newlySettled.push(evaluated);
        } else {
          stillPending.push(evaluated);
        }
      }

      // 5. Persist newly settled plans
      if (newlySettled.length > 0) {
        const allSettled = [...settled, ...newlySettled];
        await kv.put('plans:settled', JSON.stringify({ plans: allSettled }));
        await kv.put('plans:pending', JSON.stringify({ plans: stillPending }));
      }
    }

    const allPlans = [...settled, ...newlySettled, ...stillPending];
    allPlans.sort((a, b) => {
      const ta = a.submitted_at || a.date || '';
      const tb = b.submitted_at || b.date || '';
      return tb.localeCompare(ta);
    });

    return new Response(JSON.stringify({ plans: allPlans }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ plans: [], error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function migratePlansFromPicks(kv, env) {
  try {
    const ghResp = await fetch(
      'https://api.github.com/repos/JackYu1981/worldcup/contents/picks',
      {
        headers: {
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'User-Agent': 'worldmoney-pages',
        },
      }
    );
    if (!ghResp.ok) return [];

    const files = await ghResp.json();
    const jsonFiles = files.filter(f => f.name.endsWith('.json'));
    const allPicks = await Promise.all(jsonFiles.map(async f => {
      const r = await fetch(f.download_url);
      return r.json();
    }));

    const plans = allPicks.filter(p => p.source === 'plan' && p.date !== '2026-05-15');
    if (plans.length > 0) {
      await kv.put('plans:pending', JSON.stringify({ plans }));
    }
    return plans;
  } catch (e) {
    return [];
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}
