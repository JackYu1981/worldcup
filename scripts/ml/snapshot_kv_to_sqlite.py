#!/usr/bin/env python3
"""
snapshot_kv_to_sqlite.py — one-shot dumper from Cloudflare KV → local SQLite.

Reads the worldcup KV namespace (matches/fixture_mapping/match_lineups/
asian_handicap/match_stats/players) and materializes them into
`scripts/ml/data/ml.db` for fast local ML / backtest work.

Schema (created idempotently, dropped & rebuilt on every run):
  fixtures(fid PK, home_code, away_code, kickoff_beijing, round INT,
           status, fifa_id_match, home_zh, away_zh, score, handicap_line_500)
  asian_handicap(fid PK, current_line, current_home_water, current_away_water,
                 open_line, open_home_water, open_away_water, trend,
                 source TEXT)   -- source = 'crown' for real AH, '500' for inline
  lineups(fid, pid, side, role, shirt, position, PRIMARY KEY(fid, pid))
  substitutions(fid, off_pid, on_pid, minute, period, side)
  players(pid PK, name, country_code, position, tournament_matches_played,
          tournament_minutes_played, tournament_attempt_at_goal,
          tournament_attempt_on_target, tournament_xg)
  match_player_stats(fid, pid, shots, shots_on_target, PRIMARY KEY(fid, pid))

Round inference (group stage only): each team's Nth WC appearance.
  appearance #1 → round 1, #2 → round 2, #3 → round 3.
  Knockouts get round = 99.

Usage:
  python3 scripts/ml/snapshot_kv_to_sqlite.py
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

ACC = '0bf8afedf1e0b911f3c1733e93546b71'
NS  = '278f1209ffd84662bd51921370a2fbe9'
ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, 'data', 'ml.db')


def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}', file=sys.stderr, flush=True)


def get_cf_token():
    r = subprocess.run(
        ['security', 'find-generic-password', '-s', 'cloudflare-api-token', '-w'],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip()


CF_TOK = get_cf_token()


def kv_list(prefix):
    out, cursor = [], None
    while True:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
               f'/storage/kv/namespaces/{NS}/keys?prefix={urllib.parse.quote(prefix)}')
        if cursor:
            url += f'&cursor={urllib.parse.quote(cursor)}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        out.extend(j.get('result', []))
        cursor = (j.get('result_info') or {}).get('cursor')
        if not cursor:
            break
    return [r['name'] for r in out]


def kv_get(key):
    url = (f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
           f'/storage/kv/namespaces/{NS}/values/{urllib.parse.quote(key, safe="")}')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {CF_TOK}'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return body.decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < 2:
                time.sleep(1 + attempt); continue
            raise
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt < 2:
                time.sleep(1 + attempt); continue
            raise


# ============= Schema =============
SCHEMA = """
DROP TABLE IF EXISTS fixtures;
DROP TABLE IF EXISTS asian_handicap;
DROP TABLE IF EXISTS lineups;
DROP TABLE IF EXISTS substitutions;
DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS match_player_stats;

CREATE TABLE fixtures (
    fid TEXT PRIMARY KEY,
    home_code TEXT,
    away_code TEXT,
    kickoff_beijing TEXT,
    kickoff_utc TEXT,
    round INTEGER,
    status TEXT,
    fifa_id_match TEXT,
    home_zh TEXT,
    away_zh TEXT,
    score TEXT,
    handicap_line_500 REAL
);

CREATE TABLE asian_handicap (
    fid TEXT PRIMARY KEY,
    current_line REAL,
    current_home_water REAL,
    current_away_water REAL,
    open_line REAL,
    open_home_water REAL,
    open_away_water REAL,
    trend TEXT,
    source TEXT
);

CREATE TABLE lineups (
    fid TEXT,
    pid TEXT,
    side TEXT,
    role TEXT,
    shirt INTEGER,
    position INTEGER,
    PRIMARY KEY (fid, pid)
);

CREATE TABLE substitutions (
    fid TEXT,
    off_pid TEXT,
    on_pid TEXT,
    minute TEXT,
    period INTEGER,
    side TEXT
);

CREATE TABLE players (
    pid TEXT PRIMARY KEY,
    name TEXT,
    country_code TEXT,
    position INTEGER,
    tournament_matches_played INTEGER,
    tournament_minutes_played INTEGER,
    tournament_attempt_at_goal INTEGER,
    tournament_attempt_on_target INTEGER,
    tournament_xg REAL
);

CREATE TABLE match_player_stats (
    fid TEXT,
    pid TEXT,
    shots INTEGER,
    shots_on_target INTEGER,
    PRIMARY KEY (fid, pid)
);

