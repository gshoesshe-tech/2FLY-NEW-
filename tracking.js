(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let active = null;

  function isJnt(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    return String(method || '').toLowerCase() === 'jnt';
  }

  function needsTracking(order) {
    return isJnt(order) && ['ready_to_ship', 'shipped'].includes(order.status) && !String(order.tracking_number || '').trim();
  }

  function hasFulfillment(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    return ['jnt', 'lalamove', 'walk_in'].includes(String(method || '').toLowerCase());
  }

  function fulfillmentText(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    if (method === 'jnt') return 'J&T';
    if (method === 'lalamove') return 'Lalamove';
    if (method === 'walk_in') return 'Walk-in / Pickup';
    return 'Not selected';
  }

  function simpleStatus(orderOrStatus) {
    const status = typeof orderOrStatus === 'string' ? orderOrStatus : orderOrStatus?.status;
    if (status === 'delivered') return 'delivered';
    if (['packing', 'ready_to_ship', 'shipped'].includes(status)) return 'processing';
    return 'pending';
  }

  function simpleStatusPill(order) {
    const value = simpleStatus(order);
    const label = value === 'delivered' ? 'Delivered' : value === 'processing' ? 'Processing' : 'Pending';
    const tone = value === 'delivered' ? 'ok' : value === 'processing' ? 'info' : 'warn';
    return `<span class="pill simple-order-status ${tone}">${label}</span>`;
  }

  function facebookUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(?:www\.)?(?:facebook\.com|m\.facebook\.com|fb\.com|messenger\.com)\//i.test(raw)) return `https://${raw}`;
    if (/^@?[a-z0-9.]+$/i.test(raw)) return `https://www.facebook.com/${raw.replace(/^@/, '')}`;
    return `https://www.facebook.com/search/top?q=${encodeURIComponent(raw)}`;
  }

  function facebookLink(value, label = 'Open Facebook') {
    const url = facebookUrl(value);
    if (!url) return '';
    return `<a class="btn small" href="${TF.esc(url)}" target="_blank" rel="noopener noreferrer">${TF.esc(label)}</a>`;
  }

  function message(order, status = simpleStatus(order), tracking = order.tracking_number) {
    const simple = ['pending', 'processing', 'delivered'].includes(status) ? status : simpleStatus(status);
    const jnt = isJnt(order);
    const code = jnt && tracking ? `
Tracking number: ${tracking}` : '';
    const method = fulfillmentText(order);
    if (TF.num(order.pending_payment_count) > 0) return `Hi! Nareceive na po namin ang payment details for ${order.order_number}. For verification pa po ito.`;
    if (simple === 'pending') return `Hi! Pending pa po ang order ${order.order_number}. We’ll update you once processing na.`;
    if (simple === 'processing') return jnt ? `Hi! Processing na po ang order ${order.order_number} for J&T.${code}` : `Hi! Processing na po ang order ${order.order_number} for ${method}. No tracking number is needed.`;
    return jnt ? `Hi! Delivered na po ang order ${order.order_number}.${code}
Thank you for ordering!` : `Hi! Completed na po ang order ${order.order_number} through ${method}. Thank you for ordering!`;
  }

  function filtered() {
    const query = TF.$('trackingSearch').value.trim().toLowerCase();
    const filter = TF.$('trackingFilter').value;
    return orders.filter((order) => {
      const found = !query || [order.customer_name, order.phone, order.facebook_profile, order.order_number, order.tracking_number].some((value) => String(value || '').toLowerCase().includes(query));
      if (!found) return false;
      if (filter === 'all') return true;
      if (filter === 'active') return !['delivered', 'cancelled', 'refunded'].includes(order.status);
      if (filter === 'missing_tracking') return needsTracking(order);
      if (filter === 'paid_late') return order.paid_not_shipped_alert;
      if (['pending', 'processing', 'delivered'].includes(filter)) return simpleStatus(order) === filter;
      return true;
    });
  }

  function trackingCell(order) {
    if (!isJnt(order)) return `<span class="tracking-not-required">Not required</span><br><small>${TF.esc(fulfillmentText(order))}</small>`;
    if (order.tracking_number) return `<code>${TF.esc(order.tracking_number)}</code><br><small>J&T</small>`;
    return `<span class="muted">No tracking yet</span>${needsTracking(order) ? '<br><span class="pill danger">J&T tracking needed</span>' : ''}`;
  }

  function render() {
    const rows = filtered();
    TF.$('trackingTable').innerHTML = `<table class="tracking-clean-table"><thead><tr><th>Customer</th><th>Order</th><th>Status</th><th>Method</th><th>Tracking</th><th>Dates</th><th>Last update</th><th>Actions</th></tr></thead><tbody>${rows.map((order) => `<tr class="${needsTracking(order) || order.paid_not_shipped_alert ? 'attention-row' : ''}">
      <td><strong>${TF.esc(order.customer_name)}</strong><br><small>${TF.esc(order.phone || '')}</small>${order.facebook_profile ? `<br>${facebookLink(order.facebook_profile, 'Open profile')}` : ''}</td>
      <td><strong class="order-number-text">${TF.esc(order.order_number)}</strong><br><small>${TF.formatDate(order.order_date)}</small></td>
      <td>${simpleStatusPill(order)}<br><small>${TF.num(order.pending_payment_count) > 0 ? 'For Verification' : TF.statusLabel(order.payment_status)}</small></td>
      <td><strong>${TF.esc(fulfillmentText(order))}</strong></td>
      <td>${trackingCell(order)}</td>
      <td><small>Shipped: ${TF.formatDate(order.shipped_at)}<br>Delivered: ${TF.formatDate(order.delivered_at)}</small></td>
      <td>${TF.formatDateTime(order.last_activity_at)}</td>
      <td><div class="row-actions"><button class="btn primary small" data-edit="${order.id}">Update Status</button><button class="btn small" data-message="${order.id}">Copy Message</button>${isJnt(order) && order.tracking_number ? `<button class="btn small" data-copy="${order.id}">Copy Tracking</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No matching orders.</td></tr>'}</tbody></table>`;
  }

  function updateTrackingRule() {
    const jnt = isJnt(TF.$('trackMethod').value);
    const input = TF.$('trackNumber');
    input.disabled = !jnt;
    input.placeholder = jnt ? 'Enter J&T tracking when available' : 'Not required for this method';
    if (!jnt) input.value = '';
    TF.$('trackNumberWrap')?.classList.toggle('tracking-disabled-field', !jnt);
    const help = TF.$('trackNumberHelp');
    if (help) help.textContent = jnt ? 'Only J&T orders use a tracking number.' : `${fulfillmentText(TF.$('trackMethod').value)} orders do not need a tracking number.`;
    TF.$('copyTrackingNumber').classList.toggle('hidden', !jnt || !input.value.trim());
    updatePreview();
  }

  function open(order) {
    active = order;
    TF.$('trackingDialogTitle').textContent = `${order.order_number} — ${order.customer_name}`;
    TF.$('trackingDialogMeta').innerHTML = `${simpleStatusPill(order)} ${TF.num(order.pending_payment_count) > 0 ? TF.statusPill('submitted') : TF.statusPill(order.payment_status)}`;
    const facebookButton = TF.$('trackingFacebookBtn');
    const facebookProfileUrl = facebookUrl(order.facebook_profile);
    facebookButton.classList.toggle('hidden', !facebookProfileUrl);
    facebookButton.href = facebookProfileUrl || '#';
    TF.$('trackStatus').value = simpleStatus(order);
    TF.$('trackMethod').value = order.fulfillment_method || 'unselected';
    TF.$('trackNumber').value = isJnt(order) ? (order.tracking_number || '') : '';
    TF.$('trackShippedDate').value = order.shipped_at ? String(order.shipped_at).slice(0, 10) : '';
    TF.$('trackDeliveredDate').value = order.delivered_at ? String(order.delivered_at).slice(0, 10) : '';
    TF.$('trackCourierCost').value = order.courier_cost_finalized ? TF.num(order.actual_courier_cost).toFixed(2) : '';
    TF.$('trackCustomerNote').value = order.customer_update_note || '';
    TF.$('trackStatusNote').value = '';
    updateTrackingRule();
    TF.$('trackingDialog').showModal();
  }

  function updatePreview() {
    if (!active) return;
    const draft = { ...active, fulfillment_method: TF.$('trackMethod').value };
    TF.$('trackingMessage').textContent = message(draft, TF.$('trackStatus').value, TF.$('trackNumber').value.trim());
    TF.$('copyTrackingNumber').classList.toggle('hidden', !isJnt(draft) || !TF.$('trackNumber').value.trim());
  }

  async function save(event) {
    event.preventDefault();
    const button = event.submitter;
    TF.setLoading(button, true, 'Saving…');
    try {
      const method = TF.$('trackMethod').value;
      const desired = TF.$('trackStatus').value;
      const trackingNumber = isJnt(method) ? TF.$('trackNumber').value.trim() : '';
      if (['processing', 'delivered'].includes(desired) && !hasFulfillment(method)) throw new Error('Select J&T, Lalamove, or Walk-in / Pickup first.');
      if (desired === 'processing' && (!['paid', 'overpaid'].includes(active.payment_status) || TF.num(active.pending_payment_count) > 0)) throw new Error('Verify the full payment before starting processing.');
      if (desired === 'processing' && TF.num(active.shortage_quantity) > 0) throw new Error('This order is still short on stock.');
      if (desired === 'delivered' && (!['paid', 'overpaid'].includes(active.payment_status) || TF.num(active.pending_payment_count) > 0)) throw new Error('Verify the full payment before marking delivered.');
      if (desired === 'delivered' && TF.num(active.shortage_quantity) > 0) throw new Error('This order is still short on stock.');
      if (desired === 'delivered' && isJnt(method) && !trackingNumber) throw new Error('Add the J&T tracking number before marking delivered.');
      const common = {
        p_order_id: active.id,
        p_fulfillment_method: method,
        p_tracking_number: trackingNumber,
        p_actual_courier_cost: TF.$('trackCourierCost').value.trim() === '' ? null : TF.num(TF.$('trackCourierCost').value),
        p_customer_update_note: TF.$('trackCustomerNote').value,
        p_status_note: TF.$('trackStatusNote').value || `Simple status: ${desired}`
      };
      if (desired === 'delivered') {
        if (active.status !== 'shipped') {
          const shipped = await TF.state.supa.rpc('update_order_operations_v14', { ...common, p_status: 'shipped', p_shipped_date: TF.today(), p_delivered_date: null });
          if (shipped.error) throw shipped.error;
        }
        const delivered = await TF.state.supa.rpc('update_order_operations_v14', { ...common, p_status: 'delivered', p_shipped_date: TF.today(), p_delivered_date: TF.today() });
        if (delivered.error) throw delivered.error;
      } else {
        let target = active.status;
        if (desired === 'processing' && !['packing', 'ready_to_ship', 'shipped'].includes(active.status)) target = 'packing';
        if (desired === 'pending' && simpleStatus(active) !== 'pending') target = ['paid', 'overpaid'].includes(active.payment_status) ? 'ready_to_pack' : 'draft';
        const result = await TF.state.supa.rpc('update_order_operations_v14', { ...common, p_status: target, p_shipped_date: target === 'shipped' ? TF.today() : null, p_delivered_date: null });
        if (result.error) throw result.error;
      }
      TF.toast('Order updated');
      TF.$('trackingDialog').close();
      await load();
    } catch (error) {
      TF.fail(error, 'Order update failed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function action(event) {
    const edit = event.target.closest('[data-edit]');
    const msg = event.target.closest('[data-message]');
    const copy = event.target.closest('[data-copy]');
    const id = edit?.dataset.edit || msg?.dataset.message || copy?.dataset.copy;
    if (!id) return;
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    if (edit) open(order);
    if (msg) await TF.copyText(message(order), 'Customer update copied');
    if (copy && isJnt(order)) await TF.copyText(order.tracking_number, 'Tracking number copied');
  }

  async function load() {
    const result = await TF.state.supa.from('v_daily_ops_orders_v16').select('*').order('last_activity_at', { ascending: false }).limit(5000);
    if (result.error) throw result.error;
    orders = result.data || [];
    TF.$('trackingMissing').textContent = orders.filter(needsTracking).length;
    TF.$('trackingReady').textContent = orders.filter((order) => simpleStatus(order) === 'pending').length;
    TF.$('trackingShipped').textContent = orders.filter((order) => simpleStatus(order) === 'processing').length;
    TF.$('trackingWaiting').textContent = orders.filter((order) => simpleStatus(order) === 'delivered').length;
    TF.$('trackingLate').textContent = orders.filter((order) => order.paid_not_shipped_alert).length;
    render();
  }

  TF.ready.then(async () => {
    const queryFilter = new URLSearchParams(location.search).get('filter');
    if (queryFilter && [...TF.$('trackingFilter').options].some((option) => option.value === queryFilter)) TF.$('trackingFilter').value = queryFilter;
    TF.$('trackingSearch').addEventListener('input', render);
    TF.$('trackingFilter').addEventListener('change', render);
    TF.$('trackingTable').addEventListener('click', (event) => action(event).catch((error) => TF.fail(error, 'Tracking action failed')));
    TF.$('trackingForm').addEventListener('submit', save);
    TF.$('closeTrackingDialog').addEventListener('click', () => TF.$('trackingDialog').close());
    TF.$('trackMethod').addEventListener('change', updateTrackingRule);
    ['trackStatus', 'trackNumber'].forEach((id) => TF.$(id).addEventListener('input', updatePreview));
    TF.$('copyTrackingUpdate').addEventListener('click', () => TF.copyText(TF.$('trackingMessage').textContent, 'Customer update copied'));
    TF.$('copyTrackingNumber').addEventListener('click', () => TF.copyText(TF.$('trackNumber').value, 'Tracking number copied'));
    document.querySelectorAll('[data-filter-card]').forEach((card) => card.addEventListener('click', (event) => {
      event.preventDefault();
      TF.$('trackingFilter').value = card.dataset.filterCard;
      render();
    }));
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Tracking failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Tracking failed'));
})();
