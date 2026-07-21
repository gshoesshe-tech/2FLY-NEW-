(() => {
  'use strict';

  const cfg = window.__2FLY_CONFIG__ || {};
  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const money = (value) => `₱${Number(value || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })}`;
  const num = (value) => Number(value || 0);
  const today = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const monthKey = () => today().slice(0, 7);
  const isoDate = (value) => value ? String(value).slice(0, 10) : '';
  const addDays = (dateText, days) => {
    const base = new Date(`${isoDate(dateText)}T00:00:00`);
    if (Number.isNaN(base.getTime())) return '';
    base.setDate(base.getDate() + Number(days || 0));
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  };
  const daysBetween = (fromValue, toValue = today()) => {
    const from = new Date(`${isoDate(fromValue)}T00:00:00`);
    const to = new Date(`${isoDate(toValue)}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
    return Math.max(0, Math.floor((to - from) / 86400000));
  };
  const dateInRange = (value, start, end) => {
    const date = isoDate(value);
    if (!date) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  };
  const presetRange = (preset) => {
    const current = today();
    const date = new Date(`${current}T00:00:00`);
    if (preset === 'all') return { start: '', end: '' };
    if (preset === 'today') return { start: current, end: current };
    if (preset === 'yesterday') { const day = addDays(current, -1); return { start: day, end: day }; }
    if (preset === 'last7') return { start: addDays(current, -6), end: current };
    if (preset === 'this_week') {
      const mondayOffset = (date.getDay() + 6) % 7;
      return { start: addDays(current, -mondayOffset), end: current };
    }
    if (preset === 'this_month') return { start: `${current.slice(0, 7)}-01`, end: current };
    return { start: '', end: '' };
  };
  const formatDate = (value) => {
    if (!value) return '—';
    const raw = String(value).slice(0, 10);
    const date = new Date(`${raw}T00:00:00`);
    return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  };
  const normalizeCategoryLabel = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  let toastTimer;

  const fullPermissions = {
    create_orders: true,
    edit_orders: true,
    confirm_payments: true,
    update_tracking: true,
    manage_inventory: true,
    view_daily_summary: true,
    manage_settings: true
  };

  const state = {
    supa: null,
    session: null,
    profile: null,
    role: 'none',
    permissions: {},
    dailySettings: null,
    products: [],
    productByCode: new Map(),
    categories: [],
    categoryById: new Map(),
    aliasToCategory: new Map(),
    accounts: [],
    settings: null
  };

  function toast(message, error = false) {
    let element = $('toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'toast';
      element.className = 'toast';
      document.body.appendChild(element);
    }
    element.textContent = message;
    element.classList.toggle('error', error);
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  function fail(error, prefix = '') {
    const message = error?.message || String(error || 'Unknown error');
    console.error(prefix, message, error);
    toast(`${prefix ? `${prefix}: ` : ''}${message}`, true);
  }

  function setLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      button.dataset.oldLabel = button.textContent;
      button.disabled = true;
      button.textContent = label || 'Saving…';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.oldLabel || button.textContent;
    }
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function isManagement() {
    return ['owner', 'admin'].includes(state.role);
  }

  function isOwner() {
    return state.role === 'owner';
  }

  function can(permission) {
    return Boolean(state.permissions?.[permission]);
  }

  const statusLabels = {
    draft: 'Awaiting Payment',
    payment_review: 'Payment Review',
    confirmed: 'Paid',
    waiting_stock: 'Waiting for Stock',
    ready_to_pack: 'Paid / Ready to Pack',
    packing: 'Packing',
    ready_to_ship: 'Ready to Ship',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    refunded: 'Refunded',
    unpaid: 'Unpaid',
    partial: 'Partially Paid',
    paid: 'Paid',
    overpaid: 'Overpaid',
    verified: 'Verified',
    submitted: 'For Verification',
    rejected: 'Rejected'
  };

  function statusLabel(value) {
    const key = String(value || '');
    return statusLabels[key] || key.replaceAll('_', ' ');
  }

  function statusPill(value) {
    const key = String(value || '');
    const success = ['paid', 'overpaid', 'ready_to_pack', 'ready_to_ship', 'delivered', 'verified', 'completed'];
    const warning = ['waiting_stock', 'partial', 'payment_review', 'packing', 'shipped', 'incoming', 'partially_received', 'submitted'];
    const danger = ['cancelled', 'refunded', 'unpaid', 'voided', 'rejected'];
    const className = success.includes(key) ? 'ok' : warning.includes(key) ? 'warn' : danger.includes(key) ? 'danger' : '';
    return `<span class="pill ${className}">${esc(statusLabel(key))}</span>`;
  }

  function accountOptions(includeBlank = true) {
    const blank = includeBlank ? '<option value="">Select account</option>' : '';
    return blank + state.accounts.map((account) => `<option value="${account.id}">${esc(account.name)}</option>`).join('');
  }

  function categoryOptions() {
    return state.categories.map((category) => `<option value="${esc(category.code)}">${esc(category.name)}</option>`).join('');
  }

  async function copyText(text, successMessage = 'Copied') {
    const value = String(text || '');
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement('textarea');
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    toast(successMessage);
  }

  function buildNavigation() {
    const nav = document.querySelector('.sidebar nav');
    if (!nav) return;
    const links = [
      ['dashboard', './dashboard.html', 'Dashboard', true],
      ['new-order', './new-order.html', 'New Order', can('create_orders')],
      ['orders', './orderpage.html', 'Orders', can('create_orders') || can('edit_orders') || can('confirm_payments')],
      ['todo', './todo.html', 'To Do', true],
      ['tracking', './tracking.html', 'Tracking & Updates', can('update_tracking') || isManagement()],
      ['inventory', './inventory.html', 'Inventory', true],
      ['daily', './daily.html', 'Daily Summary', can('view_daily_summary')],
      ['settings', './settings.html', 'Settings', isOwner()],
    ];
    nav.innerHTML = links
      .filter(([, , , visible]) => visible)
      .map(([key, href, label]) => `<a href="${href}" data-nav="${key}" class="nav-btn">${label}</a>`)
      .join('');
  }

  function applyPermissionVisibility() {
    $$('.management-only').forEach((element) => element.classList.toggle('hidden', !isManagement()));
    $$('.owner-only').forEach((element) => element.classList.toggle('hidden', !isOwner()));
    const map = {
      'perm-create-orders': 'create_orders',
      'perm-edit-orders': 'edit_orders',
      'perm-confirm-payments': 'confirm_payments',
      'perm-update-tracking': 'update_tracking',
      'perm-manage-inventory': 'manage_inventory',
      'perm-view-summary': 'view_daily_summary',
      'perm-manage-settings': 'manage_settings'
    };
    Object.entries(map).forEach(([className, permission]) => {
      $$(`.${className}`).forEach((element) => element.classList.toggle('hidden', !can(permission)));
    });
  }

  function enforcePageAccess() {
    const required = document.body.dataset.requiredRole || 'team';
    if (required === 'management' && !isManagement()) {
      location.replace('./dashboard.html');
      return false;
    }
    if (required === 'owner' && !isOwner()) {
      location.replace('./dashboard.html');
      return false;
    }
    const permission = document.body.dataset.requiredPermission;
    if (permission && !can(permission)) {
      location.replace('./dashboard.html');
      return false;
    }
    return true;
  }

  async function loadBaseData() {
    const [categoriesResult, aliasesResult, productsResult, accountsResult, settingsResult, permissionsResult, dailySettingsResult] = await Promise.all([
      state.supa.from('inventory_categories').select('*').eq('active', true).order('name'),
      state.supa.from('category_aliases').select('*'),
      state.supa.from('products').select('*,inventory_categories(code,name)').eq('active', true).order('code'),
      state.supa.from('cash_accounts').select('*').eq('active', true).order('name'),
      state.supa.from('business_settings').select('*').eq('singleton', true).single(),
      state.supa.rpc('get_daily_ops_permissions_v14'),
      state.supa.from('daily_ops_settings_v14').select('*').eq('singleton', true).single()
    ]);

    const error = categoriesResult.error || aliasesResult.error || productsResult.error || settingsResult.error || permissionsResult.error || dailySettingsResult.error;
    if (error) throw error;
    if (accountsResult.error && isManagement()) throw accountsResult.error;

    state.categories = categoriesResult.data || [];
    state.products = productsResult.data || [];
    state.accounts = accountsResult.data || [];
    state.settings = settingsResult.data;
    state.dailySettings = dailySettingsResult.data;
    state.permissions = isManagement() ? { ...fullPermissions } : (permissionsResult.data || {});
    state.categoryById = new Map(state.categories.map((category) => [category.id, category]));
    state.productByCode = new Map(state.products.map((product) => [String(product.code).toUpperCase(), product]));
    state.aliasToCategory = new Map();
    (aliasesResult.data || []).forEach((alias) => state.aliasToCategory.set(normalizeCategoryLabel(alias.alias), state.categoryById.get(alias.category_id)));
    state.categories.forEach((category) => state.aliasToCategory.set(normalizeCategoryLabel(category.name), category));
  }

  function initShell() {
    buildNavigation();
    if ($('userEmail')) $('userEmail').textContent = state.profile.full_name || state.profile.email || state.session.user.email || '—';
    if ($('userRole')) $('userRole').textContent = String(state.role).toUpperCase();
    const active = document.body.dataset.page;
    $$('[data-nav]').forEach((link) => link.classList.toggle('active', link.dataset.nav === active));
    if ($('logoutBtn')) $('logoutBtn').addEventListener('click', async () => {
      await state.supa.auth.signOut();
      location.replace('./index.html');
    });
    if ($('refreshBtn')) $('refreshBtn').addEventListener('click', () => window.dispatchEvent(new CustomEvent('twofly:refresh')));
    applyPermissionVisibility();
  }

  async function init() {
    if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR_PROJECT')) {
      document.body.innerHTML = '<main class="auth-shell"><section class="auth-card"><h2>Configuration required</h2><p class="notice danger">Open config.js and paste the URL and anon key from the NEW Supabase project.</p></section></main>';
      throw new Error('Missing Supabase configuration');
    }

    state.supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const sessionResult = await state.supa.auth.getSession();
    if (sessionResult.error) throw sessionResult.error;
    const session = sessionResult.data.session;
    if (!session) {
      location.replace('./index.html');
      return state;
    }

    state.session = session;
    const profileResult = await state.supa.from('profiles').select('*').eq('user_id', session.user.id).single();
    if (profileResult.error) throw profileResult.error;
    if (!profileResult.data.active) throw new Error('This team account is inactive.');
    state.profile = profileResult.data;
    state.role = state.profile.role;

    await loadBaseData();
    if (!enforcePageAccess()) return state;
    initShell();
    return state;
  }

  window.TwoFly = {
    state, $, $$, esc, money, num, today, monthKey, isoDate, addDays, daysBetween, dateInRange, presetRange, formatDate, formatDateTime,
    normalizeCategoryLabel, sha256, toast, fail, setLoading, isManagement,
    isOwner, can, statusLabel, statusPill, accountOptions, categoryOptions,
    copyText, ready: init()
  };
})();
