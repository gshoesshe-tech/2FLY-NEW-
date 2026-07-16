(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let active = null;

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

  function message(order, status = order.status, tracking = order.tracking_number) {
    const code = tracking ? `\nTracking number: ${tracking}` : '';
    if (status === 'waiting_stock') return `Hi! Confirmed na po ang payment for ${order.order_number}. Waiting lang po tayo sa requested stock/design. We’ll update you once ready for packing.`;
    if (['confirmed', 'ready_to_pack'].includes(status)) return `Hi! Confirmed na po ang payment for ${order.order_number}. Ready na po ang stock and naka-queue na for packing.`;
    if (status === 'packing') return `Hi! Currently being packed na po ang order ${order.order_number}. We’ll send the tracking number once available.`;
    if (status === 'ready_to_ship') return `Hi! Ready to ship na po ang order ${order.order_number}. Waiting na lang po sa courier handoff and tracking number.`;
    if (status === 'shipped') return `Hi! Shipped na po ang order ${order.order_number} through ${String(order.fulfillment_method || 'J&T').toUpperCase().replace('_', '-')}.${code}\nThank you!`;
    if (status === 'delivered') return `Hi! Marked delivered na po ang order ${order.order_number}.${code}\nThank you for ordering!`;
    return `Hi! Update for order ${order.order_number}: ${TF.statusLabel(status)}.`;
  }

  function filtered() {
    const query = TF.$('trackingSearch').value.trim().toLowerCase();
    const filter = TF.$('trackingFilter').value;
    return orders.filter((order) => {
      const found = !query || [order.customer_name, order.phone, order.facebook_profile, order.order_number, order.tracking_number].some((value) => String(value || '').toLowerCase().includes(query));
      if (!found) return false;
      if (filter === 'all') return true;
      if (filter === 'active') return !['delivered', 'cancelled', 'refunded'].includes(order.status);
      if (filter === 'missing_tracking') return order.missing_tracking;
      if (filter === 'paid_late') return order.paid_not_shipped_alert;
      return order.status === filter;
    });
  }

  function render() {
    const rows = filtered();
    TF.$('trackingTable').innerHTML = `<table><thead><tr><th>Customer</th><th>Order</th><th>Status</th><th>Courier</th><th>Tracking</th><th>Dates</th><th>Last update</th><th>Actions</th></tr></thead><tbody>${rows.map((order) => `<tr class="${order.missing_tracking || order.paid_not_shipped_alert ? 'attention-row' : ''}">
      <td><strong>${TF.esc(order.customer_name)}</strong><br><small>${TF.esc(order.phone || '')}</small>${order.facebook_profile ? `<br>${facebookLink(order.facebook_profile, 'Open profile')}` : ''}</td>
      <td>${TF.esc(order.order_number)}<br><small>${TF.formatDate(order.order_date)}</small></td>
      <td>${TF.statusPill(order.status)}<br>${TF.statusPill(order.payment_status)}</td>
      <td>${TF.esc(String(order.fulfillment_method || 'unselected').toUpperCase().replace('_', '-'))}</td>
      <td>${order.tracking_number ? `<code>${TF.esc(order.tracking_number)}</code>` : '<span class="muted">Not available</span>'}${order.missing_tracking ? '<br><span class="pill danger">Missing</span>' : ''}</td>
      <td><small>Shipped: ${TF.formatDate(order.shipped_at)}<br>Delivered: ${TF.formatDate(order.delivered_at)}</small></td>
      <td>${TF.formatDateTime(order.last_activity_at)}</td>
      <td><div class="row-actions"><button class="btn primary small" data-edit="${order.id}">Update</button><button class="btn small" data-message="${order.id}">Copy Message</button>${order.tracking_number ? `<button class="btn small" data-copy="${order.id}">Copy Tracking</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No matching orders.</td></tr>'}</tbody></table>`;
  }

  function open(order) {
    active = order;
    TF.$('trackingDialogTitle').textContent = `${order.order_number} — ${order.customer_name}`;
    TF.$('trackingDialogMeta').innerHTML = `${TF.statusPill(order.payment_status)} ${TF.statusPill(order.status)}`;
    const facebookButton = TF.$('trackingFacebookBtn');
    const facebookProfileUrl = facebookUrl(order.facebook_profile);
    facebookButton.classList.toggle('hidden', !facebookProfileUrl);
    facebookButton.href = facebookProfileUrl || '#';
    TF.$('trackStatus').value = order.status;
    TF.$('trackMethod').value = order.fulfillment_method || 'unselected';
    TF.$('trackNumber').value = order.tracking_number || '';
    TF.$('trackShippedDate').value = order.shipped_at ? String(order.shipped_at).slice(0, 10) : '';
    TF.$('trackDeliveredDate').value = order.delivered_at ? String(order.delivered_at).slice(0, 10) : '';
    TF.$('trackCourierCost').value = order.courier_cost_finalized ? TF.num(order.actual_courier_cost).toFixed(2) : '';
    TF.$('trackCustomerNote').value = order.customer_update_note || '';
    TF.$('trackStatusNote').value = '';
    updatePreview();
    TF.$('trackingDialog').showModal();
  }

  function updatePreview() {
    if (!active) return;
    const draft = { ...active, fulfillment_method: TF.$('trackMethod').value };
    TF.$('trackingMessage').textContent = message(draft, TF.$('trackStatus').value, TF.$('trackNumber').value.trim());
  }

  async function save(event) {
    event.preventDefault();
    const button = event.submitter;
    TF.setLoading(button, true, 'Saving…');
    try {
      const result = await TF.state.supa.rpc('update_order_operations_v14', {
        p_order_id: active.id,
        p_status: TF.$('trackStatus').value,
        p_fulfillment_method: TF.$('trackMethod').value,
        p_tracking_number: TF.$('trackNumber').value,
        p_actual_courier_cost: TF.$('trackCourierCost').value.trim() === '' ? null : TF.num(TF.$('trackCourierCost').value),
        p_shipped_date: TF.$('trackShippedDate').value || null,
        p_delivered_date: TF.$('trackDeliveredDate').value || null,
        p_customer_update_note: TF.$('trackCustomerNote').value,
        p_status_note: TF.$('trackStatusNote').value
      });
      if (result.error) throw result.error;
      TF.toast('Tracking update saved');
      TF.$('trackingDialog').close();
      await load();
    } catch (error) {
      TF.fail(error, 'Tracking update failed');
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
    if (copy) await TF.copyText(order.tracking_number, 'Tracking number copied');
  }

  async function load() {
    const result = await TF.state.supa.from('v_daily_ops_orders_v15').select('*').order('last_activity_at', { ascending: false }).limit(5000);
    if (result.error) throw result.error;
    orders = result.data || [];
    TF.$('trackingMissing').textContent = orders.filter((order) => order.missing_tracking).length;
    TF.$('trackingReady').textContent = orders.filter((order) => order.status === 'ready_to_ship').length;
    TF.$('trackingShipped').textContent = orders.filter((order) => order.status === 'shipped').length;
    TF.$('trackingWaiting').textContent = orders.filter((order) => order.status === 'waiting_stock').length;
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
    ['trackStatus', 'trackMethod', 'trackNumber'].forEach((id) => TF.$(id).addEventListener('input', updatePreview));
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
