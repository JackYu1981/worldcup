var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-212Qvb/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// index.js
async function fetch500(date) {
  const url = date ? `https://trade.500.com/jczq/?date=${date}` : "https://trade.500.com/jczq/";
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder("gbk");
  return decoder.decode(buf);
}
__name(fetch500, "fetch500");
function parseMatches(html) {
  const matches = [];
  const trRegex = /<tr[^>]*class="bet-tb-tr"[^>]*>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const trStart = trMatch.index;
    const nextTrIdx = html.indexOf('<tr class="bet-tb-tr"', trStart + 1);
    const rowHtml = html.slice(trStart, nextTrIdx > 0 ? nextTrIdx : trStart + 8e3);
    const getAttr = /* @__PURE__ */ __name((name) => {
      const m = rowHtml.match(new RegExp(`data-${name}="([^"]*)"`));
      return m ? m[1] : "";
    }, "getAttr");
    const fixtureId = getAttr("fixtureid");
    const homeName = getAttr("homesxname");
    const awayName = getAttr("awaysxname");
    const matchDate = getAttr("matchdate");
    const matchTime = getAttr("matchtime");
    const rangqiu = getAttr("rangqiu");
    const matchNum = getAttr("matchnum");
    const league = getAttr("simpleleague");
    const codeMatch = matchNum.match(/(\d+)/);
    const code = codeMatch ? codeMatch[1] : "000";
    const nspfOdds = parseOdds(rowHtml, "nspf");
    const spfOdds = parseOdds(rowHtml, "spf");
    const handicap = parseInt(rangqiu) || 0;
    matches.push({
      id: `f${fixtureId}`,
      code,
      league,
      home: homeName,
      away: awayName,
      date: matchDate,
      kickoff: matchTime,
      status: "scheduled",
      score: null,
      odds: {
        home_win: spfOdds["3"] || null,
        draw: spfOdds["1"] || null,
        away_win: spfOdds["0"] || null
      },
      handicap: {
        line: handicap,
        home_win: nspfOdds["3"] || null,
        draw: nspfOdds["1"] || null,
        away_win: nspfOdds["0"] || null
      }
    });
  }
  return matches;
}
__name(parseMatches, "parseMatches");
function parseOdds(rowHtml, type) {
  const odds = {};
  const regex = new RegExp(`data-type="${type}"\\s+data-value="(\\d)"\\s+data-sp="([\\d.]+)"`, "g");
  let m;
  while ((m = regex.exec(rowHtml)) !== null) {
    odds[m[1]] = parseFloat(m[2]);
  }
  return odds;
}
__name(parseOdds, "parseOdds");
async function fetchResults(date) {
  const url = `https://trade.500.com/jczq/result.php?date=${date}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  });
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder("gbk");
  return decoder.decode(buf);
}
__name(fetchResults, "fetchResults");
function parseResults(html) {
  const results = {};
  const scoreRegex = /data-fixtureid="(\d+)"[^>]*data-homescore="(\d+)"[^>]*data-awayscore="(\d+)"/g;
  let m;
  while ((m = scoreRegex.exec(html)) !== null) {
    results[`f${m[1]}`] = { home: parseInt(m[1]), away: parseInt(m[2]), home_score: parseInt(m[2]), away_score: parseInt(m[3]) };
  }
  return results;
}
__name(parseResults, "parseResults");
function mergeResults(matches, results) {
  for (const match of matches) {
    if (results[match.id]) {
      const r = results[match.id];
      match.score = `${r.home_score}-${r.away_score}`;
      match.status = "finished";
    }
  }
  return matches;
}
__name(mergeResults, "mergeResults");
function getBeijingDate(offsetDays = 0) {
  const now = /* @__PURE__ */ new Date();
  const beijing = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  beijing.setDate(beijing.getDate() + offsetDays);
  return beijing.toISOString().slice(0, 10);
}
__name(getBeijingDate, "getBeijingDate");
function getBeijingHour() {
  const now = /* @__PURE__ */ new Date();
  const h = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return h.getHours();
}
__name(getBeijingHour, "getBeijingHour");
function shouldFetchResults(matches) {
  if (!matches || matches.length === 0) return false;
  const now = Date.now();
  const beijingOffset = 8 * 36e5;
  for (const m of matches) {
    if (m.status === "finished") continue;
    const kickoffStr = `${m.date}T${m.kickoff}:00+08:00`;
    const kickoff = new Date(kickoffStr).getTime();
    const matchEnd = kickoff + 120 * 6e4;
    if (now > matchEnd) return true;
  }
  return false;
}
__name(shouldFetchResults, "shouldFetchResults");
var index_default = {
  async scheduled(event, env, ctx) {
    const today = getBeijingDate(0);
    const yesterday = getBeijingDate(-1);
    const hour = getBeijingHour();
    console.log(`[Cron] Running at Beijing hour ${hour}, date ${today}`);
    try {
      const html = await fetch500(null);
      if (!html || html.length < 1e3) {
        console.log("[Cron] Empty page, skipping");
        return;
      }
      const allMatches = parseMatches(html);
      if (allMatches.length === 0) {
        console.log("[Cron] No matches found");
        return;
      }
      const byDate = {};
      allMatches.forEach((m) => {
        if (!byDate[m.date]) byDate[m.date] = [];
        byDate[m.date].push(m);
      });
      for (const [date, matches] of Object.entries(byDate)) {
        const output = {
          date,
          source: "500.com",
          fetched_at: (/* @__PURE__ */ new Date()).toISOString(),
          match_count: matches.length,
          matches
        };
        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(output), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Saved ${matches.length} matches for ${date}`);
      }
    } catch (e) {
      console.error(`[Cron] Odds fetch error: ${e.message}`);
    }
    const resultDates = [today];
    if (hour < 12) resultDates.push(yesterday);
    for (const date of resultDates) {
      try {
        const existing = await env.MATCH_DATA.get(`matches:${date}`, "json");
        if (!existing || !shouldFetchResults(existing.matches)) continue;
        console.log(`[Cron] Fetching results for ${date}...`);
        const resultHtml = await fetchResults(date);
        if (!resultHtml) continue;
        const results = parseResults(resultHtml);
        const updated = mergeResults(existing.matches, results);
        existing.matches = updated;
        existing.fetched_at = (/* @__PURE__ */ new Date()).toISOString();
        await env.MATCH_DATA.put(`matches:${date}`, JSON.stringify(existing), {
          expirationTtl: 86400 * 5
        });
        console.log(`[Cron] Updated results for ${date}`);
      } catch (e) {
        console.error(`[Cron] Results error for ${date}: ${e.message}`);
      }
    }
  },
  async fetch(request, env) {
    return new Response("Scraper worker is running. Use cron triggers.", { status: 200 });
  }
};

// ../../../../.nvm/versions/node/v22.22.1/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.nvm/versions/node/v22.22.1/lib/node_modules/wrangler/templates/middleware/middleware-scheduled.ts
var scheduled = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  const url = new URL(request.url);
  if (url.pathname === "/__scheduled") {
    const cron = url.searchParams.get("cron") ?? "";
    await middlewareCtx.dispatch("scheduled", { cron });
    return new Response("Ran scheduled event");
  }
  const resp = await middlewareCtx.next(request, env);
  if (request.headers.get("referer")?.endsWith("/__scheduled") && url.pathname === "/favicon.ico" && resp.status === 500) {
    return new Response(null, { status: 404 });
  }
  return resp;
}, "scheduled");
var middleware_scheduled_default = scheduled;

// ../../../../.nvm/versions/node/v22.22.1/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-212Qvb/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_scheduled_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// ../../../../.nvm/versions/node/v22.22.1/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-212Qvb/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
