#!/Users/I064337/ai/worldcup/.venv/bin/python
"""
AI 投注方案生成器（v2.0 算法）

入口：scripts/generate-plan.py --passphrase XXX [--user jack] [--c 0.6] [--dry-run]

流程：
  1. login → token
  2. /api/picks 拿当天 recommendation + pending_plan，按 passphrase 锁定一份预备方案
  3. /api/matches 拿赛程（含 1x2 / handicap 赔率）
  4. 合成 p_user（c 因子）
  5. 枚举世界状态 Ω 与候选组合 C = U ∪ A
  6. PuLP ILP：max P_eff → max N_cov → max N_user
  7. 装配 plan（含 optimization_narrative / original_odds_grid / bets[].legs[].note）
  8. POST /api/submit 写 KV
"""
import argparse
import getpass
import itertools
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from collections import defaultdict

import pulp

# === 算法常量（v2.0 契约） ===
TOTAL_BUDGET = 150
BUDGET_LB = 146
BUDGET_UB = 154
AI_BUDGET = 30
WIN_LO = 900
WIN_HI = 2700
AI_WIN_LO = 600
AI_WIN_HI = 3000
STAKE_STEP = 2
DEFAULT_C = 0.6
ALGO_VERSION = "v2.2"

API_BASE = "https://worldmoney.pages.dev"
PICK_KEYS = ["home_win", "draw", "away_win"]
PICK_DESC = {"home_win": "主胜", "draw": "平", "away_win": "客胜"}


# ---------- HTTP ----------

