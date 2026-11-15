(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n, sign = false) => {
    const s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    return (n < 0 ? '−$' : (sign && n > 0 ? '+$' : '$')) + s;
  };
  const cls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
  const localISO = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const num = s => parseFloat(String(s ?? '').replace(/[$,%\s]/g, '').replace('−', '-'));

  function toast(msg, kind = 'ok') {
    const t = $('#toast');
    $('span', t).textContent = msg;
    $('use', t).setAttribute('href', kind === 'err' ? '#i-x' : '#i-check');
    t.classList.toggle('err', kind === 'err');
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), kind === 'err' ? 4200 : 2200);
  }

  /* ---------- constants ---------- */
  const MISTAKES = ['None', 'Oversize', 'Moved SL', 'Revenge Trade', 'Late Entry', 'Early Exit', 'No Plan', 'Broke Rules'];
  const DEFAULT_ACCOUNTS = [{ name: 'Main account', start: 50000 }, { name: 'Prop eval', start: 100000 }];
  const DEFAULT_LIMITS = { daily: '2%', risk: '0.5%', rr: '1:2', max: '3' };
  const KV_KEYS = ['plan', 'limits', 'never', 'routine'];
  const SAMPLE = [
    ['2026-10-21', '08:42', 'NQ', 'Long', 'London', '+SMT', 'Win', 250, 640, ['None']],
    ['2026-10-22', '09:51', 'EURUSD', 'Short', 'New York', '-SMT', 'Loss', 250, -250, ['Late Entry']],
    ['2026-10-23', '10:05', 'XAUUSD', 'Long', 'New York', '+SMT', 'Win', 250, 815, ['None']],
    ['2026-10-24', '07:18', 'GBPUSD', 'Short', 'London', '+SMT', 'BE', 250, 0, ['Early Exit']],
    ['2026-10-28', '09:37', 'NQ', 'Short', 'New York', '-SMT', 'Loss', 250, -385, ['Moved SL']],
    ['2026-10-29', '10:12', 'ES', 'Long', 'New York', '+SMT', 'Win', 250, 1120, ['None']],
    ['2026-10-30', '08:03', 'EURUSD', 'Long', 'London', '-SMT', 'Loss', 250, -250, ['Revenge Trade']],
    ['2026-11-03', '01:26', 'XAUUSD', 'Short', 'Tokyo', '+SMT', 'BE', 250, 0, ['None']],
    ['2026-11-04', '09:44', 'NQ', 'Long', 'New York', '+SMT', 'Win', 250, 1480, ['None']],
    ['2026-11-06', '07:55', 'GBPUSD', 'Long', 'London', '-SMT', 'Loss', 250, -410, ['Oversize']],
    ['2026-11-10', '10:21', 'ES', 'Short', 'New York', '+SMT', 'Loss', 250, -250, ['None']]
  ].map((r, i) => ({ id: 's' + i, date: r[0], time: r[1], pair: r[2], direction: r[3], session: r[4], strategy: r[5], status: r[6], risk: r[7], pl: r[8], mistakes: r[9], account: 'Main account', note: '' }));

  /* ---------- data layer ---------- */
  const cfg = window.KEEL_CONFIG || window.TAPEBOOK_CONFIG || window.PINEWICK_CONFIG || {};
  const REMOTE = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const sb = REMOTE && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  let user = null;
  /* auth links (password reset, expired links) arrive with details in the URL hash */
  const URL_HASH = new URLSearchParams(location.hash.slice(1));
  let recovering = URL_HASH.get('type') === 'recovery';
  const urlAuthError = URL_HASH.get('error_description');

  const local = {
    get(k, d) { try { const v = localStorage.getItem('pw.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pw.' + k, JSON.stringify(v)); return true; } catch { return false; } }
  };

  const fromRow = r => ({
    id: r.id, pair: r.pair, date: r.trade_date, time: r.trade_time || '—', account: r.account,
    direction: r.direction, session: r.session, strategy: r.strategy, status: r.status,
    risk: Number(r.risk), pl: Number(r.pl), mistakes: r.mistakes?.length ? r.mistakes : ['None'], note: r.note || '',
    shots: r.screenshots || []
  });
  const toRow = t => ({
    user_id: user.id, pair: t.pair, trade_date: t.date, trade_time: t.time, account: t.account,
    direction: t.direction, session: t.session, strategy: t.strategy, status: t.status,
    risk: t.risk, pl: t.pl, mistakes: t.mistakes, note: t.note,
    ...(t.shots?.length ? { screenshots: t.shots } : {})
  });
  const BUCKET = 'trade-screenshots';
  const urlCache = new Map();
  const MAX_SHOTS = 4;
  const check = ({ data, error }) => { if (error) throw error; return data; };

  const api = REMOTE ? {
    async session() { return check(await sb.auth.getSession()).session; },
    async loadAll() {
      const [t, a, k] = await Promise.all([
        sb.from('trades').select('*').order('trade_date').order('trade_time'),
        sb.from('accounts').select('*').order('created_at'),
        sb.from('user_kv').select('key,value')
      ]);
      let accounts = check(a);
      if (!accounts.length) {
        accounts = check(await sb.from('accounts')
          .insert(DEFAULT_ACCOUNTS.map(x => ({ user_id: user.id, name: x.name, start_balance: x.start }))).select());
      }
      return {
        trades: check(t).map(fromRow),
        accounts: accounts.map(r => ({ id: r.id, name: r.name, start: Number(r.start_balance) })),
        kv: Object.fromEntries(check(k).map(r => [r.key, r.value]))
      };
    },
    async addTrade(t, blobs = []) {
      const paths = [];
      try {
        for (const b of blobs) {
          const ext = b.type === 'image/webp' ? 'webp' : b.type === 'image/png' ? 'png' : 'jpg';
          const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
          check(await sb.storage.from(BUCKET).upload(path, b, { contentType: b.type, upsert: false }));
          paths.push(path);
        }
        return fromRow(check(await sb.from('trades').insert(toRow({ ...t, shots: paths })).select().single()));
      } catch (e) {
        if (paths.length) sb.storage.from(BUCKET).remove(paths).catch(() => {});
        if (/bucket not found|screenshots.*column|column.*screenshots/i.test(e?.message || '')) {
          throw new Error('Screenshots are not set up yet. Run supabase/002_screenshots.sql in the Supabase SQL editor, then try again.');
        }
        throw e;
      }
    },
    async deleteTrade(id) {
      const t = trades.find(x => x.id === id);
      check(await sb.from('trades').delete().eq('id', id));
      if (t?.shots?.length) sb.storage.from(BUCKET).remove(t.shots).catch(() => {});
    },
    async signPaths(paths) {
      const now = Date.now(), need = paths.filter(p => !(urlCache.get(p)?.exp > now));
      if (need.length) {
        const data = check(await sb.storage.from(BUCKET).createSignedUrls(need, 3600));
        data.forEach(d => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 55 * 60 * 1000 }); });
      }
      return Object.fromEntries(paths.map(p => [p, urlCache.get(p)?.url || '']));
    },
    async shotUrls(t) { const m = await this.signPaths(t.shots); return t.shots.map(p => m[p]).filter(Boolean); },
    async updateAccount(id, start) { check(await sb.from('accounts').update({ start_balance: start }).eq('id', id)); },
    async setKV(key, value) {
      check(await sb.from('user_kv').upsert({ user_id: user.id, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }));
    }
  } : {
    async session() { return null; },
    async loadAll() {
      const kv = {};
      KV_KEYS.forEach(k => { const v = local.get(k); if (v !== undefined) kv[k] = v; });
      if (!kv.routine) kv.routine = seedRoutine();
      return {
        trades: local.get('trades', SAMPLE),
        accounts: local.get('accounts', DEFAULT_ACCOUNTS.map((a, i) => ({ id: 'a' + i, ...a }))),
        kv
      };
    },
    async addTrade(t, blobs = []) {
      const shots = await Promise.all(blobs.map(b => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); })));
      const saved = { ...t, shots, id: 'l' + Date.now() };
      if (!local.set('trades', [...trades, saved])) throw new Error('This browser has no room left for those screenshots. Remove one, or connect Supabase to store them in the cloud.');
      return saved;
    },
    async deleteTrade(id) { local.set('trades', trades.filter(t => t.id !== id)); },
    async signPaths(paths) { return Object.fromEntries(paths.map(p => [p, p])); },
    async shotUrls(t) { return t.shots || []; },
    async updateAccount(id, start) { local.set('accounts', accounts.map(a => a.id === id ? { ...a, start } : a)); },
    async setKV(key, value) { local.set(key, value); }
  };

  /* ---------- state ---------- */
  let trades = [], accounts = [], kv = {};
  const getKV = (k, d) => kv[k] ?? d;
  async function putKV(k, v) {
    const prev = kv[k];
    kv[k] = v;
    try { await api.setKV(k, v); return true; }
    catch (e) { kv[k] = prev; toast(errText(e, 'Could not save. Check your connection.'), 'err'); return false; }
  }
  const errText = (e, fallback) => (e && e.message && !/fetch/i.test(e.message)) ? e.message : fallback;

  function seedRoutine() {
    const o = {}, seeds = [6, 5, 4, 6, 6, 3, 5, 6, 2, 5, 6, 6, 4, 5, 6, 5, 3, 6, 6, 5, 4, 6, 5, 6, 6, 4, 5];
    const d = new Date(); let k = 0;
    while (k < seeds.length) { d.setDate(d.getDate() - 1); if (d.getDay() % 6) o[localISO(d)] = [...Array(seeds[k++]).keys()]; }
    return o;
  }

  /* ---------- app states: boot / auth / app / error ---------- */
  const setState = s => { document.body.dataset.state = s; };
  function showError(message, retry) {
    $('#boot-msg').textContent = message;
    $('#boot-retry').hidden = !retry;
    $('#boot-bar').hidden = true;
    setState('error');
  }

  async function boot() {
    setState('boot');
    $('#boot-msg').textContent = 'Loading your journal';
    $('#boot-retry').hidden = true;
    $('#boot-bar').hidden = false;
    if (REMOTE && !sb) return showError('The database client did not load. Check your internet connection, then retry.', true);
    try {
      if (REMOTE) {
        const s = await api.session();
        if (!s) {
          setState('auth'); setAuthMode('signin');
          if (urlAuthError) { authMsg(/expired|invalid/i.test(urlAuthError) ? 'That link has expired or was already used. Choose “Forgot password?” to get a new one.' : urlAuthError); history.replaceState(null, '', location.pathname); }
          return;
        }
        user = s.user;
        if (recovering) { setState('auth'); setAuthMode('newpass'); $('#a-pass').focus(); return; }
      }
      await start();
    } catch (e) {
      showError(errText(e, 'Could not reach the database. Check your connection, then retry.'), true);
    }
  }

  let wired = false;
  async function start() {
    setState('boot');
    const data = await api.loadAll();
    trades = data.trades; accounts = data.accounts; kv = data.kv;
    if (!wired) { wireStateful(); wired = true; }
    renderSync();
    setState('app');
    route();
  }

  $('#boot-retry').onclick = boot;

  /* ---------- auth ---------- */
  let authMode = 'signin';
  const AUTH_COPY = {
    signin: { title: 'Welcome back', sub: 'Sign in to pick up your journal where you left it.', submit: 'Sign in', busy: 'Signing in…', sw: 'New to Keel?', tog: 'Create an account' },
    signup: { title: 'Create your account', sub: 'Takes a minute. Your trades sync to every device you sign in on.', submit: 'Create account', busy: 'Creating account…', sw: 'Already have an account?', tog: 'Sign in' },
    reset: { title: 'Reset your password', sub: "Enter the email you signed up with and we'll send you a link to choose a new password.", submit: 'Send reset link', busy: 'Sending…', sw: 'Remembered it?', tog: 'Back to sign in' },
    newpass: { title: 'Choose a new password', sub: 'Pick something you have not used before. You will stay signed in afterwards.', submit: 'Update password', busy: 'Updating…', sw: '', tog: '' }
  };
  function setAuthMode(m) {
    authMode = m;
    const up = m === 'signup' || m === 'newpass', c = AUTH_COPY[m];
    $('.auth').dataset.mode = m;
    $('#auth-tab-in').setAttribute('aria-selected', String(m === 'signin')); $('#auth-tab-in').tabIndex = m === 'signup' ? -1 : 0;
    $('#auth-tab-up').setAttribute('aria-selected', String(m === 'signup')); $('#auth-tab-up').tabIndex = m === 'signup' ? 0 : -1;
    $('#a-pass-label').textContent = m === 'newpass' ? 'New password' : 'Password';
    $('#auth-title').textContent = c.title;
    $('#auth-sub').textContent = c.sub;
    $('#auth-submit-label').textContent = c.submit;
    $('#auth-switch-copy').textContent = c.sw;
    $('#auth-toggle').textContent = c.tog;
    $('#a-pass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    $('#a-pass-help').hidden = !up;
    $$('#auth-form .field').forEach(f => f.classList.remove('invalid'));
    rateStrength();
  }
  function rateStrength() {
    const box = $('#a-strength'), v = $('#a-pass').value;
    box.hidden = !(authMode === 'signup' || authMode === 'newpass') || !v;
    if (box.hidden) return;
    let s = 1, label = 'Too short';
    if (v.length >= 8) {
      s = 1 + (/[a-z]/i.test(v) && /\d/.test(v) ? 1 : 0) + (v.length >= 12 || /[^a-z0-9]/i.test(v) ? 1 : 0);
      label = ['', 'Weak', 'Good', 'Strong'][s];
    }
    box.dataset.s = s; $('#a-strength-label').textContent = label;
  }
  $('#a-pass').addEventListener('input', rateStrength);
  $('#auth-form').addEventListener('input', e => e.target.closest('.field')?.classList.remove('invalid'));
  $('#a-pass-show').onclick = () => {
    const i = $('#a-pass'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('#a-pass-show').textContent = show ? 'Hide' : 'Show';
    $('#a-pass-show').setAttribute('aria-pressed', String(show));
    $('#a-pass-show').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    i.focus();
  };
  const authMsg = (text, ok = false) => { const m = $('#auth-msg'); m.textContent = text; m.classList.toggle('ok', ok); };
  const switchAuth = m => { if (m === authMode) return; authMsg(''); setAuthMode(m); $('#a-email').focus(); };
  $('#auth-toggle').onclick = () => switchAuth(authMode === 'signin' ? 'signup' : 'signin');
  $('#auth-forgot').onclick = () => switchAuth('reset');
  $('#auth-tab-in').onclick = () => switchAuth('signin');
  $('#auth-tab-up').onclick = () => switchAuth('signup');
  $('.seg-auth').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); const m = authMode === 'signin' ? 'signup' : 'signin'; setAuthMode(m); authMsg('');
    $(m === 'signin' ? '#auth-tab-in' : '#auth-tab-up').focus();
  });
  $('#aa-cells').innerHTML = [0,.5,0,.3,.7,.25,0, 0,-.6,.45,.35,0,-.3,0, 0,.6,.2,-.4,.5,0,0, 0,.4,-.25,.45,0,.2,0, 0,.3,0,0,0,0,0]
    .map(v => `<i class="${v > 0 ? 'u' : v < 0 ? 'd' : ''}" style="--o:${Math.abs(v) + .15}"></i>`).join('');
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    authMsg('');
    const email = $('#a-email').value.trim(), password = $('#a-pass').value;
    const okEmail = authMode === 'newpass' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const needEmail = authMode !== 'newpass', needPass = authMode !== 'reset';
    const okPass = !needPass || (authMode === 'signin' ? password.length > 0 : password.length >= 8);
    $('#a-email').closest('.field').classList.toggle('invalid', !okEmail);
    $('#a-pass').closest('.field').classList.toggle('invalid', !okPass);
    if (!okEmail) return $('#a-email').focus();
    if (!okPass) return $('#a-pass').focus();
    const btn = $('#auth-submit');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); $('#auth-submit-label').textContent = AUTH_COPY[authMode].busy;
    try {
      if (authMode === 'reset') {
        check(await sb.auth.resetPasswordForEmail(email, { redirectTo: new URL('app.html', location.href).href }));
        authMsg(`If an account exists for ${email}, a reset link is on its way. Open it on this device to choose a new password.`, true);
      } else if (authMode === 'newpass') {
        const data = check(await sb.auth.updateUser({ password }));
        user = data.user || user; recovering = false;
        history.replaceState(null, '', location.pathname + '#dashboard');
        await start();
        toast('Password updated');
      } else if (authMode === 'signin') {
        const data = check(await sb.auth.signInWithPassword({ email, password }));
        user = data.user;
        await start();
      } else {
        const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: new URL('app.html', location.href).href } }));
        if (data.session) { user = data.user; await start(); }
        else { setAuthMode('signin'); authMsg(`Check ${email} for a confirmation link, then sign in here.`, true); }
      }
    } catch (err) {
      authMsg(errText(err, 'Could not reach the server. Check your connection and try again.'));
    } finally {
      btn.disabled = false; btn.removeAttribute('aria-busy');
      $('#auth-submit-label').textContent = AUTH_COPY[authMode].submit;
    }
  };
  async function signOut() {
    try { await sb.auth.signOut(); } catch {}
    location.hash = '';
    location.reload();
  }

  function renderSync() {
    const box = $('#sync'), av = $('#avatar');
    if (REMOTE) {
      box.innerHTML = `<b><span class="dot live" style="color:var(--pos)"></span>Synced to cloud</b>
        <span class="email" title="${esc(user.email)}">${esc(user.email)}</span>
        <button class="btn sm" id="sign-out" type="button">Sign out</button>`;
      $('#sign-out').onclick = signOut;
      const m = $('#m-signout'); m.hidden = false; m.onclick = signOut;
      av.textContent = (user.email || 't').charAt(0); av.title = user.email;
    } else {
      box.innerHTML = `<b><span class="dot" style="color:var(--warn)"></span>Local only</b><span>Saved in this browser. Add Supabase keys in config.js to sync.</span>`;
      av.textContent = 't'; av.title = 'Local only';
    }
  }

  /* ---------- routing ---------- */
  const routes = ['dashboard', 'calendar', 'journal', 'routine', 'plan', 'mistakes', 'size', 'buffer'];
  const TITLES = {
    dashboard: ['Dashboard', 'i-dash'], calendar: ['Calendar', 'i-cal'], journal: ['Trades', 'i-journal'], routine: ['Routine', 'i-routine'],
    plan: ['Trading plan', 'i-plan'], mistakes: ['Mistakes', 'i-target'], size: ['Position size', 'i-calc'], buffer: ['Prop firm buffer', 'i-shield']
  };
  function route() {
    if (document.body.dataset.state !== 'app') return;
    const r = routes.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + r));
    $$('[data-nav] a').forEach(a => a.getAttribute('href') === '#' + r ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    const [title, icon] = TITLES[r];
    $('#crumb').innerHTML = `<svg aria-hidden="true"><use href="#${icon}"/></svg>${title}`;
    document.title = `${title} · Keel`;
    window.scrollTo({ top: 0 });
    render(r);
  }
  window.addEventListener('hashchange', route);

  /* ---------- stats ---------- */
  const byTime = list => [...list].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const sorted = () => byTime(trades);
  const rr = t => t.risk > 0 ? t.pl / t.risk : 0;
  function stats(list = trades) {
    const net = list.reduce((s, t) => s + t.pl, 0);
    const w = list.filter(t => t.status === 'Win'), l = list.filter(t => t.status === 'Loss');
    const gw = w.reduce((s, t) => s + t.pl, 0), gl = Math.abs(l.reduce((s, t) => s + t.pl, 0));
    return {
      net, n: list.length, wins: w.length, losses: l.length, be: list.filter(t => t.status === 'BE').length,
      wr: list.length ? w.length / list.length * 100 : 0, pf: gl ? gw / gl : (gw ? Infinity : 0),
      avgR: list.length ? list.reduce((s, t) => s + rr(t), 0) / list.length : 0,
      avgWin: w.length ? gw / w.length : 0, avgLoss: l.length ? gl / l.length : 0,
      exp: list.length ? net / list.length : 0,
      longPct: list.length ? list.filter(t => t.direction === 'Long').length / list.length * 100 : 50
    };
  }

  /* ---------- chart helpers ---------- */
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }
  const kfmt = v => {
    const a = Math.abs(v), s = v < 0 ? '−$' : '$';
    return a >= 1000 ? s + (a / 1000).toFixed(a % 1000 ? 1 : 0) + 'k' : s + Math.round(a);
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Semicircle gauge: lime from 0 to value, red from value to 1, needle at value, tick at target.
  function gaugeSVG(v, target) {
    v = clamp(isFinite(v) ? v : 0, 0, 1);
    const cx = 60, cy = 56, r = 44;
    const pt = (t, rad = r) => { const a = Math.PI * (1 - t); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
    const arc = (a, b) => {
      if (b - a < 0.004) return '';
      const [x1, y1] = pt(a), [x2, y2] = pt(b);
      return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
    };
    const [s1, s2] = [pt(v, r - 7), pt(v, r + 7)];
    const tk = target == null ? '' : (() => { const [a, b] = [pt(target, r - 11), pt(target, r - 6)]; return `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/>`; })();
    return `<path d="${arc(0, 1)}" stroke="var(--loss)" stroke-width="9" fill="none" stroke-linecap="round"/>
      ${v > 0.004 ? `<path d="${arc(0, v)}" stroke="var(--accent)" stroke-width="9" fill="none" stroke-linecap="round"/>` : ''}
      ${v > 0.004 && v < 0.996 ? `<line x1="${s1[0].toFixed(2)}" y1="${s1[1].toFixed(2)}" x2="${s2[0].toFixed(2)}" y2="${s2[1].toFixed(2)}" stroke="var(--surface)" stroke-width="3"/>` : ''}
      ${tk}
      <g class="needle" style="--rot:${(v * 180).toFixed(1)}deg"><line x1="${cx}" y1="${cy}" x2="${cx - (r - 13)}" y2="${cy}" stroke="var(--text-2)" stroke-width="1.6" stroke-linecap="round"/></g>
      <circle cx="${cx}" cy="${cy}" r="3.2" fill="var(--text-2)"/>`;
  }
  function setGauge(id, title, v, target, valueText, targetText) {
    const svg = $('#' + id);
    svg.innerHTML = gaugeSVG(v, target);
    svg.setAttribute('aria-label', `${title}: ${valueText}. ${targetText}`);
    $(`#${id}-v`).textContent = valueText;
    $(`#${id}-t`).textContent = targetText;
  }
  [['pv-g1', .512], ['pv-g2', 1.62 / 3], ['pv-g3', .64]].forEach(([id, v]) => { $('#' + id).innerHTML = gaugeSVG(v, .5); });

  /* ---------- dashboard ---------- */
  let period = 'all';
  $$('#period button').forEach(b => b.onclick = () => {
    period = b.dataset.p;
    $$('#period button').forEach(x => x.setAttribute('aria-pressed', x === b));
    renderDashboard();
  });
  function inPeriod(list) {
    if (period === 'all') return list;
    const d = new Date(); d.setDate(d.getDate() - Number(period));
    const from = localISO(d);
    return list.filter(t => t.date >= from);
  }

  function renderDashboard() {
    const list = inPeriod(trades), s = stats(list), so = byTime(list), limits = getKV('limits', DEFAULT_LIMITS);
    $('#today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const net = $('#d-net'); net.textContent = money(s.net, true); net.className = 'big ' + cls(s.net);
    $('#d-range').textContent = so.length ? `${fmtDate(so[0].date)} – ${fmtDate(so.at(-1).date)}` : (period === 'all' ? 'No trades yet' : `No trades in ${period} days`);
    $('#d-count').textContent = `${s.n} trade${s.n === 1 ? '' : 's'}`;
    $('#d-kpis').innerHTML = [
      ['Avg win', s.wins ? money(s.avgWin) : '—', 'pos'], ['Avg loss', s.losses ? money(-s.avgLoss) : '—', 'neg'],
      ['Expectancy', s.n ? money(s.exp, true) : '—', cls(s.exp)], ['W / L / BE', `${s.wins} / ${s.losses} / ${s.be}`, '']
    ].map(([k, v, c]) => `<div class="kpi"><span>${k}</span><b class="${c}">${v}</b></div>`).join('');
    drawEquity(so);
    drawDaily(so);

    const has = s.n > 0;
    setGauge('g-win', 'Trade win rate', s.wr / 100, .5, has ? s.wr.toFixed(1) + '%' : '—', 'Target 50%');
    const pfText = !has ? '—' : s.pf === Infinity ? 'No losses' : s.pf.toFixed(2);
    setGauge('g-pf', 'Profit factor', s.pf === Infinity ? 1 : s.pf / 3, .5, pfText, 'Target 1.50 · scale 0–3');
    const lp = Math.round(s.longPct);
    setGauge('g-bias', 'Directional bias', s.longPct / 100, .5, has ? (lp >= 50 ? `${lp}% long` : `${100 - lp}% short`) : '—', 'Neutral at 50%');
    setGauge('g-rr', 'Average R per trade', (s.avgR + 1) / 4, .25, has ? (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R' : '—', 'Break-even at 0R · scale −1R to 3R');

    $('#d-rules').innerHTML = [['Max daily loss', limits.daily], ['Risk per trade', limits.risk], ['Minimum R:R', limits.rr], ['Max trades / day', limits.max]]
      .map(([k, v]) => `<div class="rule"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    bars('#by-session', ['London', 'New York', 'Tokyo'].map(k => [k, list.filter(t => t.session === k)]));
    bars('#by-strategy', ['+SMT', '-SMT'].map(k => [k, list.filter(t => t.strategy.toUpperCase() === k)]));
    $('#accounts').innerHTML = accounts.map(a => {
      const al = trades.filter(t => t.account === a.name), st = stats(al);
      return `<tr><td class="pair">${esc(a.name)}</td>
        <td class="r"><input class="editable num" style="text-align:right;width:120px;margin:0" data-acct="${esc(a.id)}" inputmode="decimal" aria-label="Start balance for ${esc(a.name)}" value="${a.start}"></td>
        <td class="r">${money(a.start + st.net)}</td>
        <td class="r ${cls(st.net)}">${al.length ? money(st.net, true) : '—'}</td><td class="r">${st.n || '—'}</td><td class="r">${al.length ? st.wr.toFixed(1) + '%' : '—'}</td></tr>`;
    }).join('');
  }

  function bars(sel, groups) {
    const vals = groups.map(([k, l]) => [k, l.reduce((s, t) => s + t.pl, 0), l.length]);
    const max = Math.max(1, ...vals.map(v => Math.abs(v[1])));
    $(sel).innerHTML = vals.map(([k, v, n], i) => `<div class="brow"><span>${esc(k)} <span class="dim" style="font-size:12px">· ${n}</span></span>
      <div class="track"><i style="width:${Math.abs(v) / max * 100}%;background:${v >= 0 ? 'var(--accent)' : 'var(--loss)'};animation-delay:${i * 80}ms"></i></div>
      <span class="v ${cls(v)}">${money(v, true)}</span></div>`).join('');
  }

  // Cumulative P&L: lime above zero, red below zero (two clipped copies of the same line).
  function drawEquity(list) {
    const W = 640, H = 250, P = { l: 52, r: 12, t: 12, b: 26 };
    const svg = $('#equity');
    if (!list.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" style="font-size:13px">Log a trade to start the curve</text>`; return; }
    let run = 0; const pts = [0, ...list.map(t => (run += t.pl))];
    let lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
    const pad = (hi - lo || 1) * .08; lo -= pad; hi += pad;
    const x = i => P.l + i / (pts.length - 1 || 1) * (W - P.l - P.r);
    const y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const y0 = y(0);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${x(pts.length - 1).toFixed(1)},${y0.toFixed(1)}L${x(0).toFixed(1)},${y0.toFixed(1)}Z`;
    const step = Math.max(1, Math.ceil((pts.length - 1) / 8));
    const xl = [];
    for (let i = 1; i < pts.length; i += step) xl.push(i);
    const draw = `pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"`;
    const anim = `<animate attributeName="stroke-dashoffset" to="0" dur="1.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".16 1 .3 1"/>`;
    svg.innerHTML = `
      <defs>
        <clipPath id="eq-up"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>
        <clipPath id="eq-dn"><rect x="0" y="${y0}" width="${W}" height="${H - y0}"/></clipPath>
        <linearGradient id="eq-gu" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3B82F6" stop-opacity=".28"/><stop offset="1" stop-color="#3B82F6" stop-opacity="0"/></linearGradient>
        <linearGradient id="eq-gd" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#EF4444" stop-opacity="0"/><stop offset="1" stop-color="#EF4444" stop-opacity=".22"/></linearGradient>
      </defs>
      ${niceTicks(lo, hi, 4).map(v => `<line class="gl" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? '' : 'stroke-dasharray="2 5"'}/><text x="${P.l - 10}" y="${y(v) + 3.5}" text-anchor="end">${kfmt(v)}</text>`).join('')}
      <path d="${area}" fill="url(#eq-gu)" clip-path="url(#eq-up)"/>
      <path d="${area}" fill="url(#eq-gd)" clip-path="url(#eq-dn)"/>
      <path d="${line}" fill="none" stroke="#3B82F6" stroke-width="2" stroke-linejoin="round" clip-path="url(#eq-up)" ${draw}>${anim}</path>
      <path d="${line}" fill="none" stroke="#EF4444" stroke-width="2" stroke-linejoin="round" clip-path="url(#eq-dn)" ${draw}>${anim}</path>
      ${pts.slice(1).map((v, i) => `<circle cx="${x(i + 1)}" cy="${y(v)}" r="7" fill="transparent"><title>#${i + 1} ${esc(list[i].pair)} ${fmtDate(list[i].date)}: ${money(list[i].pl, true)} (running ${money(v, true)})</title></circle>`).join('')}
      <circle cx="${x(pts.length - 1)}" cy="${y(pts.at(-1))}" r="3.5" fill="${pts.at(-1) >= 0 ? '#3B82F6' : '#EF4444'}"/>
      ${xl.map(i => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">#${i}</text>`).join('')}`;
  }

  // Daily P&L bars (last 30 trading days in the selected period).
  function drawDaily(list) {
    const W = 640, H = 200, P = { l: 52, r: 12, t: 10, b: 24 };
    const svg = $('#daily');
    const m = new Map();
    list.forEach(t => m.set(t.date, (m.get(t.date) || 0) + t.pl));
    const days = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30);
    if (!days.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" style="font-size:13px">No trading days yet</text>`; $('#daily-sub').textContent = ''; return; }
    let lo = Math.min(0, ...days.map(d => d[1])), hi = Math.max(0, ...days.map(d => d[1]));
    const pad = (hi - lo || 1) * .1; lo -= lo < 0 ? pad : 0; hi += pad;
    const y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const slot = (W - P.l - P.r) / days.length, bw = Math.min(26, slot * .62);
    const y0 = y(0);
    const best = Math.max(...days.map(d => d[1])), worst = Math.min(...days.map(d => d[1]));
    $('#daily-sub').textContent = `${days.length} day${days.length === 1 ? '' : 's'} · best ${money(best, true)} · worst ${money(worst, true)}`;
    const lblStep = Math.max(1, Math.ceil(days.length / 7));
    svg.innerHTML = `
      ${niceTicks(lo, hi, 3).map(v => `<line class="gl" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" ${v === 0 ? '' : 'stroke-dasharray="2 5"'}/><text x="${P.l - 10}" y="${y(v) + 3.5}" text-anchor="end">${kfmt(v)}</text>`).join('')}
      ${days.map(([d, v], i) => {
        const cx = P.l + slot * i + slot / 2, top = Math.min(y(v), y0), h = Math.max(1.5, Math.abs(y(v) - y0));
        return `<rect class="${v >= 0 ? 'bar-up' : 'bar-dn'}" style="animation-delay:${i * 25}ms" x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${v > 0 ? '#22C55E' : v < 0 ? '#EF4444' : '#64748B'}"><title>${fmtDate(d)}: ${money(v, true)}</title></rect>
          ${i % lblStep === 0 ? `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtDate(d)}</text>` : ''}`;
      }).join('')}`;
  }

  /* ---------- market sessions ---------- */
  const SESS = [
    { name: 'Sydney', zone: 'Australia/Sydney', open: 7, close: 16 },
    { name: 'Tokyo', zone: 'Asia/Tokyo', open: 9, close: 18 },
    { name: 'London', zone: 'Europe/London', open: 8, close: 17 },
    { name: 'New York', zone: 'America/New_York', open: 8, close: 17 }
  ];
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const pad = n => String(n).padStart(2, '0');
  const fmtZone = {};
  function zoned(zone, now) {
    fmtZone[zone] ||= new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' });
    const p = Object.fromEntries(fmtZone[zone].formatToParts(now).map(x => [x.type, x.value]));
    const z = { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, m: +p.minute, s: +p.second, wd: WD[p.weekday] };
    z.offsetMs = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.m, z.s) - Math.floor(now / 1000) * 1000;
    return z;
  }
  // Seconds until the next weekday open in the market's own time.
  function nextOpenIn(z, s) {
    const nowS = z.h * 3600 + z.m * 60 + z.s, oS = s.open * 3600;
    for (let k = 0; k < 8; k++) {
      const wd = (z.wd + k) % 7;
      if (wd === 0 || wd === 6 || (k === 0 && nowS >= oS)) continue;
      return k * 86400 + oS - nowS;
    }
    return 0;
  }
  const countdown = secs => {
    const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h ${pad(m)}m` : h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
  };
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let sessBuilt = false;

  function buildSessions() {
    $('#sessions').innerHTML = SESS.map((s, i) => `<div class="sess" data-sess="${i}">
        <div><h3>${s.name}</h3><small>${pad(s.open)}:00–${s.close}:00 local · <span data-next></span></small></div>
        <div style="text-align:right"><div class="t" data-clock></div><span class="chip" data-chip></span></div>
        <div class="bar" aria-hidden="true"><i style="left:${s.open / .24}%;width:${(s.close - s.open) / .24}%"></i><b data-elapsed></b><u data-now></u></div>
      </div>`).join('');
    $('#timeline').innerHTML = `<div class="tl-head"><span>Your time · ${esc(localTz.replace(/_/g, ' '))}</span><b data-yourclock></b></div>
      ${SESS.map((s, i) => `<div class="lane" data-lane="${i}"><span>${s.name}</span><div class="track"><u data-now></u></div></div>`).join('')}
      <div class="tl-hours" aria-hidden="true"><span></span><div><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>`;
    sessBuilt = true;
  }

  // Place each session's window on a 24h strip in the viewer's own time zone (redrawn each minute).
  let laneMinute = -1;
  function drawLanes(now, zs) {
    const minute = Math.floor(now / 60000);
    if (minute === laneMinute) return;
    laneMinute = minute;
    SESS.forEach((s, i) => {
      const z = zs[i];
      const openMs = Date.UTC(z.y, z.mo - 1, z.d, s.open) - z.offsetMs;
      const od = new Date(openMs), start = od.getHours() * 60 + od.getMinutes(), len = (s.close - s.open) * 60;
      const segs = start + len > 1440 ? [[start, 1440], [0, start + len - 1440]] : [[start, start + len]];
      const track = $(`[data-lane="${i}"] .track`);
      $$('i', track).forEach(n => n.remove());
      segs.forEach(([a, b]) => track.insertAdjacentHTML('afterbegin', `<i style="left:${a / 14.4}%;width:${(b - a) / 14.4}%"></i>`));
      const lt = new Date(openMs + len * 60000);
      track.title = `${s.name}: ${pad(od.getHours())}:${pad(od.getMinutes())}–${pad(lt.getHours())}:${pad(lt.getMinutes())} your time`;
    });
  }

  function renderSessions() {
    if (!sessBuilt) buildSessions();
    const now = Date.now(), zs = SESS.map(s => zoned(s.zone, now)), openNames = [];
    let soonest = null;
    SESS.forEach((s, i) => {
      const z = zs[i], row = $(`[data-sess="${i}"]`);
      const nowS = z.h * 3600 + z.m * 60 + z.s, oS = s.open * 3600, cS = s.close * 3600;
      const weekend = z.wd === 0 || z.wd === 6, open = !weekend && nowS >= oS && nowS < cS;
      const wait = open ? 0 : nextOpenIn(z, s);
      if (open) openNames.push(s.name);
      else if (!soonest || wait < soonest.wait) soonest = { name: s.name, wait };
      row.classList.toggle('open', open);
      $('[data-clock]', row).innerHTML = `${pad(z.h)}:${pad(z.m)}<span class="sec">:${pad(z.s)}</span>`;
      $('[data-next]', row).textContent = open ? `closes in ${countdown(cS - nowS)}` : `opens in ${countdown(wait)}`;
      const chip = $('[data-chip]', row), soon = !open && wait <= 3600;
      const chipState = open ? 'open' : soon ? 'soon' : 'closed';
      if (chip.dataset.state !== chipState) {
        chip.dataset.state = chipState;
        chip.className = 'chip ' + (open ? 'ok' : soon ? 'mid' : '');
        chip.innerHTML = open ? '<span class="dot live"></span>Open' : soon ? 'Opens soon' : 'Closed';
      }
      const el = $('[data-elapsed]', row);
      el.style.left = (s.open / .24) + '%';
      el.style.width = open ? ((nowS - oS) / 864) + '%' : '0';
      $('[data-now]', row).style.left = (nowS / 864) + '%';
      $(`[data-lane="${i}"]`).classList.toggle('open', open);
    });
    drawLanes(now, zs);
    const me = new Date(now), myMin = me.getHours() * 60 + me.getMinutes() + me.getSeconds() / 60;
    $$('#timeline [data-now]').forEach(u => u.style.left = (myMin / 14.4) + '%');
    $('#timeline [data-yourclock]').innerHTML = `${pad(me.getHours())}:${pad(me.getMinutes())}<span class="sec">:${pad(me.getSeconds())}</span>`;

    const has = n => openNames.includes(n);
    const note = has('London') && has('New York') ? 'London and New York overlap. Usually the busiest hours of the day.'
      : has('Tokyo') && has('London') ? 'Tokyo and London overlap.'
      : has('Sydney') && has('Tokyo') ? 'Sydney and Tokyo overlap.'
      : openNames.length ? `${openNames[0]} is open. Next: ${soonest.name} in ${countdown(soonest.wait)}.`
      : `${zs.some(z => z.wd === 0 || z.wd === 6) && !openNames.length && soonest.wait > 3600 * 6 ? 'Weekend' : 'Between sessions'}. ${soonest.name} opens in ${countdown(soonest.wait)}.`;
    if ($('#sess-note').textContent !== note) $('#sess-note').textContent = note;
    const oc = $('#open-count'), ocText = `${openNames.length} open`;
    if (oc.dataset.n !== ocText) {
      oc.dataset.n = ocText;
      oc.innerHTML = `<span class="dot ${openNames.length ? 'live' : ''}"></span>${ocText}`;
      oc.className = 'chip ' + (openNames.length ? 'ok' : '');
    }
  }
  // Tick once per second, aligned to the clock, only while the dashboard is visible.
  (function tick() {
    if (!document.hidden && document.body.dataset.state === 'app' && $('#v-dashboard').classList.contains('on')) renderSessions();
    setTimeout(tick, 1000 - Date.now() % 1000 + 5);
  })();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#v-dashboard').classList.contains('on')) renderSessions(); });

  /* ---------- journal ---------- */
  let fStatus = 'all', fSession = 'all', fQuery = '';
  $$('#f-status button').forEach(b => b.onclick = () => { fStatus = b.dataset.v; $$('#f-status button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderJournal(); });
  $('#f-session').onchange = e => { fSession = e.target.value; renderJournal(); };
  $('#f-search').oninput = e => { fQuery = e.target.value.trim().toLowerCase(); renderJournal(); };
  const tagClass = s => 't' + (s.toUpperCase() === '+SMT' ? 0 : s.toUpperCase() === '-SMT' ? 1 : 2);
  function renderJournal() {
    const list = sorted().reverse().filter(t => (fStatus === 'all' || t.status === fStatus) && (fSession === 'all' || t.session === fSession)
      && (!fQuery || [t.pair, t.strategy, t.session, t.direction, t.account, t.note, ...t.mistakes].join(' ').toLowerCase().includes(fQuery)));
    $('#j-count').textContent = `${list.length} of ${trades.length} trades`;
    renderGallery(list);
    if (!list.length) {
      $('#trades').innerHTML = `<tr><td colspan="11"><div class="empty"><svg><use href="#i-journal"/></svg><b>${trades.length ? 'No trades match' : 'Your journal is empty'}</b>${trades.length ? 'Try another search, result or session.' : 'Log your first trade and the dashboard fills itself in.'}</div></td></tr>`;
      return;
    }
    $('#trades').innerHTML = list.map((t, i) => {
      const r = rr(t);
      const mk = t.mistakes.map(m => `<span class="chip ${m === 'None' ? 'ok' : 'bad'}">${m === 'None' ? 'Clean' : esc(m)}</span>`).join(' ');
      return `<tr style="--i:${i}"><td class="num">${fmtDate(t.date)} <span class="sub" style="font-size:12px">${esc(t.time)}</span></td>
        <td class="pair" style="white-space:nowrap">${esc(t.pair)}${t.shots?.length ? ` <button class="icon-btn shot-btn" data-shots="${esc(t.id)}" aria-label="View ${t.shots.length} screenshot${t.shots.length > 1 ? 's' : ''} for the ${esc(t.pair)} trade from ${fmtDate(t.date)}"><svg aria-hidden="true"><use href="#i-image"/></svg>${t.shots.length}</button>` : ''}</td><td><span class="chip ${t.direction.toLowerCase()}">${esc(t.direction)}</span></td>
        <td>${esc(t.session)}</td><td><span class="tag ${tagClass(t.strategy)}">${esc(t.strategy)}</span></td><td class="r num">${money(t.risk)}</td>
        <td class="r num ${cls(t.pl)}">${money(t.pl, true)}</td><td class="r num">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</td>
        <td><span class="chip ${t.status.toLowerCase()}">${esc(t.status)}</span></td><td>${mk}</td>
        <td class="r"><button class="icon-btn" data-del="${esc(t.id)}" aria-label="Delete ${esc(t.pair)} trade from ${fmtDate(t.date)}"><svg><use href="#i-trash"/></svg></button></td></tr>`;
    }).join('');
  }
  /* chart gallery: one tile per screenshot, newest trade first */
  const G_STEP = 24;
  let gLimit = G_STEP, gToken = 0, gList = [];
  async function renderGallery(list = gList) {
    gList = list;
    const tok = ++gToken;
    const items = list.filter(t => t.shots?.length).flatMap(t => t.shots.map((p, i) => ({ t, p, i })));
    const total = trades.reduce((n, t) => n + (t.shots?.length || 0), 0);
    const box = $('#gallery');
    $('#g-count').textContent = items.length ? `${items.length} screenshot${items.length > 1 ? 's' : ''}` : '';
    $('#g-empty').hidden = items.length > 0;
    $('#g-empty-title').textContent = total ? 'No screenshots match' : 'No screenshots yet';
    $('#g-empty-copy').textContent = total ? 'None of the trades in this search or filter have screenshots.' : 'Add chart screenshots when you log a trade. Paste, drop or browse, up to 4 per trade.';
    $('[data-new-trade]', $('#g-empty')).hidden = total > 0;
    const shown = items.slice(0, gLimit);
    $('#g-more').hidden = items.length <= gLimit;
    $('#g-more').textContent = `Show more (${items.length - shown.length} left)`;
    if (!shown.length) { box.innerHTML = ''; return; }
    box.innerHTML = shown.map(() => '<div class="g-skel"></div>').join('');
    let urls;
    try { urls = await api.signPaths(shown.map(x => x.p)); }
    catch (err) { if (tok === gToken) box.innerHTML = `<p class="sub">${esc(errText(err, 'Could not load the screenshots. Check your connection.'))}</p>`; return; }
    if (tok !== gToken) return;
    box.innerHTML = shown.map(({ t, p, i }, k) => `<button type="button" class="g-item" style="--i:${Math.min(k, 12)}" data-shots="${esc(t.id)}" data-at="${i}" aria-label="Open screenshot ${i + 1} of ${t.shots.length}, ${esc(t.pair)} ${esc(t.direction)} on ${fmtDate(t.date)}, ${money(t.pl, true)}">
      <div class="ph">${urls[p] ? `<img src="${esc(urls[p])}" alt="" loading="lazy">` : ''}</div>
      ${t.shots.length > 1 ? `<span class="g-badge"><svg aria-hidden="true"><use href="#i-image"/></svg>${i + 1}/${t.shots.length}</span>` : ''}
      <div class="g-meta"><b>${esc(t.pair)}</b><span class="when">${fmtDate(t.date)} · ${esc(t.direction)}</span><span class="num ${cls(t.pl)}">${money(t.pl, true)}</span></div>
    </button>`).join('');
  }
  $('#g-more').onclick = () => { gLimit += G_STEP; renderGallery(); };
  $('#gallery').addEventListener('click', e => {
    const b = e.target.closest('[data-shots]'); if (!b) return;
    openShots(trades.find(x => x.id === b.dataset.shots), Number(b.dataset.at));
  });

  $('#trades').addEventListener('click', async e => {
    const sh = e.target.closest('[data-shots]');
    if (sh) return openShots(trades.find(x => x.id === sh.dataset.shots));
    const b = e.target.closest('[data-del]'); if (!b) return;
    const t = trades.find(x => x.id === b.dataset.del);
    if (!t || !confirm(`Delete the ${t.pair} trade from ${fmtDate(t.date)}? This cannot be undone.`)) return;
    b.disabled = true;
    try {
      await api.deleteTrade(t.id);
      trades = trades.filter(x => x.id !== t.id);
      renderJournal(); toast('Trade deleted');
    } catch (err) { b.disabled = false; toast(errText(err, 'Could not delete. Check your connection.'), 'err'); }
  });

  /* ---------- trade dialog ---------- */
  const dlg = $('#trade-dlg'), form = $('#trade-form');
  $('#t-mist').innerHTML = MISTAKES.map(m => `<label><input type="checkbox" value="${m}" ${m === 'None' ? 'checked' : ''}>${m === 'None' ? 'None, clean' : m}</label>`).join('');
  $('#t-mist').addEventListener('change', e => {
    const boxes = $$('#t-mist input');
    if (e.target.value === 'None' && e.target.checked) boxes.forEach(b => b.checked = b.value === 'None');
    else if (e.target.checked) boxes[0].checked = false;
    if (!boxes.some(b => b.checked)) boxes[0].checked = true;
  });
  /* screenshots in the form: shrink each image in the browser before it is stored */
  let shots = [];
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, (REMOTE ? 2000 : 1280) / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const q = REMOTE ? 0.86 : 0.72;
    let blob = await new Promise(r => c.toBlob(r, 'image/webp', q));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    return blob;
  }
  function renderShots() {
    const box = $('#t-shots');
    $$('.shot', box).forEach(n => n.remove());
    shots.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'shot';
      d.innerHTML = `<img src="${s.url}" alt="Screenshot ${i + 1}"><button type="button" data-rm="${i}" aria-label="Remove screenshot ${i + 1}"><svg><use href="#i-x"/></svg></button>`;
      box.insertBefore(d, $('#t-shot-add'));
    });
    const full = shots.length >= MAX_SHOTS;
    $('#t-shot-add').disabled = full;
    $('#t-shots-hint').textContent = full ? 'That is the limit of 4 screenshots.' : shots.length ? `${shots.length} of ${MAX_SHOTS} added.` : 'Paste with Ctrl+V or ⌘V, drop images here, or browse. Up to 4.';
  }
  function clearShots() { shots.forEach(s => URL.revokeObjectURL(s.url)); shots = []; renderShots(); }
  async function addShots(files) {
    const imgs = [...files].filter(f => /^image\//.test(f.type));
    if (!imgs.length) return;
    const room = MAX_SHOTS - shots.length;
    if (imgs.length > room) toast(`Only ${MAX_SHOTS} screenshots per trade. Added the first ${Math.max(room, 0)}.`, 'err');
    for (const f of imgs.slice(0, Math.max(room, 0))) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name || 'That image'} is over 25 MB.`, 'err'); continue; }
      try { const blob = await shrink(f); shots.push({ blob, url: URL.createObjectURL(blob) }); }
      catch { toast('Could not read that image. Try a PNG or JPEG.', 'err'); }
    }
    renderShots();
  }
  $('#t-shot-add').onclick = () => $('#t-shot-input').click();
  $('#t-shot-input').onchange = e => { addShots(e.target.files); e.target.value = ''; };
  $('#t-shots').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]'); if (!rm) return;
    const [s] = shots.splice(Number(rm.dataset.rm), 1); URL.revokeObjectURL(s.url); renderShots();
    $('#t-shot-add').focus();
  });
  const zone = $('#t-shots');
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', e => addShots(e.dataTransfer.files));
  dlg.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile());
    if (files.length) { e.preventDefault(); addShots(files); }
  });
  dlg.addEventListener('close', clearShots);

  /* screenshot viewer */
  const shotDlg = $('#shot-dlg');
  $$('[data-close]', shotDlg).forEach(b => b.onclick = () => shotDlg.close());
  async function openShots(t, at = 0) {
    if (!t?.shots?.length) return;
    $('#shot-title').textContent = `${t.pair} · ${fmtDate(t.date)} · ${t.direction}`;
    const view = $('#shot-view');
    view.innerHTML = '<div class="shimmer" style="width:100%"></div>';
    shotDlg.showModal();
    try {
      const urls = await api.shotUrls(t);
      view.innerHTML = urls.map((u, i) => `<figure><img src="${esc(u)}" alt="Screenshot ${i + 1} of ${urls.length} for the ${esc(t.pair)} trade" loading="lazy"><figcaption><span>${i + 1} of ${urls.length}</span>${REMOTE ? `<a href="${esc(u)}" target="_blank" rel="noopener">Open full size</a>` : ''}</figcaption></figure>`).join('')
        || '<p class="sub">These screenshots are no longer available.</p>';
      if (at > 0) $$('figure', view)[at]?.scrollIntoView({ block: 'start' });
    } catch (err) {
      view.innerHTML = `<p class="sub">${esc(errText(err, 'Could not load the screenshots. Check your connection.'))}</p>`;
    }
  }

  $$('[data-new-trade]').forEach(b => b.onclick = () => {
    form.reset(); clearShots(); $$('.field', form).forEach(f => f.classList.remove('invalid'));
    $('#t-form-msg').textContent = '';
    $('#t-acct').innerHTML = accounts.map(a => `<option>${esc(a.name)}</option>`).join('');
    $('#t-date').value = localISO(new Date());
    dlg.showModal(); $('#t-pair').focus();
  });
  $$('[data-close]', dlg).forEach(b => b.onclick = () => dlg.close());
  form.onsubmit = async e => {
    e.preventDefault();
    const v = id => $(id).value.trim();
    const checks = [['#t-pair', v('#t-pair')], ['#t-date', v('#t-date')], ['#t-risk', num(v('#t-risk')) > 0], ['#t-pl', !isNaN(num(v('#t-pl')))]];
    let ok = true;
    checks.forEach(([id, good]) => { $(id).closest('.field').classList.toggle('invalid', !good); if (!good && ok) { $(id).focus(); ok = false; } });
    if (!ok) return;
    const draft = {
      pair: v('#t-pair').toUpperCase(), date: v('#t-date'), time: v('#t-time') || '—', account: v('#t-acct'),
      direction: v('#t-dir'), session: v('#t-sess'), strategy: v('#t-strat'), status: v('#t-status'),
      risk: num(v('#t-risk')), pl: num(v('#t-pl')), mistakes: $$('#t-mist input:checked').map(b => b.value), note: v('#t-note')
    };
    const btn = $('#t-save');
    btn.disabled = true; $('#t-save-label').textContent = shots.length ? 'Uploading…' : 'Saving…'; $('#t-form-msg').textContent = '';
    try {
      const saved = await api.addTrade(draft, shots.map(s => s.blob));
      trades.push(saved);
      dlg.close(); toast(REMOTE ? 'Trade saved and synced' : 'Trade saved to journal');
      render(location.hash.slice(1) || 'dashboard');
    } catch (err) {
      $('#t-form-msg').textContent = errText(err, 'Could not save the trade. Check your connection and try again.');
    } finally { btn.disabled = false; $('#t-save-label').textContent = 'Save trade'; }
  };

  /* ---------- routine ---------- */
  const ROUTINE = ['Confirmed equity, firm thresholds and personal limits', 'Checked scheduled news and the session timezone', 'Marked context, key levels and valid scenarios', 'Reviewed one recurring mistake and its prevention rule', 'Recorded focus, energy and emotional state', 'Wrote the plan for every order I might take'];
  const band = p => p >= 80 ? ['var(--pos)', 'Consistent'] : p >= 50 ? ['var(--warn)', 'Slipping'] : ['var(--loss)', 'Off track'];
  function renderRoutine() {
    const dayKey = localISO(new Date()), done = getKV('routine', {})[dayKey] || [];
    $('#routine-day').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    $('#routine-list').innerHTML = ROUTINE.map((r, i) => `<label class="tick"><input type="checkbox" data-r="${i}" ${done.includes(i) ? 'checked' : ''}><span>${r}</span></label>`).join('');
    $$('#routine-list input').forEach(b => b.onchange = async () => {
      const map = { ...getKV('routine', {}), [dayKey]: $$('#routine-list input:checked').map(x => +x.dataset.r) };
      score();
      if (!(await putKV('routine', map))) renderRoutine();
      else score();
    });
    score();
  }
  function score() {
    const n = $$('#routine-list input:checked').length, p = Math.round(n / 6 * 100), [c, label] = band(p);
    const ring = $('#ring'); ring.style.setProperty('--p', p); ring.style.setProperty('--c', c);
    $('#score').textContent = p + '%'; $('#score-label').textContent = label;
    const map = getKV('routine', {}), days = [], d = new Date();
    while (days.length < 28) { if (d.getDay() % 6) days.unshift(localISO(d)); d.setDate(d.getDate() - 1); }
    $('#heat').innerHTML = days.map(day => {
      if (!map[day]?.length) return `<i title="${fmtDate(day)}: no entry"></i>`;
      const pc = Math.round(map[day].length / 6 * 100), [col] = band(pc);
      return `<i title="${fmtDate(day)}: ${pc}%" style="background:${col};opacity:${.35 + pc / 160}"></i>`;
    }).join('');
  }
  const LISTS = {
    '#l-order': ['All setup and entry conditions are present', 'Entry, stop, target and management written down', 'Size calculated with the correct point value', 'Rounded down to the size increment; costs included', 'Total open risk and account buffer checked'],
    '#l-after': ['Date, account, strategy, risk, P/L and result filled in', 'Chart attached with before / during / after notes', 'Mistakes classified separately from the outcome', 'One lesson and one action for next session'],
    '#l-week': ['Reconcile journal P/L against broker statements', 'Review strategy, session and mistake groups with sample sizes', 'Pick one behavior to keep and one to correct', 'Change the plan only through a written review']
  };
  Object.entries(LISTS).forEach(([s, items]) => $(s).innerHTML = items.map(t => `<li><svg><use href="#i-check"/></svg>${t}</li>`).join(''));

  /* ---------- plan (built after data loads) ---------- */
  const KV_FIELDS = {
    goals: [['Monthly', 'e.g. follow the plan on 90% of trades'], ['Quarterly', 'e.g. pass the prop evaluation'], ['Yearly', 'e.g. consistent payouts, 4 of 6 months']],
    system: [['Approved setup', 'Define conditions and link examples'], ['Markets', 'e.g. NQ, ES, EURUSD, XAUUSD'], ['Timeframes', 'e.g. 15m bias, 1m entry'], ['Sessions', 'e.g. London open and NY AM']],
    entry: [['Setup', 'Fill in'], ['Trigger', 'Fill in'], ['Invalidation', 'Fill in'], ['Stop placement', 'Fill in']],
    exit: [['Profit taking', 'Fill in'], ['Management', 'Fill in'], ['Early exit', 'Fill in']],
    notrade: [['High-impact news', 'Fill in'], ['Setup incomplete', 'Wait'], ['Missed the entry', 'Skip it, no chasing'], ['Tired, angry, distracted', 'No trading']],
    weekly: [['Review week', 'Fill in'], ['Most repeated pattern', 'Fill in'], ['Affected trades', 'Fill in'], ['One rule for next week', 'Fill in'], ['How I will verify it', 'Fill in']]
  };
  const NEVER = ['Risk more than the per-trade limit on one trade', 'Move the stop to avoid a loss', 'Take a revenge trade after a loss', 'Chase a late entry', 'Exceed the daily trade cap', 'Trade without a written plan'];

  function wireStateful() {
    const plan = getKV('plan', {}), limits = getKV('limits', DEFAULT_LIMITS), never = getKV('never', []);
    $$('[data-kv]').forEach(dl => {
      const g = dl.dataset.kv;
      dl.innerHTML = KV_FIELDS[g].map(([k, ph], i) => {
        const key = g + '.' + i, preset = ['Wait', 'Skip it, no chasing', 'No trading'].includes(ph);
        const val = plan[key] ?? (preset ? ph : '');
        return `<dt>${k}</dt><dd><input class="editable" data-plan="${key}" aria-label="${k}" placeholder="${preset ? '' : ph}" value="${esc(val)}" maxlength="240"></dd>`;
      }).join('');
    });
    $('#p-rules').innerHTML = [['daily', 'Max daily loss'], ['risk', 'Risk per trade'], ['rr', 'Minimum R:R'], ['max', 'Max trades / day']]
      .map(([k, l]) => `<div class="rule"><span>${l}</span><input class="editable mono" data-limit="${k}" aria-label="${l}" value="${esc(limits[k])}" maxlength="12" style="font-size:24px;letter-spacing:-.03em;margin:0 -8px;padding:2px 8px"></div>`).join('');
    $('#never').innerHTML = NEVER.map((r, i) => `<label class="tick"><input type="checkbox" data-never="${i}" ${never.includes(i) ? 'checked' : ''}><span>Never ${r.charAt(0).toLowerCase() + r.slice(1)}</span></label>`).join('');
  }

  document.addEventListener('change', async e => {
    const el = e.target;
    if (el.matches('[data-plan]')) {
      if (await putKV('plan', { ...getKV('plan', {}), [el.dataset.plan]: el.value })) toast('Plan saved');
    } else if (el.matches('[data-limit]')) {
      if (await putKV('limits', { ...getKV('limits', DEFAULT_LIMITS), [el.dataset.limit]: el.value })) { toast('Limit updated'); renderStop(); }
    } else if (el.matches('[data-never]')) {
      await putKV('never', $$('#never input:checked').map(b => +b.dataset.never));
    } else if (el.matches('[data-acct]')) {
      const a = accounts.find(x => String(x.id) === el.dataset.acct), v = num(el.value);
      if (!a) return;
      if (!(v >= 0)) { el.value = a.start; return toast('Start balance must be a number of zero or more', 'err'); }
      try { await api.updateAccount(a.id, v); a.start = v; renderDashboard(); toast('Start balance updated'); }
      catch (err) { el.value = a.start; toast(errText(err, 'Could not save. Check your connection.'), 'err'); }
    }
  });

  function renderStop() {
    const limits = getKV('limits', DEFAULT_LIMITS);
    $('#stop-list').innerHTML = [`Daily loss reaches ${esc(limits.daily)}`, `${esc(limits.max)} trades are taken`, 'Two losses in a row: 30-minute cooldown, half size after']
      .map(t => `<li><svg style="color:var(--loss)"><use href="#i-ban"/></svg>${t}</li>`).join('');
  }

  /* ---------- mistakes ---------- */
  const PLAYBOOK = [
    ['Oversize', 'Planned risk vs. actual initial risk', 'Calculate size before submitting the order.'],
    ['Moved SL', 'Original stop, new stop, and why', 'Write the allowed stop adjustments into the plan.'],
    ['Revenge Trade', 'Trigger, time since last loss, setup validity', 'Take the cooldown and recheck every entry condition.'],
    ['Late Entry', 'Planned entry vs. actual entry', 'Log the missed setup instead of chasing it.'],
    ['Early Exit', 'Planned management vs. actual exit', 'Follow the written exit rule; document exceptions.'],
    ['None', 'Evidence the trade followed the plan', 'Keep valid losses in the review.']
  ];
  function renderMistakes() {
    const groups = MISTAKES.filter(m => m !== 'None').map(m => [m, trades.filter(t => t.mistakes.includes(m))]).filter(g => g[1].length);
    if (!groups.length) $('#m-bars').innerHTML = `<div class="empty"><svg><use href="#i-target"/></svg><b>No mistakes logged</b>${trades.length ? 'Every trade so far is tagged clean.' : 'Mistakes you tag in the journal show up here.'}</div>`;
    else bars('#m-bars', groups);
    $('#playbook').innerHTML = PLAYBOOK.map(([p, rec, rule]) => {
      const n = trades.filter(t => t.mistakes.includes(p)).length;
      return `<tr><td><span class="chip ${p === 'None' ? 'ok' : 'bad'}">${p === 'None' ? 'Clean' : p}</span></td><td style="white-space:normal;color:var(--text-2)">${rec}</td><td style="white-space:normal">${rule}</td><td class="r num">${n}</td></tr>`;
    }).join('');
  }

  /* ---------- calculators ---------- */
  const f = id => num($(id).value);
  function valid(id, cond) { $(id).closest('.field').classList.toggle('invalid', !cond); return cond; }
  function calcSize() {
    const bal = f('#s-bal'), risk = f('#s-risk'), stop = f('#s-stop'), vpp = f('#s-vpp'), inc = f('#s-inc'), r = f('#s-rr');
    const ok = [valid('#s-bal', bal > 0), valid('#s-risk', risk >= .01 && risk <= 10), valid('#s-stop', stop > 0), valid('#s-vpp', vpp > 0), valid('#s-inc', inc > 0), valid('#s-rr', r > 0)].every(Boolean);
    if (!ok) { ['#s-out', '#s-max', '#s-act', '#s-left', '#s-tp'].forEach(i => $(i).textContent = '—'); return; }
    const max = bal * risk / 100, raw = max / (stop * vpp), size = Math.floor(raw / inc + 1e-9) * inc, act = size * stop * vpp;
    const dec = (String(inc).split('.')[1] || '').length;
    $('#s-out').textContent = size > 0 ? size.toFixed(dec) + (inc >= 1 ? (size === 1 ? ' unit' : ' units') : ' lots') : 'Too small';
    $('#s-out').className = 'big ' + (size > 0 ? 'pos' : 'neg');
    $('#s-max').textContent = money(max); $('#s-act').textContent = money(act); $('#s-left').textContent = money(max - act); $('#s-tp').textContent = money(act * r, true);
  }
  function calcBuf() {
    const eq = f('#b-eq'), open = f('#b-open'), day = f('#b-day'), all = f('#b-all');
    const ok = [valid('#b-eq', eq > 0), valid('#b-open', open >= 0), valid('#b-day', day > 0), valid('#b-all', all > 0)].every(Boolean);
    if (!ok) return;
    const dB = eq - day, oB = eq - all, min = Math.min(dB, oB), rem = min - open;
    $('#b-d').textContent = money(dB); $('#b-o').textContent = money(oB); $('#b-bind').textContent = dB <= oB ? 'Daily floor' : 'Overall floor';
    const out = $('#b-out'); out.textContent = money(rem); out.className = 'big ' + (rem <= 0 ? 'neg' : rem < min * .35 ? 'flat' : 'pos');
    const st = $('#b-state');
    if (rem <= 0) { st.className = 'chip bad'; st.textContent = 'No room left under these inputs'; }
    else if (rem < min * .35) { st.className = 'chip mid'; st.textContent = 'Tight: open risk uses most of it'; }
    else { st.className = 'chip ok'; st.textContent = 'Room remains'; }
    const m = $('#b-meter'); m.style.width = Math.max(0, Math.min(100, rem / (min || 1) * 100)) + '%';
    m.style.background = rem <= 0 ? 'var(--loss)' : rem < min * .35 ? 'var(--warn)' : 'var(--pos)';
  }
  $('#size-form').oninput = calcSize; $('#buf-form').oninput = calcBuf;
  $('#size-form').onsubmit = $('#buf-form').onsubmit = e => e.preventDefault();

  /* ---------- calendar ---------- */
  let calMonth = null, calSel = null;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const compact = v => {
    const s = Math.abs(v), sign = v < 0 ? '−' : v > 0 ? '+' : '';
    return sign + '$' + (s >= 1000 ? (s / 1000).toFixed(s >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : Math.round(s));
  };
  const longDay = k => new Date(k + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  function calStart() {
    if (calMonth) return;
    const so = sorted(), d = so.length ? new Date(so.at(-1).date + 'T12:00') : new Date();
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  const goMonth = d => { calMonth = d; calSel = null; renderCalendar(); };
  $('#cal-prev').onclick = () => goMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1));
  $('#cal-next').onclick = () => goMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1));
  $('#cal-today').onclick = () => { const n = new Date(); calMonth = new Date(n.getFullYear(), n.getMonth(), 1); calSel = localISO(n); renderCalendar(); };

  function renderCalendar() {
    calStart();
    const y = calMonth.getFullYear(), m = calMonth.getMonth(), todayKey = localISO(new Date());
    $('#cal-title').textContent = calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const byDay = {};
    trades.forEach(t => (byDay[t.date] ||= []).push(t));
    const inMonth = trades.filter(t => { const d = new Date(t.date + 'T12:00'); return d.getFullYear() === y && d.getMonth() === m; });
    const dayTotals = Object.fromEntries(Object.entries(byDay).map(([k, l]) => [k, l.reduce((s, t) => s + t.pl, 0)]));
    const monthDays = [...new Set(inMonth.map(t => t.date))].sort();
    if (!calSel || !calSel.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)) calSel = monthDays.at(-1) || null;

    /* month summary */
    const mpl = inMonth.reduce((s, t) => s + t.pl, 0);
    const green = monthDays.filter(k => dayTotals[k] > 0).length, red = monthDays.filter(k => dayTotals[k] < 0).length;
    const best = monthDays.reduce((b, k) => (b == null || dayTotals[k] > dayTotals[b] ? k : b), null);
    const worst = monthDays.reduce((b, k) => (b == null || dayTotals[k] < dayTotals[b] ? k : b), null);
    const wins = inMonth.filter(t => t.pl > 0).length;
    const tot = Math.max(1, green + red);
    $('#cal-sum').innerHTML = `
      <div class="net"><span>Net P&amp;L</span><b class="${cls(mpl)}">${money(mpl, true)}</b><small>${plural(inMonth.length, 'trade')} on ${plural(monthDays.length, 'day')}</small></div>
      <div><span>Green / red days</span><b><span class="${green ? 'pos' : ''}">${green}</span> <span style="color:var(--faint)">/</span> <span class="${red ? 'neg' : ''}">${red}</span></b>
        <div class="split" aria-hidden="true">${green ? `<i style="width:${green / tot * 100}%;background:var(--pos)"></i>` : ''}${red ? `<i style="width:${red / tot * 100}%;background:var(--loss)"></i>` : ''}</div></div>
      <div><span>Trade win rate</span><b>${inMonth.length ? Math.round(wins / inMonth.length * 100) + '%' : '—'}</b><small>${inMonth.length ? `${wins} of ${inMonth.length} won` : 'No trades'}</small></div>
      <div><span>Best day</span><b class="${best ? cls(dayTotals[best]) : ''}">${best ? money(dayTotals[best], true) : '—'}</b><small>${best ? fmtDate(best) : 'No trades'}</small></div>
      <div><span>Worst day</span><b class="${worst ? cls(dayTotals[worst]) : ''}">${worst ? money(dayTotals[worst], true) : '—'}</b><small>${worst ? fmtDate(worst) : 'No trades'}</small></div>`;

    /* grid */
    const maxAbs = Math.max(1, ...monthDays.map(k => Math.abs(dayTotals[k])));
    const cur = new Date(y, m, 1); cur.setDate(1 - cur.getDay());
    const last = new Date(y, m + 1, 0);
    const weeks = [];
    let html = WEEKDAYS.map(d => `<div class="hd">${d}</div>`).join('') + '<div class="hd total">Week</div>';
    let idx = 0;
    while (cur <= last) {
      let wpl = 0, wn = 0;
      for (let i = 0; i < 7; i++, cur.setDate(cur.getDate() + 1), idx++) {
        const key = localISO(cur), out = cur.getMonth() !== m, list = byDay[key] || [];
        const we = i === 0 || i === 6 ? ' we' : '', today = key === todayKey ? ' today' : '';
        if (!out && list.length) {
          const v = dayTotals[key]; wpl += v; wn += list.length;
          const a = (0.35 + 0.65 * Math.abs(v) / maxAbs).toFixed(2);
          const dots = byTime(list).slice(0, 5).map(t => `<i class="${t.pl > 0 ? 'w' : t.pl < 0 ? 'l' : 'e'}"></i>`).join('') + (list.length > 5 ? `<em>+${list.length - 5}</em>` : '');
          html += `<button type="button" class="day has ${v > 0 ? 'up' : v < 0 ? 'dn' : ''}${we}${today}" style="--a:${a};--i:${idx}" data-day="${key}" aria-pressed="${key === calSel}" aria-label="${longDay(key)}: ${v > 0 ? 'profit' : v < 0 ? 'loss' : 'break-even'} ${money(v, true)} from ${plural(list.length, 'trade')}">
            <span class="top"><span class="n">${cur.getDate()}</span><span class="dots" aria-hidden="true">${dots}</span></span>
            <span class="p ${cls(v)}" data-full="${money(v, true)}">${money(v, true)}</span><span class="c">${plural(list.length, 'trade')}</span></button>`;
        } else {
          html += `<div class="day${out ? ' out' : ''}${we}${today}" style="--i:${idx}"><span class="top"><span class="n">${cur.getDate()}</span></span></div>`;
        }
      }
      weeks.push({ pl: wpl, n: wn });
      html += `<div class="wk"><span class="n">Week ${weeks.length}</span>${wn ? `<span class="p ${cls(wpl)}">${money(wpl, true)}</span><span class="c">${plural(wn, 'trade')}</span>` : '<span class="c" style="margin-top:auto">No trades</span>'}<div class="bar"></div></div>`;
    }
    $('#cal-grid').innerHTML = html;
    const wAbs = Math.max(1, ...weeks.map(w => Math.abs(w.pl)));
    $$('#cal-grid .wk .bar').forEach((b, i) => { const w = weeks[i]; if (w.n) b.innerHTML = `<i style="width:${Math.max(4, Math.abs(w.pl) / wAbs * 100)}%;background:${w.pl >= 0 ? 'var(--pos)' : 'var(--loss)'}"></i>`; });
    $('#wk-strip').innerHTML = weeks.map((w, i) => `<div>Week ${i + 1}<b class="${w.n ? cls(w.pl) : ''}">${w.n ? money(w.pl, true) : '—'}</b></div>`).join('');
    fitDayLabels();
    renderDayPanel();
  }

  /* on narrow screens, swap to short money labels */
  const narrowCal = matchMedia('(max-width:760px)');
  function fitDayLabels() {
    $$('#cal-grid .day .p').forEach(p => { const v = num(p.dataset.full.replace('+', '')); p.textContent = narrowCal.matches ? compact(v) : p.dataset.full; });
  }
  narrowCal.addEventListener?.('change', fitDayLabels);

  function renderDayPanel() {
    const box = $('#day-panel');
    if (!calSel) {
      box.innerHTML = `<div class="dp-empty"><svg aria-hidden="true"><use href="#i-cal"/></svg><b>No trades this month</b>Log a trade and it will show up on its day here.<div style="margin-top:14px"><button class="btn primary sm" type="button" data-new-trade-cal><svg aria-hidden="true"><use href="#i-plus"/></svg>Log trade</button></div></div>`;
      return;
    }
    const list = byTime(trades.filter(t => t.date === calSel));
    if (!list.length) {
      box.innerHTML = `<div class="dp-head"><div class="when">${new Date(calSel + 'T12:00').getFullYear()}</div><h2>${longDay(calSel)}</h2></div><div class="dp-empty"><b>No trades on this day</b>Pick a highlighted day on the calendar.</div>`;
      return;
    }
    const net = list.reduce((s, t) => s + t.pl, 0), w = list.filter(t => t.pl > 0).length;
    const risked = list.reduce((s, t) => s + (t.risk > 0 ? t.risk : 0), 0);
    const r = risked ? net / risked * list.filter(t => t.risk > 0).length : null;
    const mist = list.filter(t => t.mistakes.some(x => x !== 'None')).length;
    box.innerHTML = `
      <div class="dp-head">
        <div class="when">${plural(list.length, 'trade')} · ${new Date(calSel + 'T12:00').getFullYear()}</div>
        <h2>${longDay(calSel)}</h2>
        <div class="dp-net"><b class="${cls(net)}">${money(net, true)}</b><span>${net > 0 ? 'Green day' : net < 0 ? 'Red day' : 'Flat day'}</span></div>
        <div class="dp-stats">
          <div><span>Win rate</span><b>${Math.round(w / list.length * 100)}%</b></div>
          <div><span>Net R</span><b class="${r == null ? '' : cls(r)}">${r == null ? '—' : (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1) + 'R'}</b></div>
          <div><span>Mistakes</span><b class="${mist ? 'neg' : ''}">${mist}</b></div>
        </div>
      </div>
      <ul class="dp-list">${list.map((t, i) => {
        const tr = t.risk > 0 ? t.pl / t.risk : null;
        const ms = t.mistakes.filter(x => x !== 'None');
        return `<li class="dp-trade ${t.pl > 0 ? 'win' : t.pl < 0 ? 'loss' : ''}" style="--i:${i}">
          <span class="rail" aria-hidden="true"></span>
          <div><div class="l1"><b>${esc(t.pair)}</b><span class="chip ${esc(t.direction.toLowerCase())}">${esc(t.direction)}</span></div>
            <div class="l2">${esc(t.time)}${t.session ? ' · ' + esc(t.session) : ''}${t.strategy ? ' · ' + esc(t.strategy) : ''}</div></div>
          <div class="r"><b class="${cls(t.pl)}">${money(t.pl, true)}</b><small>${tr == null ? esc(t.account || '') : (tr > 0 ? '+' : tr < 0 ? '−' : '') + Math.abs(tr).toFixed(2) + 'R'}</small></div>
          <div class="tags">${ms.map(x => `<span class="chip bad">${esc(x)}</span>`).join('')}${t.shots?.length ? `<button type="button" class="btn sm shot-btn" data-shots="${esc(t.id)}" aria-label="View ${plural(t.shots.length, 'screenshot')} for this ${esc(t.pair)} trade"><svg aria-hidden="true"><use href="#i-image"/></svg>${t.shots.length}</button>` : ''}</div>
        </li>`;
      }).join('')}</ul>`;
  }

  $('#cal-grid').addEventListener('click', e => {
    const btn = e.target.closest('.day.has'); if (!btn) return;
    calSel = btn.dataset.day;
    $$('#cal-grid .day.has').forEach(d => d.setAttribute('aria-pressed', String(d === btn)));
    renderDayPanel();
    const p = $('#day-panel'), r = p.getBoundingClientRect();
    if (r.top > innerHeight - 80) p.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  $('#day-panel').addEventListener('click', e => {
    const sh = e.target.closest('[data-shots]');
    if (sh) return openShots(trades.find(x => x.id === sh.dataset.shots));
    if (e.target.closest('[data-new-trade-cal]')) $('[data-new-trade]').click();
  });

  function render(r) {
    if (r === 'dashboard' || !routes.includes(r)) { renderDashboard(); renderSessions(); }
    if (r === 'calendar') renderCalendar();
    if (r === 'journal') renderJournal();
    if (r === 'routine') renderRoutine();
    if (r === 'plan') renderStop();
    if (r === 'mistakes') renderMistakes();
    if (r === 'size') calcSize();
    if (r === 'buffer') calcBuf();
  }

  if (sb) sb.auth.onAuthStateChange(evt => {
    if (evt === 'PASSWORD_RECOVERY') { recovering = true; if (document.body.dataset.state !== 'boot') { setState('auth'); setAuthMode('newpass'); } }
    if (evt === 'SIGNED_OUT' && document.body.dataset.state === 'app') location.reload();
  });
  boot();
})();
