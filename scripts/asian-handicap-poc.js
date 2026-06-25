// Asian-handicap parser PoC — verified 2026-06-25
// Source: https://odds.500.com/?id={any_fid_id}
// (Page is a "today's all matches" overview, NOT a single-match detail page.)
//
// Confirmed facts:
//   - HTML encoded GB2312/GBK; needs iconv to UTF-8
//   - Page embeds JavaScript `var yapanList = {...}` containing today's all fixtures
//   - Structure: yapanList[fid_num][cid] = [
//       [open_home_water, open_line, open_away_water],   // 初盘
//       [live_home_water, live_line, live_away_water],   // 即时
//     ]
//   - **bet365 cid = "3"** (verified via cross-reference of HTML Bet365 row
//     showing "0.800 ... 1.050" against yapanList[fid]['3'] = [['0.800','1','1.050'], ...])
//   - All cids observed: 1055, 2, 280, 3, 5, 6, 9
//       - 2 = Macao (澳门)
//       - 3 = Bet365 ✓
//       - 5 = appears in HTML row 2 ("澳门") — may be Macau open/close pair
//       - Others = Pinnacle, William Hill, Betfair, etc (TBD if needed later)
//   - Line is signed-relative-to-home: positive = "home gives away N goals" / 主队让
//   - Two snapshots in array: [0]=open, [1]=current — built-in trend detection
//
// Parse approach (no DOM library needed):
//   1. Fetch page with GBK header
//   2. Regex: /var yapanList\s*=\s*({.+?});/ to extract JSON
//   3. JSON.parse
//   4. For each fid we care about: yapanList[fid]['3']  → bet365 open + current
//   5. Compute trend: line_current vs line_open
//      - If line moved closer to 0 (e.g. -1.0 → -0.5)  = 强队信心降盘 (降盘)
//      - If line moved away from 0 (e.g. -0.5 → -1.0) = 强队信心升盘 (升盘)
//      - If unchanged                                 = stable
//
// Sample parsed output (NOR vs FRA, f1359214, fetched 2026-06-25 19:40 BJ):
//   {
//     fixture_id: "f1359214",
//     bet365: {
//       open:    { home_water: 0.800, line: 1.0, away_water: 1.050 },  // 主队让 1
//       current: { home_water: 1.000, line: 0.5, away_water: 0.850 }, // 主队让 0.5
//       trend:   "降盘",  // line shrank from 1.0 to 0.5 — Norway no longer favored to win by 1 goal
//     }
//   }
//
// Volume estimate: page is ~108KB UTF-8, parse all 18 today's WC fixtures from one fetch.
// Rate-limit friendly: 1 GET per cron tick gives us every fixture's pair simultaneously.

const SAMPLE = {
  fid: '1359214',
  bet365_cid: '3',
  bet365_data: [
    ['0.800', '1', '1.050'],   // open
    ['1.000', '0.5', '0.850'], // current
  ],
};

console.log('See header comment for PoC findings.');
console.log('Sample:', SAMPLE);
