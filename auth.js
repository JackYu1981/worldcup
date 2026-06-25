const AUTH = {
    // One-time migration: if a token is in sessionStorage (old behavior), move
    // it into localStorage so users stay logged in after closing the browser.
    _migrate() {
        try {
            const oldTok = sessionStorage.getItem('auth_token');
            if (oldTok && !localStorage.getItem('auth_token')) {
                localStorage.setItem('auth_token', oldTok);
                const u = sessionStorage.getItem('auth_user');
                if (u) localStorage.setItem('auth_user', u);
            }
            // Clean up sessionStorage to avoid confusion
            sessionStorage.removeItem('auth_token');
            sessionStorage.removeItem('auth_user');
        } catch (_) {}
    },
    getToken() {
        this._migrate();
        return localStorage.getItem('auth_token');
    },
    getUser() {
        this._migrate();
        const u = localStorage.getItem('auth_user');
        return u ? JSON.parse(u) : null;
    },
    isLoggedIn() {
        return !!this.getToken();
    },
    logout() {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        // Also clean session storage in case anything is left
        sessionStorage.removeItem('auth_token');
        sessionStorage.removeItem('auth_user');
        location.reload();
    },
    headers() {
        const h = { 'Content-Type': 'application/json' };
        const token = this.getToken();
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
    },
    async login(username, password) {
        const resp = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json();
        if (data.success) {
            localStorage.setItem('auth_token', data.token);
            localStorage.setItem('auth_user', JSON.stringify(data.user));
            return { success: true, user: data.user };
        }
        return { success: false, error: data.error };
    },
    showLoginModal(onSuccess) {
        if (document.getElementById('loginOverlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'loginOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

        overlay.innerHTML = `
            <div style="background:white;border-radius:16px;width:100%;max-width:320px;padding:28px;animation:modalPop 0.3s ease;">
                <h3 style="font-size:18px;margin-bottom:4px;color:#333;text-align:center;">⚽ 登录</h3>
                <p style="font-size:12px;color:#888;text-align:center;margin-bottom:20px;">世界杯投注助手</p>
                <input id="loginUser" type="text" placeholder="用户名" autocomplete="username"
                    style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:10px;outline:none;">
                <input id="loginPass" type="password" placeholder="密码" autocomplete="current-password"
                    style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:14px;outline:none;">
                <div id="loginError" style="color:#c62828;font-size:12px;margin-bottom:10px;display:none;text-align:center;"></div>
                <button id="loginBtn" style="width:100%;padding:12px;background:#1a73e8;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">
                    登录
                </button>
            </div>`;

        document.body.appendChild(overlay);

        const userInput = document.getElementById('loginUser');
        const passInput = document.getElementById('loginPass');
        const btn = document.getElementById('loginBtn');
        const errEl = document.getElementById('loginError');

        userInput.focus();

        async function doLogin() {
            const username = userInput.value.trim();
            const password = passInput.value.trim();
            if (!username || !password) return;

            btn.disabled = true;
            btn.textContent = '登录中...';
            errEl.style.display = 'none';

            const result = await AUTH.login(username, password);
            if (result.success) {
                overlay.remove();
                if (onSuccess) onSuccess(result.user);
            } else {
                errEl.textContent = result.error;
                errEl.style.display = 'block';
                btn.disabled = false;
                btn.textContent = '登录';
                passInput.value = '';
                passInput.focus();
            }
        }

        btn.onclick = doLogin;
        passInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
        userInput.onkeydown = (e) => { if (e.key === 'Enter') passInput.focus(); };
    },
    requireLogin(onSuccess) {
        if (this.isLoggedIn()) {
            if (onSuccess) onSuccess(this.getUser());
            return;
        }
        this.showLoginModal(onSuccess);
    },
    renderUserBadge(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const user = this.getUser();
        if (user) {
            container.innerHTML = `👤 ${user.username} <a href="#" onclick="AUTH.logout();return false;">退出</a>`;
        }
    }
};