def http_post(url, body, token=None):
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "worldmoney-cli/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def http_get(url, token=None):
    headers = {"User-Agent": "worldmoney-cli/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def login(username, password):
    code, body = http_post(f"{API_BASE}/api/login", {"username": username, "password": password})
    if code != 200 or not body.get("success"):
        raise RuntimeError(f"登录失败 ({code}): {body}")
    return body["token"]


# ---------- 数据获取 ----------

def fetch_picks(token, date):
    code, body = http_get(f"{API_BASE}/api/picks?date={date}", token)
    if code != 200:
        raise RuntimeError(f"/api/picks 失败 ({code}): {body}")
    return body.get("picks", [])


def fetch_matches(period):
    code, body = http_get(f"{API_BASE}/api/matches?period={period}")
    if code != 200:
        raise RuntimeError(f"/api/matches 失败 ({code}): {body}")
    return body.get("matches", [])


# ---------- 数据预处理 ----------

def find_pending_plan(picks, passphrase):
    pending = [p for p in picks if p.get("source") == "pending_plan" and p.get("passphrase") == passphrase]
    if not pending:
        raise RuntimeError(f"未找到 passphrase='{passphrase}' 的预备方案")
    if len(pending) > 1:
        raise RuntimeError(f"passphrase='{passphrase}' 存在多个预备方案，请检查 KV")
    return pending[0]


def find_source_recommendation(picks, pending):
    """
    推荐 = 预备方案的源头：取 source=recommendation 且 pending_plan_passphrase==passphrase 的那条。
    用于读取「用户全部原始勾选」(可能比 pending 的 3 条 leg 多——如同场多选)。
    """
    pp = pending.get("passphrase")
    cand = [p for p in picks if p.get("source") == "recommendation" and p.get("pending_plan_passphrase") == pp]
    if not cand:
        # 兜底：用 pending.legs 反推
        return None
    return cand[0]


def build_match_index(matches):
    return {m["id"]: m for m in matches}


def reconstruct_matches_from_rec(rec, match_idx):
    """
    用 rec.legs 里保存的赛前赔率覆盖 match_idx 中的赔率（用于 dry-run 历史复盘：
    /api/matches 在比赛结束后会把 odds 重置为 1）。
    rec.legs 仅含被勾选的 leg，未勾选 outcome 的赔率仍来自 match_idx。
    若 match_idx 里整组赔率都是 1（全场已重置），就用 rec.legs 中的勾选赔率
    + 1.0 作为占位（不会被作为 user pick，但仍参与候选枚举）。
    """
    for leg in rec.get("legs", []):
        mid = leg["match_id"]
        if mid not in match_idx:
            continue
        m = match_idx[mid]
        if leg["market"] == "1x2":
            m["odds"][leg["pick"]] = leg["odds"]
        else:
            m["handicap"][leg["pick"]] = leg["odds"]
            if "line" in leg:
                m["handicap"]["line"] = leg.get("line", m["handicap"].get("line"))
    return match_idx


def collect_user_picks(rec_or_pending, match_idx):
    """
    返回 user_picks: {match_id: {market: {line(or None): set(picks)}}}
    """
    legs = rec_or_pending.get("legs", [])
    out = defaultdict(lambda: defaultdict(lambda: defaultdict(set)))
    for leg in legs:
        mid = leg["match_id"]
        market = leg["market"]
        if market == "handicap":
            line = match_idx[mid].get("handicap", {}).get("line")
        else:
            line = None
        out[mid][market][line].add(leg["pick"])
    return out


def calc_p_market(odds_dict):
    """去 margin 归一化：odds {home_win,draw,away_win} → {p_home,p_draw,p_away}"""
    raw = {k: 1.0 / v for k, v in odds_dict.items() if v and v > 0}
    s = sum(raw.values())
    if s <= 0:
        return None
    return {k: v / s for k, v in raw.items()}


def calc_p_user(p_market, picked_set, c):
    """
    若 picked_set 非空：sum_picked = c*1 + (1-c)*∑ p_market[picked]，按 p_market 比例分配
    若 picked_set 为空：直接返回 p_market
    """
    if not picked_set:
        return dict(p_market)
    picked = [k for k in PICK_KEYS if k in picked_set]
    sum_picked_market = sum(p_market[k] for k in picked)
    sum_picked_user = c * 1.0 + (1 - c) * sum_picked_market
    if sum_picked_user > 1:
        sum_picked_user = 1.0
    p_user = {}
    for k in PICK_KEYS:
        if k in picked:
            p_user[k] = sum_picked_user * p_market[k] / sum_picked_market if sum_picked_market > 0 else sum_picked_user / len(picked)
        else:
            unpicked = [x for x in PICK_KEYS if x not in picked]
            sum_unpicked_market = sum(p_market[x] for x in unpicked)
            if sum_unpicked_market > 0:
                p_user[k] = (1 - sum_picked_user) * p_market[k] / sum_unpicked_market
            else:
                p_user[k] = (1 - sum_picked_user) / len(unpicked) if unpicked else 0
    return p_user


# ---------- 候选构建 ----------

def build_legs_universe(user_picks, match_idx, c):
    """
    每个 (match_id, market, line) 是一个 leg slot；每个 slot 在三个 outcome 下各有一个 leg 候选。
    返回:
      slots: 列表 [(match_id, market, line)]，每个 slot 的 outcomes={pick: {odds, p_user, p_market, picked}}
      slot_match_id: {idx -> match_id}
    """
    slots = []
    for mid, markets in user_picks.items():
        m = match_idx[mid]
        for market, lines in markets.items():
            for line, picked_set in lines.items():
                if market == "1x2":
                    odds_dict = {k: m["odds"][k] for k in PICK_KEYS}
                else:
                    odds_dict = {k: m["handicap"][k] for k in PICK_KEYS}
                p_market = calc_p_market(odds_dict)
                p_user = calc_p_user(p_market, picked_set, c)
                slots.append({
                    "match_id": mid,
                    "match": m,
                    "market": market,
                    "line": line,
                    "picked": set(picked_set),
                    "outcomes": {
                        k: {
                            "odds": odds_dict[k],
                            "p_user": p_user[k],
                            "p_market": p_market[k],
                            "picked": k in picked_set,
                        }
                        for k in PICK_KEYS
                    },
                })
    return slots


def world_state_prob(omega, slots):
    """omega 是 (pick_per_slot,) 元组，长度与 slots 一致"""
    p = 1.0
    for slot, pick in zip(slots, omega):
        p *= slot["outcomes"][pick]["p_user"]
    return p


def enumerate_omegas(slots):
    """笛卡尔积 ≤ 3^len(slots)"""
    return list(itertools.product(PICK_KEYS, repeat=len(slots)))


def is_user_combo(combo, slots):
    """combo = [(slot_idx, pick), ...]，长度 3 或 4。leg 全部命中 picked 即 user combo。
    注意：v2.1 起，is_user 由 build_candidates 直接按结构指派——
      - N=3 场景：3 串 user / 3 串 AI（与旧逻辑一致）
      - N=4 场景：4 串恒为 user / 3 串恒为 AI（不论 leg 是否全在 picked 里）
    本函数仅作 fallback / 调试用途。
    """
    for slot_idx, pick in combo:
        if pick not in slots[slot_idx]["picked"]:
            return False
    return True


# N=2 专用窗口下沿（区别于 N≥3 的 WIN_LO=900）
# 原因：2 串 odds 通常较低，900 元下沿在 154 元预算内常常数学不可行；
# 用户明确要求 N=2 把窗口下沿放宽到 700。
N2_WIN_LO = 600
N2_WIN_HI = WIN_HI  # 上沿仍为 2700


def build_n2_candidates(slots):
    """
    N=2 直通路径：每场只取「用户勾选的 leg」做 2 串笛卡尔积。
    同场多选（1x2 + handicap，或同 market 多 outcome）= 该场的多个候选 leg，独立参与笛卡尔。
    返回 list of {legs:[(slot_idx, pick), (slot_idx, pick)], is_user:True, k_str:2}
    """
    by_match = defaultdict(list)  # match_id -> [(slot_idx, pick), ...]，仅用户勾选过的 (slot, outcome)
    for si, s in enumerate(slots):
        for pk in s["picked"]:
            by_match[s["match_id"]].append((si, pk))

    match_ids = list(by_match.keys())
    if len(match_ids) != 2:
        raise RuntimeError(f"build_n2_candidates 仅支持 N=2（当前 {len(match_ids)} 场）")

    a_legs = by_match[match_ids[0]]
    b_legs = by_match[match_ids[1]]
    candidates = []
    for la in a_legs:
        for lb in b_legs:
            candidates.append({"legs": [la, lb], "is_user": True, "k_str": 2})
    return candidates


def filter_n2_window(candidates, slots):
    """N=2 候选过滤：单注必须存在合法 stake 使 stake*odds ∈ [N2_WIN_LO, N2_WIN_HI]。"""
    out = []
    for c in candidates:
        odds = combo_odds(c, slots)
        c["odds"] = odds
        if STAKE_STEP * odds > N2_WIN_HI:
            continue
        if BUDGET_UB * odds < N2_WIN_LO:
            continue
        out.append(c)
    return out


def solve_n2_stakes(candidates):
    """
    N=2 stake 分配：每注预期回报尽量接近 ——
    1. 取窗口中点 target = (WIN_LO + WIN_HI) / 2 = 1800 作初始目标
    2. 每注 stake_raw = target / odds；按 STAKE_STEP=2 取偶数
    3. clip 到使 stake*odds ∈ [WIN_LO, WIN_HI]
    4. 总和缩放到 [BUDGET_LB, BUDGET_UB]，缩放后再次 clip 窗口
    5. 仍不满足 → RuntimeError
    返回 stakes 列表（与 candidates 等长，未启用置 0）
    """
    K = len(candidates)
    if K == 0:
        raise RuntimeError("N=2：窗口剔除后无可行候选")

    target = (N2_WIN_LO + N2_WIN_HI) / 2  # 1700

    def stake_for(odds, t):
        s = round(t / odds / STAKE_STEP) * STAKE_STEP
        if s < STAKE_STEP:
            s = STAKE_STEP
        # clip 到窗口
        max_s = int(N2_WIN_HI / odds / STAKE_STEP) * STAKE_STEP
        import math
        min_s = math.ceil(N2_WIN_LO / odds / STAKE_STEP) * STAKE_STEP
        if min_s < STAKE_STEP:
            min_s = STAKE_STEP
        if max_s < min_s:
            return None
        if s < min_s:
            s = min_s
        elif s > max_s:
            s = max_s
        return s

    stakes = []
    for c in candidates:
        s = stake_for(c["odds"], target)
        if s is None:
            raise RuntimeError(f"N=2：候选 odds={c['odds']:.2f} 找不到合法 stake")
        stakes.append(s)

    total = sum(stakes)

    # 缩放到 [BUDGET_LB, BUDGET_UB]
    if total < BUDGET_LB or total > BUDGET_UB:
        new_target = target * (TOTAL_BUDGET / total) if total > 0 else target
        # 用 new_target 重算，再做 ±2 微调
        stakes = []
        for c in candidates:
            s = stake_for(c["odds"], new_target)
            if s is None:
                raise RuntimeError(f"N=2：缩放后候选 odds={c['odds']:.2f} 找不到合法 stake")
            stakes.append(s)
        total = sum(stakes)

    # 微调（±STAKE_STEP）使 total 落入 [BUDGET_LB, BUDGET_UB]
    safety = 200
    while (total < BUDGET_LB or total > BUDGET_UB) and safety > 0:
        safety -= 1
        if total < BUDGET_LB:
            # 选「odds 最低」（提升空间最大、还在窗口内）的注 +2
            best_idx = None
            for i, c in enumerate(candidates):
                new_s = stakes[i] + STAKE_STEP
                if new_s * c["odds"] <= N2_WIN_HI:
                    if best_idx is None or c["odds"] < candidates[best_idx]["odds"]:
                        best_idx = i
            if best_idx is None:
                raise RuntimeError(f"N=2：total={total} < {BUDGET_LB}，所有注已触及窗口上限，无法补足")
            stakes[best_idx] += STAKE_STEP
        else:  # total > BUDGET_UB
            best_idx = None
            for i, c in enumerate(candidates):
                new_s = stakes[i] - STAKE_STEP
                if new_s >= STAKE_STEP and new_s * c["odds"] >= N2_WIN_LO:
                    if best_idx is None or c["odds"] > candidates[best_idx]["odds"]:
                        best_idx = i
            if best_idx is None:
                raise RuntimeError(f"N=2：total={total} > {BUDGET_UB}，所有注已触及窗口下限，无法削减")
            stakes[best_idx] -= STAKE_STEP
        total = sum(stakes)

    if total < BUDGET_LB or total > BUDGET_UB:
        raise RuntimeError(f"N=2：微调后 total={total} 仍不在 [{BUDGET_LB},{BUDGET_UB}]")

    return stakes


def build_candidates(slots):
    """
    生成串关候选。规则按用户勾选场数 N 分支：
    - N=3：仅 3 串 1。leg 全在 picked 里 → is_user=True；至少 1 条 leg 替换 → is_user=False。
    - N=4：4 串 user + 3 串 AI。
        * 4 串：4 场各取 1 个 leg；is_user=True 当且仅当所有 leg 都在 picked 里（理论上恒成立，因为 4 串候选只在 picked 内枚举）；
                AI 4 串候选 = 不生成（硬性规定）。
        * 3 串：从 4 场里选 3 场，每场取 1 个 leg（来自该场的 picked ∪ 未 picked 全部 outcome）；is_user=False 恒为真。
    - N>=5 或 N<3：报错。
    返回 list of {legs:[(slot_idx, pick), ...], is_user, k_str:3|4}
    """
    by_match = defaultdict(list)
    for i, s in enumerate(slots):
        by_match[s["match_id"]].append(i)

    match_ids = list(by_match.keys())
    N = len(match_ids)
    if N == 1:
        raise RuntimeError("N=1 不支持：单场无法做串关")
    if N == 2:
        raise RuntimeError("N=2 应走 build_n2_candidates 直通路径，不应进入 build_candidates")
    if N < 3 or N > 4:
        raise RuntimeError(f"build_candidates 仅支持 3 或 4 场用户勾选（当前 {N} 场）")

    candidates = []

    if N == 3:
        # 旧逻辑：3 串 1，leg 全 picked → user，否则 AI
        for trio in itertools.combinations(match_ids, 3):
            slot_choices = [by_match[m] for m in trio]
            for slot_combo in itertools.product(*slot_choices):
                for pick_combo in itertools.product(PICK_KEYS, repeat=3):
                    legs = list(zip(slot_combo, pick_combo))
                    user = all(p in slots[si]["picked"] for si, p in legs)
                    candidates.append({"legs": legs, "is_user": user, "k_str": 3})
        return candidates

    # N == 4
    # 4 串 user 候选：每场只从 picked 里选 leg
    slot_choices_4 = [by_match[m] for m in match_ids]
    for slot_combo in itertools.product(*slot_choices_4):
        # 每场可选 pick = 该场 picked 集合
        picked_choices = [list(slots[si]["picked"]) for si in slot_combo]
        if any(len(pc) == 0 for pc in picked_choices):
            continue  # 某场无 picked，理论上不会发生（用户既然勾了这场）
        for pick_combo in itertools.product(*picked_choices):
            legs = list(zip(slot_combo, pick_combo))
            candidates.append({"legs": legs, "is_user": True, "k_str": 4})

    # 3 串 AI 候选：从 4 场里选 3 场，每场任意 outcome（picked 或非 picked 都行），整票恒为 AI
    for trio in itertools.combinations(match_ids, 3):
        slot_choices = [by_match[m] for m in trio]
        for slot_combo in itertools.product(*slot_choices):
            for pick_combo in itertools.product(PICK_KEYS, repeat=3):
                legs = list(zip(slot_combo, pick_combo))
                candidates.append({"legs": legs, "is_user": False, "k_str": 3})

    return candidates


def combo_odds(combo, slots):
    o = 1.0
    for si, p in combo["legs"]:
        o *= slots[si]["outcomes"][p]["odds"]
    return o


def combo_hits(combo, omega, slots):
    """omega 同 slots 等长。组合命中 ⇔ 每个 leg 的 (slot, pick) 在 omega 中匹配"""
    for si, p in combo["legs"]:
        if omega[si] != p:
            return False
    return True


def filter_window_feasible(candidates, slots):
    """剔除单注无任何 stake 能让 stake*odds 落入对应窗口的候选。
    user 候选用 [WIN_LO, WIN_HI]，AI 候选用 [AI_WIN_LO, AI_WIN_HI]。"""
    out = []
    for c in candidates:
        odds = combo_odds(c, slots)
        c["odds"] = odds
        lo, hi = (WIN_LO, WIN_HI) if c["is_user"] else (AI_WIN_LO, AI_WIN_HI)
        if STAKE_STEP * odds > hi:
            continue  # odds 太高，最小 2 元就越上限
        if BUDGET_UB * odds < lo:
            continue  # odds 太低，全押也达不到下限
        out.append(c)
    return out


# ---------- ILP 求解（三阶段 lex） ----------

def solve_ilp(candidates, slots, omegas, stage_label, fix_n_user=None, fix_p_eff=None):
    """
    单阶段求解（v2.2 lex 顺序：N_user → P_eff → N_cov）。
    - 阶段 1（n_user）：max N_user（用户 leg 覆盖数）
    - 阶段 2（p_eff）：固定 N_user = best1，max P_eff
    - 阶段 3（n_cov）：固定 N_user/P_eff，max N_cov
    """
    K = len(candidates)
    M_max = 154

    prob = pulp.LpProblem(f"plan_{stage_label}", pulp.LpMaximize)

    # 整数 stake = step * y_c，y_c ∈ {0..77}
    y = [pulp.LpVariable(f"y_{i}", lowBound=0, upBound=M_max // STAKE_STEP, cat="Integer") for i in range(K)]
    stake = [STAKE_STEP * y[i] for i in range(K)]

    # 每注是否参与（z_c = 1 ⇔ y_c >= 1）
    z = [pulp.LpVariable(f"z_{i}", cat="Binary") for i in range(K)]
    for i in range(K):
        prob += y[i] <= (M_max // STAKE_STEP) * z[i]
        prob += y[i] >= z[i]  # z=1 ⇒ y>=1 (即 stake>=2)

    # v2.1 收益窗口硬约束：若启用某注，stake×odds 必须落入对应窗口
    #   - 用户注：[WIN_LO, WIN_HI] = [900, 2700]
    #   - AI 注：[AI_WIN_LO, AI_WIN_HI] = [600, 3000]
    # big-M：z=0 ⇒ stake=0 ⇒ stake×odds=0；z=1 ⇒ 下沿/上沿生效
    for i in range(K):
        odds_i = candidates[i]["odds"]
        lo, hi = (WIN_LO, WIN_HI) if candidates[i]["is_user"] else (AI_WIN_LO, AI_WIN_HI)
        # 下沿：stake*odds >= lo * z
        prob += stake[i] * odds_i >= lo * z[i]
        # 上沿：stake*odds <= hi + (M_max*odds_i) * (1 - z) ；z=1 时退化为 hi
        prob += stake[i] * odds_i <= hi + (M_max * odds_i) * (1 - z[i])

    # ω 命中指示 e_w
    e = [pulp.LpVariable(f"e_{j}", cat="Binary") for j in range(len(omegas))]
    # payoff_w = ∑ x_c * odds_c * 1[c hits ω]
    BIG = 5000
    for j, omega in enumerate(omegas):
        hit_terms = [stake[i] * candidates[i]["odds"] for i in range(K) if combo_hits(candidates[i], omega, slots)]
        if not hit_terms:
            prob += e[j] == 0
            continue
        payoff = pulp.lpSum(hit_terms)
        # e=1 ⇔ WIN_LO <= payoff <= WIN_HI
        # payoff >= WIN_LO * e ; payoff <= WIN_HI + BIG*(1-e) ; payoff <= BIG (when e=0 anyway harmless)
        # To enforce e=1 only when in window: use two-side big-M
        # If e=0: no constraint forced (but we want e=0 if out of window)
        # If e=1: WIN_LO<=payoff<=WIN_HI
        prob += payoff >= WIN_LO * e[j]
        prob += payoff <= WIN_HI + BIG * (1 - e[j])
        # 反向：若 payoff 在窗口内则可以选 e=1（最大化目标会自动选），不需强制 e=1，因为目标里 e_j 系数为正

    # 用户 leg 覆盖（按 (match_id, market, line, pick) 维度）
    user_leg_keys = []  # list of (slot_idx, pick) where picked
    for si, slot in enumerate(slots):
        for pk in slot["picked"]:
            user_leg_keys.append((si, pk))

    u_cov = [pulp.LpVariable(f"u_{idx}", cat="Binary") for idx in range(len(user_leg_keys))]
    for idx, (si, pk) in enumerate(user_leg_keys):
        # u=1 ⇔ ∃ candidate 含此 leg 且 z_c=1
        related = [z[i] for i, c in enumerate(candidates) if any(s == si and p == pk for s, p in c["legs"])]
        if not related:
            prob += u_cov[idx] == 0
            continue
        prob += u_cov[idx] <= pulp.lpSum(related)
        for zi in related:
            prob += u_cov[idx] >= zi - (1 - 1)  # 单向也行，让 max 推上去

    # 约束
    prob += pulp.lpSum(stake) >= BUDGET_LB
    prob += pulp.lpSum(stake) <= BUDGET_UB
    ai_idx = [i for i in range(K) if not candidates[i]["is_user"]]
    if ai_idx:
        prob += pulp.lpSum(stake[i] for i in ai_idx) <= AI_BUDGET

    # 目标
    P_w = [world_state_prob(om, slots) for om in omegas]
    p_eff_expr = pulp.lpSum(P_w[j] * e[j] for j in range(len(omegas)))
    n_cov_expr = pulp.lpSum(e[j] for j in range(len(omegas)) if P_w[j] > 0)
    n_user_expr = pulp.lpSum(u_cov)

    if stage_label == "n_user":
        prob += n_user_expr
    elif stage_label == "p_eff":
        # N_user 是整数（u_cov Binary 求和），0.5 容差等价于不变
        prob += n_user_expr >= fix_n_user - 0.5
        prob += p_eff_expr
    elif stage_label == "n_cov":
        prob += n_user_expr >= fix_n_user - 0.5
        # 容差 1e-4：吸收 PuLP writeMPS 浮点输出位数差与 CBC 内部 ULP 累积
        # 对 P_eff（典型 0.3-0.7）的实际语义影响 < 0.01%
        prob += p_eff_expr >= fix_p_eff - 1e-4
        prob += n_cov_expr

    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=120)
    t0 = time.perf_counter()
    status = prob.solve(solver)
    elapsed = time.perf_counter() - t0
    print(
        f"[timing] stage={stage_label} slots={len(slots)} |Ω|={len(omegas)} "
        f"K={len(candidates)} solve={elapsed:.3f}s status={pulp.LpStatus[status]}"
    )
    if pulp.LpStatus[status] != "Optimal":
        prob.writeLP(f"/tmp/plan_{stage_label}.lp")
        prob.writeMPS(f"/tmp/plan_{stage_label}.mps")
        raise RuntimeError(f"ILP {stage_label} 未求得最优解：{pulp.LpStatus[status]} (LP saved to /tmp/plan_{stage_label}.lp, MPS to /tmp/plan_{stage_label}.mps)")

    stakes_val = [int(round(pulp.value(stake[i]))) for i in range(K)]
    p_eff_val = sum(P_w[j] for j in range(len(omegas)) if pulp.value(e[j]) > 0.5)
    n_cov_val = int(round(pulp.value(n_cov_expr)))
    n_user_val = int(round(pulp.value(n_user_expr)))
    return {
        "stakes": stakes_val,
        "p_eff": p_eff_val,
        "n_cov": n_cov_val,
        "n_user": n_user_val,
        "user_leg_keys": user_leg_keys,
    }


# ---------- 装配 plan ----------

def make_match_code_sort_key(code):
    return code  # 周一/二/三 字面排序基本可用，前端原样保留


def assemble_plan(passphrase, user, c, slots, candidates, sol, match_idx, source_rec):
    today = datetime.now().strftime("%Y-%m-%d")

    bets = []
    user_idx = ai_idx = 0
    for i, cand in enumerate(candidates):
        st = sol["stakes"][i]
        if st < STAKE_STEP:
            continue
        legs_out = []
        for si, pk in cand["legs"]:
            slot = slots[si]
            m = slot["match"]
            if slot["market"] == "handicap":
                line = slot["line"]
                pick_desc = {"home_win": "让球胜", "draw": "让球平", "away_win": "让球负"}[pk]
            else:
                pick_desc = {"home_win": f"{m['home']}胜", "draw": "平", "away_win": f"{m['away']}胜"}[pk]
            leg_obj = {
                "match_id": m["id"],
                "match_desc": f"{m['home']}vs{m['away']}",
                "code": m["code"],
                "market": slot["market"],
                "pick": pk,
                "pick_desc": pick_desc,
                "odds": slot["outcomes"][pk]["odds"],
            }
            # note: 仅 AI 组合的 leg 才需要批注（用户主选不加 note）
            if not cand["is_user"]:
                if pk in slot["picked"]:
                    # AI 用的 leg 仍在用户勾选集里 → 替用户保留另一勾选
                    leg_obj["note"] = f"← 替你保留 {m['code']} 第二勾选"
                else:
                    # AI 用了用户没勾的 outcome
                    leg_obj["note"] = "（AI 引入）"
            legs_out.append(leg_obj)
        if cand["is_user"]:
            user_idx += 1
            combo_id = f"U{user_idx}"
        else:
            ai_idx += 1
            combo_id = f"A{ai_idx}"
        odds = cand["odds"]
        bets.append({
            "combo_id": combo_id,
            "stake": st,
            "combined_odds": round(odds, 4),
            "potential_return": int(round(st * odds)),
            "p_hit": round(_combo_p(cand, slots), 4),
            "is_user_combo": cand["is_user"],
            "legs": legs_out,
            "hit": None,
            "actual_return": None,
        })

    total_stake = sum(b["stake"] for b in bets)
    user_stake = sum(b["stake"] for b in bets if b["is_user_combo"])
    ai_stake = total_stake - user_stake

    # E[收益] = ∑ P(ω) Payoff(ω, x)；直接遍历 candidates+stakes，避免从 bet 反查
    omegas = enumerate_omegas(slots)
    e_value = 0.0
    for omega in omegas:
        pw = world_state_prob(omega, slots)
        if pw <= 0:
            continue
        payoff = 0.0
        for i, cand in enumerate(candidates):
            st = sol["stakes"][i]
            if st < STAKE_STEP:
                continue
            if combo_hits(cand, omega, slots):
                payoff += st * cand["odds"]
        e_value += pw * payoff

    # 舍弃的用户 leg
    used_user_legs = set()
    for b in bets:
        if not b["is_user_combo"]:
            # AI 组合也可能含某些 user picks
            pass
        for leg in b["legs"]:
            mid = leg["match_id"]
            mkt = leg["market"]
            line = match_idx[mid].get("handicap", {}).get("line") if mkt == "handicap" else None
            used_user_legs.add((mid, mkt, line, leg["pick"]))

    dropped = []
    for slot in slots:
        for pk in slot["picked"]:
            key = (slot["match_id"], slot["market"], slot["line"], pk)
            if key not in used_user_legs:
                m = slot["match"]
                dropped.append({
                    "code": m["code"],
                    "match_desc": f"{m['home']}vs{m['away']}",
                    "market": slot["market"],
                    "line": slot["line"],
                    "pick": pk,
                    "pick_desc": _pick_desc(slot, pk),
                    "odds": slot["outcomes"][pk]["odds"],
                    "reason": "未进入最优分配",
                })

    n_user_actual = sum(1 for s in slots for pk in s["picked"]
                        if (s["match_id"], s["market"], s["line"], pk) in used_user_legs)

    # original_odds_grid
    grid = build_original_odds_grid(slots, match_idx)

    # narrative
    narrative = build_narrative(bets, sol["p_eff"], sol["n_cov"], n_user_actual, dropped, e_value, total_stake, c)

    plan = {
        "date": today,
        "period": today,
        "passphrase": passphrase,
        "source": "plan",
        "submitted_by": user,
        "submitted_at": datetime.now().astimezone().isoformat(),
        "algorithm_version": ALGO_VERSION,
        "confidence_factor_c": c,
        "total_stake": total_stake,
        "user_stake": user_stake,
        "ai_stake": ai_stake,
        "p_eff": round(sol["p_eff"], 6),
        "n_cov": sol["n_cov"],
        "n_user": n_user_actual,
        "expected_value": round(e_value, 2),
        "selected_tier": "progressive",
        "bets": bets,
        "dropped_user_legs": dropped,
        "naive_baseline": _naive_baseline(slots, source_rec, total_stake),
        "status": "pending",
        "optimization_narrative": narrative,
        "original_odds_grid": grid,
    }
    return plan


def _combo_p(cand, slots):
    p = 1.0
    for si, pk in cand["legs"]:
        p *= slots[si]["outcomes"][pk]["p_user"]
    return p


def _pick_desc(slot, pk):
    m = slot["match"]
    if slot["market"] == "handicap":
        return {"home_win": "让球胜", "draw": "让球平", "away_win": "让球负"}[pk]
    return {"home_win": f"{m['home']}胜", "draw": "平", "away_win": f"{m['away']}胜"}[pk]


def build_original_odds_grid(slots, match_idx):
    """每场两行（1x2 + handicap），每行 3 cells"""
    by_match = defaultdict(dict)  # mid -> {market_line: slot}
    for s in slots:
        key = f"{s['market']}@{s['line']}" if s["market"] == "handicap" else "1x2"
        by_match[s["match_id"]][key] = s

    grid = []
    for mid, slot_map in by_match.items():
        m = match_idx[mid]
        rows = []
        # 1x2 行
        if "1x2" in slot_map:
            slot = slot_map["1x2"]
            cells = []
            for pk in PICK_KEYS:
                desc = {"home_win": m["home"], "draw": "平", "away_win": m["away"]}[pk]
                cells.append({
                    "pick": pk,
                    "desc": desc,
                    "odds": slot["outcomes"][pk]["odds"],
                    "picked": pk in slot["picked"],
                })
            rows.append({"market": "1x2", "line": None, "cells": cells})
        # handicap 行
        for k, slot in slot_map.items():
            if not k.startswith("handicap"):
                continue
            cells = []
            line = slot["line"]
            for pk in PICK_KEYS:
                desc = {"home_win": "让胜", "draw": "让平", "away_win": "让负"}[pk]
                cells.append({
                    "pick": pk,
                    "desc": desc,
                    "odds": slot["outcomes"][pk]["odds"],
                    "picked": pk in slot["picked"],
                })
            rows.append({"market": "handicap", "line": line, "cells": cells})
        grid.append({
            "code": m["code"],
            "home": m["home"],
            "away": m["away"],
            "rows": rows,
        })
    return grid


def build_narrative(bets, p_eff, n_cov, n_user, dropped, e_value, total_stake, c):
    lines = []
    user_bets = [b for b in bets if b["is_user_combo"]]
    ai_bets = [b for b in bets if not b["is_user_combo"]]

    # 推断本次的串关结构（看 user 注的 legs 数）
    user_k = max((len(b["legs"]) for b in user_bets), default=0)
    ai_k = max((len(b["legs"]) for b in ai_bets), default=0)
    if user_k and ai_k and user_k != ai_k:
        struct_desc = f"{user_k} 串 user 注 + {ai_k} 串 AI 兜底注"
    elif user_k:
        struct_desc = f"{user_k} 串 1"
    else:
        struct_desc = "混合候选"

    lines.append(
        f"算法 {ALGO_VERSION}（c={c}）枚举 {struct_desc} 候选后做 ILP 分配，"
        f"lex 优先级 N_user → P_eff → N_cov。"
    )
    n_user_total = n_user + len(dropped)
    cov_desc = "全覆盖" if not dropped else f"{n_user}/{n_user_total}"
    lines.append(
        f"用户勾选 leg 覆盖={cov_desc}，"
        f"P(有效命中)={p_eff*100:.2f}%，ω 覆盖={n_cov} 个状态。"
    )

    # 按 stake 由高到低描述 user 注，最大 stake 那注才叫"主注"
    if user_bets:
        sorted_users = sorted(user_bets, key=lambda b: -b["stake"])
        main = sorted_users[0]
        lines.append(
            f"主注 {main['combo_id']} 押 {main['stake']} 元（{user_k} 串 1，赔率 {main['combined_odds']}，到手 {main['potential_return']} 元），"
            f"落入 [900,2700] 用户窗口——尊重用户勾选意图为最高优先级。"
        )
        if len(sorted_users) > 1:
            others = "、".join(f"{b['combo_id']}={b['stake']}元@{b['combined_odds']}" for b in sorted_users[1:])
            lines.append(f"其余 user 注：{others}（同为 {user_k} 串 1，覆盖不同 ω 状态）。")

    if ai_bets:
        ab = ai_bets[0]
        purpose = "兜底覆盖" if user_k > ai_k else "扩大 ω 覆盖"
        lines.append(
            f"AI 用 {ab['stake']} 元（{ab['combo_id']}，{ai_k} 串 1，赔率 {ab['combined_odds']}，到手 {ab['potential_return']} 元）"
            f"做{purpose}，落入 [600,3000] AI 窗口。"
        )

    if dropped:
        lines.append(
            f"未覆盖 {len(dropped)} 条用户勾选："
            + "、".join(f"{d['code']}{d['pick_desc']}" for d in dropped)
            + "（数学约束下含此 leg 的所有候选都进不了对应窗口）。"
        )
    else:
        lines.append("用户勾选 leg 全部被覆盖（含主注 + AI 兜底）。")

    lines.append(
        f"E[收益]={e_value:.2f} 元，总投入 {total_stake} 元，预期净收益 {e_value-total_stake:+.2f} 元"
        f"（仅描述指标，不作为决策依据）。"
    )
    return "\n".join(lines)


def _naive_baseline(slots, source_rec, total_stake):
    """复式 baseline（仅描述用）"""
    # 取第一个用户勾选 leg 的 stake_each = total/n
    n = sum(len(s["picked"]) for s in slots)
    if n == 0:
        return None
    each = total_stake // n if n else 0
    return {
        "description": f"用户勾选 {n} 注复式，每注 {each} 元",
        "stake_each": each,
        "p_eff": 0,
        "n_cov": 0,
        "note": "naive 复式落窗概率取决于实际赔率，仅供对比",
    }


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description="生成 v2.0 投注方案")
    ap.add_argument("--passphrase", required=True, help="预备方案口令")
    ap.add_argument("--user", default="jack", help="登录用户名")
    ap.add_argument("--password", help="密码（默认提示输入）")
    ap.add_argument("--c", type=float, default=DEFAULT_C, help="信心放大因子（默认 0.6）")
    ap.add_argument("--date", help="数据日期 YYYY-MM-DD（默认今天）")
    ap.add_argument("--dry-run", action="store_true", help="只打印 plan，不 POST")
    ap.add_argument("--matches-file", help="本地 matches JSON（dry-run 复盘用，绕过 /api/matches 已重置赔率的问题）")
    args = ap.parse_args()

    if not args.password:
        args.password = os.environ.get("WORLDMONEY_PASSWORD") or getpass.getpass(f"[{args.user}] password: ")

    date = args.date or datetime.now().strftime("%Y-%m-%d")

    print(f"[1/7] 登录 {args.user} ...")
    token = login(args.user, args.password)

    print(f"[2/7] 拉取 picks date={date} ...")
    picks = fetch_picks(token, date)

    print(f"[3/7] 定位 passphrase='{args.passphrase}' 的预备方案 ...")
    pending = find_pending_plan(picks, args.passphrase)
    source_rec = find_source_recommendation(picks, pending)

    # 用 source_rec.legs 作为「用户全部原始勾选」（含同场多选）；fallback 到 pending.legs
    rec_for_picks = source_rec if source_rec else pending

    # period 取首场赛事的 period（recommendation 数据里没有 period 字段，从 leg→match 反查）
    sample_leg = rec_for_picks["legs"][0]
    sample_mid = sample_leg["match_id"]

    # 拿 matches：优先使用 --matches-file（dry-run 复盘）
    matches = None
    period = date
    if args.matches_file:
        print(f"[4/7] 从本地文件 {args.matches_file} 加载 matches ...")
        with open(args.matches_file) as f:
            matches = json.load(f)
            if isinstance(matches, dict) and "matches" in matches:
                matches = matches["matches"]
        match_idx = build_match_index(matches)
    else:
        # 跨 period 合并：单据 leg 可能跨多个售期日（例如 brian 的预备方案
        # 同时含周四001/周五003），所以扫 ±2 天把所有能拉到的 matches 累加
        # 进 match_idx；同 fixture 后写覆盖前。
        from datetime import timedelta
        base = datetime.strptime(date, "%Y-%m-%d")
        match_idx = {}
        periods_used = []
        for delta in [0, -1, 1, -2, 2]:
            p = (base + timedelta(days=delta)).strftime("%Y-%m-%d")
            print(f"[4/7] 拉取 matches period={p} ...")
            try:
                ms = fetch_matches(p)
            except RuntimeError as e:
                print(f"  跳过：{e}")
                continue
            if not ms:
                continue
            periods_used.append(p)
            for m in ms:
                match_idx[m["id"]] = m
        if not match_idx:
            raise RuntimeError(f"无法获取 matches 数据（尝试 {date} ±2 天）")
        period = periods_used[0] if periods_used else date
        print(f"  合并 periods={periods_used}，共 {len(match_idx)} 场赛事")
        matches = list(match_idx.values())

    # 校验：legs 引用的 match_id 全部存在
    legs = rec_for_picks["legs"]
    missing = [l["match_id"] for l in legs if l["match_id"] not in match_idx]
    if missing:
        raise RuntimeError(f"matches 缺失：{missing}（period={period}）")

    print(f"[5/7] 构建 slots / 候选 / 世界状态（c={args.c}）...")
    user_picks = collect_user_picks(rec_for_picks, match_idx)
    slots = build_legs_universe(user_picks, match_idx, args.c)
    print(f"  slots = {len(slots)}, |Ω| = {3**len(slots)}")
    if len(slots) > 6:
        print(f"  ⚠️  slots>6，|Ω|={3**len(slots)} 偏大，求解可能慢")

    # 按 match_id 数量分支：N=1 报错；N=2 直通；N=3/4 走 ILP
    n_matches = len(set(s["match_id"] for s in slots))
    if n_matches == 1:
        raise RuntimeError("N=1 不支持：单场无法做串关")

    if n_matches == 2:
        print("  N=2 → 走直通路径（笛卡尔积 + 窗口过滤 + 等期望分配）...")
        candidates = build_n2_candidates(slots)
        print(f"  raw candidates (N=2) = {len(candidates)}")
        candidates = filter_n2_window(candidates, slots)
        print(f"  window-feasible (N=2) = {len(candidates)}")
        if not candidates:
            raise RuntimeError("N=2：窗口剔除后无可行候选——请调整本金或勾选")
        stakes = solve_n2_stakes(candidates)
        # 计算 p_eff / n_cov（同 ILP 语义：在窗口内的 ω 数与概率和）
        omegas = enumerate_omegas(slots)
        P_w = [world_state_prob(om, slots) for om in omegas]
        p_eff_val = 0.0
        n_cov_val = 0
        for j, om in enumerate(omegas):
            if P_w[j] <= 0:
                continue
            payoff = 0.0
            for i, c in enumerate(candidates):
                if stakes[i] >= STAKE_STEP and combo_hits(c, om, slots):
                    payoff += stakes[i] * c["odds"]
            if N2_WIN_LO <= payoff <= N2_WIN_HI:
                p_eff_val += P_w[j]
                n_cov_val += 1
        # n_user：所有用户勾选 leg 应都被覆盖（笛卡尔覆盖完整）
        user_leg_keys = [(si, pk) for si, s in enumerate(slots) for pk in s["picked"]]
        n_user_val = sum(1 for si, pk in user_leg_keys if any(
            stakes[i] >= STAKE_STEP and (si, pk) in c["legs"] for i, c in enumerate(candidates)
        ))
        sol3 = {
            "stakes": stakes,
            "p_eff": p_eff_val,
            "n_cov": n_cov_val,
            "n_user": n_user_val,
            "user_leg_keys": user_leg_keys,
        }
        print(f"  N=2 stakes = {stakes}, P_eff={p_eff_val*100:.2f}%, N_cov={n_cov_val}, N_user={n_user_val}")
    else:
        candidates = build_candidates(slots)
        print(f"  raw candidates = {len(candidates)}")
        candidates = filter_window_feasible(candidates, slots)
        print(f"  window-feasible = {len(candidates)}")
        if not candidates:
            raise RuntimeError("窗口剔除后无可行候选——请调整本金或勾选")

        omegas = enumerate_omegas(slots)
        print(f"  Ω = {len(omegas)}")

        print("[6/7] ILP 求解（三阶段 lex）...")
        sol1 = solve_ilp(candidates, slots, omegas, "n_user")
        print(f"  阶段 1 N_user = {sol1['n_user']}")
        sol2 = solve_ilp(candidates, slots, omegas, "p_eff", fix_n_user=sol1["n_user"])
        print(f"  阶段 2 P_eff = {sol2['p_eff']*100:.4f}%")
        sol3 = solve_ilp(candidates, slots, omegas, "n_cov", fix_n_user=sol1["n_user"], fix_p_eff=sol2["p_eff"])
        print(f"  阶段 3 N_cov = {sol3['n_cov']}")

    print("[7/7] 装配 plan ...")
    plan = assemble_plan(args.passphrase, args.user, args.c, slots, candidates, sol3, match_idx, source_rec)

    bet_summary = ", ".join(f"{b['combo_id']}={b['stake']}元@{b['combined_odds']:.2f}" for b in plan["bets"])
    print(f"  bets: {bet_summary}")
    print(f"  P_eff={plan['p_eff']*100:.2f}%, N_cov={plan['n_cov']}, n_user={plan['n_user']}, total={plan['total_stake']}")

    if args.dry_run:
        print("\n--- DRY RUN: plan JSON ---")
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return

    print("\n提交 plan 到 /api/submit ...")
    plan["passphrase"] = args.passphrase
    plan["source"] = "plan"
    code, body = http_post(f"{API_BASE}/api/submit", plan, token)
    print(f"  HTTP {code}: {body}")
    if code == 409:
        print("⚠️  口令已存在，未写入 KV。")
        sys.exit(2)
    if code != 200 or not body.get("success"):
        raise RuntimeError(f"提交失败：{body}")
    print("✅ 已写入 KV。")


if __name__ == "__main__":
    main()