CREATE INDEX idx_lineups_fid ON lineups(fid);
CREATE INDEX idx_subs_fid ON substitutions(fid);
CREATE INDEX idx_stats_fid ON match_player_stats(fid);
CREATE INDEX idx_fixtures_round ON fixtures(round);
"""


def ensure_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


# ============= Ingestion =============
def collect_wc_fixtures():
    """Walk matches:* buckets, return list of WC match dicts."""
    log('Listing matches:* buckets...')
    keys = kv_list('matches:')
    log(f'  found {len(keys)} day buckets')
    fixtures = []
    for k in sorted(keys):
        bucket = kv_get(k)
        if not bucket or 'matches' not in bucket:
            continue
        for m in bucket['matches']:
            if m.get('league') != '世界杯':
                continue
            fixtures.append(m)
    # de-dupe by id (a fixture may appear in two date buckets due to timezone)
    seen = {}
    for m in fixtures:
        fid = m.get('id')
        if not fid:
            continue
        if fid not in seen:
            seen[fid] = m
    log(f'  total unique WC fixtures: {len(seen)}')
    return list(seen.values())


def infer_rounds(fixtures, mappings):
    """Group stage round inference by team appearance order (by kickoff)."""
    # Order by kickoff
    items = []
    for f in fixtures:
        fid = f.get('id')
        if not fid:
            continue
        mp = mappings.get(fid, {})
        ko = mp.get('kickoff_utc') or f.get('kickoff') or ''
        items.append((ko, fid, mp.get('home_code'), mp.get('away_code')))
    items.sort()
    team_count = {}
    rounds = {}
    for ko, fid, hc, ac in items:
        if not hc or not ac:
            rounds[fid] = None
            continue
        team_count[hc] = team_count.get(hc, 0) + 1
        team_count[ac] = team_count.get(ac, 0) + 1
        n = max(team_count[hc], team_count[ac])
        # 1..3 = group stage; 4+ = knockout (one team will hit 4)
        rounds[fid] = n if n <= 3 else 99
    return rounds


def dump_fixtures(conn, fixtures, mappings, rounds):
    cur = conn.cursor()
    for f in fixtures:
        fid = f.get('id')
        if not fid:
            continue
        mp = mappings.get(fid, {})
        h = f.get('handicap') or {}
        cur.execute("""
            INSERT INTO fixtures (fid, home_code, away_code, kickoff_beijing,
                kickoff_utc, round, status, fifa_id_match, home_zh, away_zh,
                score, handicap_line_500)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            fid,
            mp.get('home_code'),
            mp.get('away_code'),
            mp.get('kickoff_local_beijing') or f.get('kickoff'),
            mp.get('kickoff_utc'),
            rounds.get(fid),
            f.get('status'),
            mp.get('fifa_id_match'),
            f.get('home'),
            f.get('away'),
            f.get('score'),
            h.get('line'),
        ))
    conn.commit()


def dump_asian_handicap(conn, fids):
    """Pulls real crown AH for fids that have one; falls back to 500 inline line.
    """
    log('Pulling asian_handicap:* records...')
    cur = conn.cursor()
    ah_keys = set(kv_list('asian_handicap:'))
    n_crown = 0
    n_500 = 0
    for fid in fids:
        key = f'asian_handicap:{fid}'
        if key in ah_keys:
            rec = kv_get(key)
            if rec and isinstance(rec, dict) and rec.get('current'):
                cur.execute("""
                    INSERT OR REPLACE INTO asian_handicap
                    (fid, current_line, current_home_water, current_away_water,
                     open_line, open_home_water, open_away_water, trend, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'crown')
                """, (
                    fid,
                    (rec.get('current') or {}).get('line'),
                    (rec.get('current') or {}).get('home_water'),
                    (rec.get('current') or {}).get('away_water'),
                    (rec.get('open') or {}).get('line'),
                    (rec.get('open') or {}).get('home_water'),
                    (rec.get('open') or {}).get('away_water'),
                    rec.get('trend') or 'stable',
                ))
                n_crown += 1
                continue
        # Fall back to 500.com inline handicap from fixtures table
        row = cur.execute(
            "SELECT handicap_line_500 FROM fixtures WHERE fid=?", (fid,)
        ).fetchone()
        if row and row[0] is not None:
            cur.execute("""
                INSERT OR REPLACE INTO asian_handicap
                (fid, current_line, current_home_water, current_away_water,
                 open_line, open_home_water, open_away_water, trend, source)
                VALUES (?, ?, NULL, NULL, ?, NULL, NULL, 'stable', '500')
            """, (fid, row[0], row[0]))
            n_500 += 1
    conn.commit()
    log(f'  crown AH: {n_crown}, 500 inline fallback: {n_500}')


