(() => {
  'use strict';
  if (window.TwoFlyDispatch) return;
  const TF = window.TwoFly;
  if (!TF) return;

  const WORKER = 'https://twofly-dispatch-photos.gshoeswho.workers.dev';
  const state = { ready: false, me: null, checked: false, checking: null, notificationTimer: null, objectUrls: new Set() };

  async function token() {
    await TF.ready;
    const current = TF.state.session?.access_token;
    if (current) return current;
    const result = await TF.state.supa.auth.getSession();
    return result.data?.session?.access_token || '';
  }

  async function api(path, options = {}) {
    const access = await token();
    if (!access) throw new Error('Please sign in to 2FLY Numbers.');
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${access}`);
    let body = options.body;
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const response = await fetch(`${WORKER}${path}`, { ...options, body, headers, cache: 'no-store' });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      let message = `Dispatch request failed (${response.status})`;
      try { const data = type.includes('json') ? await response.json() : { error: await response.text() }; message = data.error || message; } catch {}
      const error = new Error(message); error.status = response.status; throw error;
    }
    if (options.raw) return response;
    return type.includes('json') ? response.json() : response.text();
  }

  async function probe(force = false) {
    if (state.checked && !force) return state.ready;
    if (state.checking && !force) return state.checking;
    state.checking = (async () => {
      try {
        state.me = await api('/integrated/me');
        state.ready = true;
      } catch (error) {
        state.ready = false;
        state.me = null;
        console.warn('Dispatch integration not active yet:', error.message);
      }
      state.checked = true;
      state.checking = null;
      return state.ready;
    })();
    return state.checking;
  }

  function orderPayload(order) {
    return {
      order_id: order.id,
      order_number: order.order_number,
      customer_name: order.customer_name || '',
      fulfillment_method: order.fulfillment_method || '',
      created_at: order.created_at || order.order_date,
      status: order.status || '',
      payment_status: order.payment_status || '',
      tracking_number: order.tracking_number || ''
    };
  }

  async function syncOrder(order) {
    if (!order?.id || !(await probe())) return null;
    try { return await api('/integrated/sync', { method: 'POST', body: orderPayload(order) }); }
    catch (error) { console.warn('Dispatch sync did not block the order:', error.message); return null; }
  }

  async function syncOrderById(id) {
    if (!id || !(await probe())) return null;
    try {
      const result = await TF.state.supa.from('v_daily_ops_orders_v16').select('*').eq('id', id).single();
      if (result.error) throw result.error;
      return syncOrder(result.data);
    } catch (error) { console.warn('Dispatch order sync skipped:', error.message); return null; }
  }

  async function syncOrders(orders) {
    if (!Array.isArray(orders) || !orders.length || !(await probe())) return null;
    let total = 0;
    for (let i = 0; i < orders.length; i += 250) {
      const batch = orders.slice(i, i + 250).map(orderPayload);
      try { const result = await api('/integrated/sync-many', { method: 'POST', body: { orders: batch } }); total += Number(result.seen || 0); }
      catch (error) { console.warn('Dispatch batch sync skipped:', error.message); break; }
    }
    return total;
  }

  async function list(params = {}) {
    if (!(await probe())) return [];
    const q = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') q.set(key, value); });
    const result = await api(`/integrated/dispatch?${q.toString()}`);
    return result.records || [];
  }

  async function detail(orderId) {
    if (!(await probe())) return { order: null, photos: [], events: [], issues: [] };
    return api(`/integrated/order?order_id=${encodeURIComponent(orderId)}`);
  }

  async function missingList(params = {}) {
    if (!(await probe())) return [];
    const q = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') q.set(key, value); });
    const result = await api(`/integrated/missing/list?${q.toString()}`);
    return result.issues || [];
  }

  function loadCompression() {
    if (window.compressDispatchPhoto) return Promise.resolve();
    if (window.__dispatchCompressionPromise) return window.__dispatchCompressionPromise;
    window.__dispatchCompressionPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = './dispatch-compression.js'; s.onload = resolve; s.onerror = () => reject(new Error('Photo compression could not load.')); document.head.appendChild(s);
    });
    return window.__dispatchCompressionPromise;
  }

  async function uploadPhoto(orderId, stage, file) {
    await loadCompression();
    const compressed = await window.compressDispatchPhoto(file);
    return api(`/integrated/photos?order_id=${encodeURIComponent(orderId)}&stage=${encodeURIComponent(stage)}`, {
      method: 'POST', body: compressed, headers: { 'Content-Type': 'image/jpeg' }
    });
  }

  async function photoObjectUrl(path) {
    const response = await api(`/integrated/photo?path=${encodeURIComponent(path)}`, { raw: true });
    const url = URL.createObjectURL(await response.blob()); state.objectUrls.add(url); return url;
  }
  function revokeObjectUrls() { for (const url of state.objectUrls) URL.revokeObjectURL(url); state.objectUrls.clear(); }

  function stageLabel(stage) {
    return ({ needs_packing: 'Needs packing', packing: 'Packing', packed: 'Packed', ready_for_pickup: 'Ready for pickup', shipped: 'Shipped', cancelled: 'Cancelled' })[stage] || stage || 'Not queued';
  }
  function stagePill(stage) {
    const tone = stage === 'shipped' ? 'ok' : ['packing','packed','ready_for_pickup'].includes(stage) ? 'warn' : stage === 'cancelled' ? 'danger' : '';
    return `<span class="pill ${tone}">${TF.esc(stageLabel(stage))}</span>`;
  }

  async function renderPhotoStrip(photos, target) {
    if (!target) return;
    revokeObjectUrls();
    if (!photos.length) { target.innerHTML = '<div class="empty">No Dispatch photos yet.</div>'; return; }
    target.innerHTML = photos.map((p, i) => `<button class="dispatch-photo-card" data-photo-index="${i}" type="button"><span>Loading…</span><small>${TF.esc(String(p.stage || '').replaceAll('_',' '))}<br>${TF.formatDateTime(p.created_at)}</small></button>`).join('');
    await Promise.all(photos.map(async (p, i) => {
      try {
        const url = await photoObjectUrl(p.path); const button = target.querySelector(`[data-photo-index="${i}"]`); if (!button) return;
        button.innerHTML = `<img src="${TF.esc(url)}" alt="Dispatch proof"><small>${TF.esc(String(p.stage || '').replaceAll('_',' '))} • ${TF.esc(p.owner_name || '')}<br>${TF.formatDateTime(p.created_at)}</small>`;
        button.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
      } catch { const button = target.querySelector(`[data-photo-index="${i}"]`); if (button) button.innerHTML = '<span>Photo unavailable</span>'; }
    }));
  }

  async function renderOrderPanel(orderId, element) {
    if (!element) return;
    if (!(await probe())) { element.innerHTML = '<div class="notice warn">Dispatch is not activated on the Worker yet. Existing Orders functions are unchanged.</div>'; return; }
    try {
      const data = await detail(orderId), order = data.order;
      if (!order) { element.innerHTML = '<div class="notice info">This order is not in Dispatch yet. It enters Needs packing after it becomes an eligible paid J&T/Lalamove order.</div>'; return; }
      const claim = order.stage === 'needs_packing' && state.me?.canPack ? `<button class="btn primary small" data-dispatch-claim="${order.order_id}">Start packing</button>` : '';
      const owner = order.stage === 'packing' ? `<strong>Packing — ${TF.esc(order.claimed_name || 'Staff')}</strong>` : '';
      element.innerHTML = `<div class="dispatch-order-summary-head"><div>${stagePill(order.stage)} ${owner}</div><a class="btn small" href="./dispatch.html?order=${encodeURIComponent(order.order_id)}">Open Dispatch</a></div>
        <div class="dispatch-mini-meta"><span>Queued ${TF.formatDateTime(order.queued_at)}</span><span>${TF.esc(order.tracking || 'Tracking not added yet')}</span><span>${Number(order.open_issue_count || data.issues.filter(x=>x.status==='open').length)} open missing-item issue(s)</span></div>
        <div class="dispatch-mini-actions">${claim}</div>
        <div class="dispatch-photo-strip" data-dispatch-photos></div>
        <div class="dispatch-mini-history">${(data.events || []).slice(0,8).map(e=>`<div><strong>${TF.esc(String(e.event_type||'').replaceAll('_',' '))}</strong><small>${TF.formatDateTime(e.event_at)} • ${TF.esc(e.actor_name || 'System')}</small></div>`).join('') || '<div class="empty">No Dispatch history yet.</div>'}</div>`;
      element.querySelector('[data-dispatch-claim]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget; TF.setLoading(button, true, 'Claiming…');
        try { await api('/integrated/claim', { method:'POST', body:{ order_id: orderId } }); TF.toast('Packing claimed'); await renderOrderPanel(orderId, element); }
        catch (error) { TF.fail(error, 'Could not start packing'); }
        finally { TF.setLoading(button, false); }
      });
      await renderPhotoStrip(data.photos || [], element.querySelector('[data-dispatch-photos]'));
    } catch (error) { element.innerHTML = `<div class="notice danger">${TF.esc(error.message)}</div>`; }
  }

  function base64UrlToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4), base64 = (value + padding).replace(/-/g,'+').replace(/_/g,'/'), raw = atob(base64);
    return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Phone notifications are not supported in this browser.');
    const config = await api('/integrated/push/config');
    if (!config.enabled || !config.publicKey) throw new Error('Phone notifications are not configured on the Worker yet.');
    const registration = await navigator.serviceWorker.register('./dispatch-sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not allowed.');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:base64UrlToBytes(config.publicKey) });
    await api('/integrated/push/subscribe', { method:'POST', body:{ subscription: subscription.toJSON() } });
    return true;
  }

  function injectBell() {
    if (document.getElementById('dispatchBellButton') || !document.querySelector('.top-actions')) return;
    const wrap = document.createElement('div'); wrap.className='dispatch-bell-wrap'; wrap.innerHTML=`<button id="dispatchBellButton" class="btn dispatch-bell-button" type="button" aria-label="Dispatch notifications">🔔<span id="dispatchUnreadBadge" class="dispatch-unread-badge hidden">0</span></button><div id="dispatchBellPanel" class="dispatch-bell-panel hidden"><div class="dispatch-bell-head"><strong>Dispatch alerts</strong></div><div id="dispatchNotificationList" class="dispatch-notification-list"><div class="empty">Loading…</div></div></div>`;
    document.querySelector('.top-actions').prepend(wrap);
    document.getElementById('dispatchBellButton').addEventListener('click', () => document.getElementById('dispatchBellPanel').classList.toggle('hidden'));
    document.addEventListener('click', event => { if (!wrap.contains(event.target)) document.getElementById('dispatchBellPanel')?.classList.add('hidden'); });
  }

  async function loadNotifications() {
    if (!(await probe())) return;
    injectBell();
    try {
      const data = await api('/integrated/notifications?limit=30');
      const badge = document.getElementById('dispatchUnreadBadge'); if (badge) { badge.textContent = data.unread || 0; badge.classList.toggle('hidden', !data.unread); }
      const listEl = document.getElementById('dispatchNotificationList'); if (!listEl) return;
      listEl.innerHTML = (data.notifications || []).map(n => `<button class="dispatch-notification ${n.is_read ? 'read' : 'unread'}" data-notification-id="${TF.esc(n.id)}" data-notification-order="${TF.esc(n.order_id)}" type="button"><strong>${TF.esc(n.body)}</strong><small>${TF.formatDateTime(n.created_at)}</small></button>`).join('') || '<div class="empty">No Dispatch alerts yet.</div>';
      listEl.querySelectorAll('[data-notification-id]').forEach(button => button.addEventListener('click', async () => {
        try { await api('/integrated/notifications/read', { method:'POST', body:{ id:button.dataset.notificationId } }); } catch {}
        location.href = `./dispatch.html?order=${encodeURIComponent(button.dataset.notificationOrder)}`;
      }));
    } catch (error) { console.warn('Dispatch notification refresh failed:', error.message); }
  }

  async function bootNotifications() {
    await TF.ready;
    if (!(await probe())) return;
    injectBell(); await loadNotifications();
    if (state.notificationTimer) clearInterval(state.notificationTimer);
    state.notificationTimer = setInterval(() => { if (!document.hidden) loadNotifications(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotifications(); });
  }

  window.TwoFlyDispatch = { WORKER, state, api, probe, syncOrder, syncOrderById, syncOrders, list, detail, missingList, uploadPhoto, photoObjectUrl, revokeObjectUrls, stageLabel, stagePill, renderOrderPanel, loadNotifications };
  bootNotifications().catch(error => console.warn('Dispatch bell unavailable:', error.message));
})();
