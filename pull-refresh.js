/**
 * Pull-to-refresh + infinite scroll for incremental date loading.
 *
 * Usage: initPullRefresh({ onRefresh, onLoadMore })
 * - onRefresh(): called on pull-down, should reload current data
 * - onLoadMore(): called on scroll-to-bottom, should load older data
 */
function initPullRefresh(opts = {}) {
  const { onRefresh, onLoadMore } = opts;
  let startY = 0, pulling = false, refreshing = false;
  const threshold = 80;

  const indicator = document.createElement('div');
  indicator.id = 'pullIndicator';
  indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;display:flex;align-items:center;justify-content:center;background:#f0f0f0;overflow:hidden;transition:height 0.2s;z-index:9999;font-size:13px;color:#666;';
  indicator.textContent = '下拉刷新';
  document.body.prepend(indicator);

  // GUARD: when ANY modal/sheet is visible, page-level pull-refresh is fully
  // disabled. Two cases this catches that the previous target-based guard
  // missed:
  //   1. Large drag: finger physically leaves the sheet's bounding box → target
  //      becomes <body>, target-based guard fails, refresh fires.
  //   2. iOS rubber-band: when the sheet's own pull-refresh has consumed the
  //      gesture and the user keeps dragging, the OS rubber-bands the entire
  //      body — subsequent touchmoves can target body. Same failure mode.
  // The visibility check is invariant to where the finger physically is.
  const SHEET_SELECTOR = '.lineup-sheet, .player-sheet, .stats-sheet';
  function anySheetOpen() {
    return !!document.querySelector(SHEET_SELECTOR + '.visible');
  }

  document.addEventListener('touchstart', function(e) {
    if (anySheetOpen()) { pulling = false; return; }
    if (window.scrollY === 0 && !refreshing) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!pulling || refreshing) return;
    if (anySheetOpen()) { pulling = false; indicator.style.height = '0'; return; }
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && window.scrollY === 0) {
      const h = Math.min(dy * 0.5, threshold + 20);
      indicator.style.height = h + 'px';
      indicator.textContent = h >= threshold ? '释放刷新' : '下拉刷新';
    }
  }, { passive: true });

  document.addEventListener('touchend', function() {
    if (!pulling) return;
    pulling = false;
    // Final gate: even if pulling latched true before a sheet opened mid-gesture,
    // we don't fire the page refresh while a sheet is up.
    if (anySheetOpen()) { indicator.style.height = '0'; return; }
    const h = parseInt(indicator.style.height);
    if (h >= threshold && onRefresh) {
      refreshing = true;
      indicator.style.height = '50px';
      indicator.textContent = '刷新中...';
      Promise.resolve(onRefresh()).finally(() => {
        refreshing = false;
        indicator.style.height = '0';
      });
    } else {
      indicator.style.height = '0';
    }
  });

  // Infinite scroll: load more when near bottom
  if (onLoadMore) {
    let loadingMore = false;
    let noMore = false;
    const loadMoreIndicator = document.createElement('div');
    loadMoreIndicator.id = 'loadMoreIndicator';
    loadMoreIndicator.style.cssText = 'text-align:center;padding:16px;font-size:13px;color:#999;display:none;';
    document.body.appendChild(loadMoreIndicator);

    window.addEventListener('scroll', function() {
      if (loadingMore) return;
      // Skip infinite scroll while any sheet is open — sheets have their own
      // scroll containers; we don't want loading more dates behind a modal.
      if (document.querySelector(SHEET_SELECTOR + '.visible')) return;
      const scrollBottom = window.innerHeight + window.scrollY;
      if (scrollBottom >= document.body.offsetHeight - 100) {
        if (noMore) {
          loadMoreIndicator.textContent = '没有更多数据了';
          loadMoreIndicator.style.display = 'block';
          setTimeout(function() { loadMoreIndicator.style.display = 'none'; }, 1500);
          return;
        }
        loadingMore = true;
        loadMoreIndicator.textContent = '一大波数据正在赶来...';
        loadMoreIndicator.style.display = 'block';
        Promise.resolve(onLoadMore()).then(function(result) {
          if (result === false) {
            noMore = true;
            loadMoreIndicator.textContent = '没有更多数据了';
            setTimeout(function() { loadMoreIndicator.style.display = 'none'; }, 1500);
          } else {
            loadMoreIndicator.style.display = 'none';
          }
          loadingMore = false;
        }).catch(function() {
          loadMoreIndicator.style.display = 'none';
          loadingMore = false;
        });
      }
    });
  }
}