def dump_lineups_and_subs(conn, fids):
    log('Pulling match_lineups:* records...')
    cur = conn.cursor()
    n_lineups = 0
    n_subs = 0
    for fid in fids:
        rec = kv_get(f'match_lineups:{fid}')
        if not rec or not isinstance(rec, dict):
            continue
        if not rec.get('lineup_available'):
            continue
        for side in ('home', 'away'):
            team = rec.get(side) or {}
            for stub in team.get('starting') or []:
                cur.execute("""
                    INSERT OR IGNORE INTO lineups (fid, pid, side, role, shirt, position)
                    VALUES (?, ?, ?, 'starter', ?, ?)
                """, (fid, str(stub.get('player_id')), side,
                      stub.get('shirt_number'), stub.get('position')))
            for stub in team.get('substitutes') or []:
                cur.execute("""
                    INSERT OR IGNORE INTO lineups (fid, pid, side, role, shirt, position)
                    VALUES (?, ?, ?, 'substitute', ?, ?)
                """, (fid, str(stub.get('player_id')), side,
                      stub.get('shirt_number'), stub.get('position')))
        events = rec.get('events') or {}
        for sub in events.get('substitutions') or []:
            cur.execute("""
                INSERT INTO substitutions (fid, off_pid, on_pid, minute, period, side)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (fid, str(sub.get('off_player_id')), str(sub.get('on_player_id')),
                  sub.get('minute'), sub.get('period'), sub.get('side')))
            n_subs += 1
        n_lineups += 1
    conn.commit()
    log(f'  ingested lineups for {n_lineups} fixtures, {n_subs} substitutions')


def dump_match_stats(conn, fids):
    log('Pulling match_stats:* records...')
    cur = conn.cursor()
    n = 0
    for fid in fids:
        rec = kv_get(f'match_stats:{fid}')
        if not rec or not isinstance(rec, dict):
            continue
        players = rec.get('players') or {}
        for pid, ps in players.items():
            if not isinstance(ps, dict):
                continue
            cur.execute("""
                INSERT OR REPLACE INTO match_player_stats
                (fid, pid, shots, shots_on_target)
                VALUES (?, ?, ?, ?)
            """, (fid, str(pid),
                  int(ps.get('shots') or 0),
                  int(ps.get('shots_on_target') or 0)))
        n += 1
    conn.commit()
    log(f'  ingested match_stats for {n} fixtures')


def dump_players(conn):
    log('Listing players:* keys...')
    keys = kv_list('players:')
    log(f'  found {len(keys)} player keys; fetching in batches...')
    cur = conn.cursor()
    n = 0
    for i, k in enumerate(keys):
        rec = kv_get(k)
        if not rec or not isinstance(rec, dict):
            continue
        ts = rec.get('tournament_stats') or {}
        att = ts.get('attacking') or {}
        cur.execute("""
            INSERT OR REPLACE INTO players
            (pid, name, country_code, position,
             tournament_matches_played, tournament_minutes_played,
             tournament_attempt_at_goal, tournament_attempt_on_target,
             tournament_xg)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            str(rec.get('id')),
            rec.get('name_default') or (rec.get('name') or {}).get('eng'),
            rec.get('country_code'),
            rec.get('position'),
            ts.get('matches_played') or 0,
            ts.get('minutes_played') or 0,
            att.get('attempt_at_goal') or 0,
            att.get('attempt_at_goal_on_target') or 0,
            att.get('xg') or 0,
        ))
        n += 1
        if (i + 1) % 100 == 0:
            log(f'    {i+1}/{len(keys)} players ingested')
            conn.commit()
    conn.commit()
    log(f'  total players ingested: {n}')


def main():
    t0 = time.time()
    log(f'Snapshot starting → {DB_PATH}')
    conn = ensure_db()

    # 1) WC fixtures from matches:* buckets
    fixtures = collect_wc_fixtures()

    # 2) fixture_mapping for codes + UTC kickoff
    log('Listing fixture_mapping:* keys...')
    mp_keys = kv_list('fixture_mapping:')
    mappings = {}
    for k in mp_keys:
        fid = k.split(':', 1)[1]
        rec = kv_get(k)
        if rec and isinstance(rec, dict):
            mappings[fid] = rec
    log(f'  mappings: {len(mappings)}')

    rounds = infer_rounds(fixtures, mappings)
    dump_fixtures(conn, fixtures, mappings, rounds)
    fids = [f['id'] for f in fixtures if f.get('id')]

    dump_asian_handicap(conn, fids)
    dump_lineups_and_subs(conn, fids)
    dump_match_stats(conn, fids)
    dump_players(conn)

    # Stats
    cur = conn.cursor()
    log('=== Summary ===')
    for tbl in ('fixtures', 'asian_handicap', 'lineups', 'substitutions',
                'players', 'match_player_stats'):
        n = cur.execute(f'SELECT COUNT(*) FROM {tbl}').fetchone()[0]
        log(f'  {tbl}: {n}')
    log('Round breakdown:')
    for r, n in cur.execute("""
        SELECT round, COUNT(*) FROM fixtures GROUP BY round ORDER BY round
    """).fetchall():
        log(f'  round={r}: {n}')
    log('Finished WC fixtures with match_stats:')
    n = cur.execute("""
        SELECT COUNT(DISTINCT f.fid) FROM fixtures f
        JOIN match_player_stats mps ON mps.fid = f.fid
        WHERE f.status = 'finished'
    """).fetchone()[0]
    log(f'  {n}')
    conn.close()
    log(f'Done in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
