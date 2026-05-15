(function() {
    let startY = 0, pulling = false, refreshing = false;
    const threshold = 80;

    const indicator = document.createElement('div');
    indicator.id = 'pullIndicator';
    indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;display:flex;align-items:center;justify-content:center;background:#f0f0f0;overflow:hidden;transition:height 0.2s;z-index:9999;font-size:13px;color:#666;';
    indicator.textContent = '下拉刷新';
    document.body.prepend(indicator);

    document.addEventListener('touchstart', function(e) {
        if (window.scrollY === 0 && !refreshing) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
        if (!pulling || refreshing) return;
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
        const h = parseInt(indicator.style.height);
        if (h >= threshold) {
            refreshing = true;
            indicator.style.height = '50px';
            indicator.textContent = '刷新中...';
            setTimeout(function() {
                location.reload();
            }, 300);
        } else {
            indicator.style.height = '0';
        }
    });
})();
