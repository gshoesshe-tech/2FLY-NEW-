(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];

  function facebookHref(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(facebook\.com|www\.facebook\.com|m\.facebook\.com|messenger\.com|m\.me)\//i.test(raw)) return `https://${raw}`;
    if (/^[A-Za-z0-9._-]+$/.test(raw)) return `https://facebook.com/${raw}`;
    return `https://www.facebook.com/search/top?q=${encodeURIComponent(raw)}`;
  }

  function orderTasks(order) {
    const tasks = [];
    if (['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status)) tasks.push('payment');
    if (['confirmed', 'ready_to_pack'].includes(order.status)) tasks.push('needs_packing');
    if (order.status === 'packing') tasks.push('packing');
    if (order.status === 'waiting_stock') tasks.push('waiting_stock');
    if (order.status === 'ready_to_ship') tasks.push('ready_to_ship');
    if (order.missing_tracking) tasks.push('missing_tracking');
    if (order.paid_not_shipped_alert) tasks.push('overdue');
    if (order.status === 'waiting_stock' || order.missing_tracking || order.paid_not_shipped_alert) tasks.push('customer_update');
    return [...new Set(tasks)];
  }

  function taskTeam(task) {
    if (['payment', 'waiting_stock', 'customer_update'].includes(task)) return 'customer_service';
    if (['needs_packing', 'packing'].includes(task)) return 'packing';
    if (['ready_to_ship', 'missing_tracking'].includes(task)) return 'shipping';
    return 'owner';
  }

  function primaryTask(order) {
    const tasks = orderTasks(order);
    const priority = ['missing_tracking', 'waiting_stock', 'overdue', 'ready_to_ship', 'packing', 'needs_packing', 'payment', 'customer_update'];
    return priority.find((task) => tasks.includes(task)) || '';
  }

  function taskLabel(task, order) {
    const labels = {
      payment: 'Confirm Payment',
      needs_packing: 'Start Packing',
      packing: 'Finish Packing',
      waiting_stock: TF.num(order.shortage_quantity) > 0 ? `Waiting for Stock • ${TF.num(order.shortage_quantity)} short` : 'Stock Available Now',
      ready_to_ship: 'Add Tracking / Ship',
      missing_tracking: 'Add Missing Tracking',
      overdue: 'Paid Too Long — Follow Up',
      customer_update: 'Customer Update Needed'
    };
    return labels[task] || TF.statusLabel(order.status);
  }

  function taskTone(task) {
    if (['missing_tracking', 'overdue'].includes(task)) return 'danger';
    if (['waiting_stock', 'payment'].includes(task)) return 'warn';
    if (['ready_to_ship', 'needs_packing', 'packing'].includes(task)) return 'info';
    return '';
  }

  function relevantDate(order) {
    const basis = TF.$('todoDateBasis').value;
    if (basis === 'payment') return order.latest_payment_date;
    if (basis === 'status') return order.last_status_at || order.updated_at;
    return order.order_date;
  }

  function range() {
    const preset = TF.$('todoPreset').value;
    if (preset === 'custom') return { start: TF.$('todoStart').value, end: TF.$('todoEnd').value };
    return TF.presetRange(preset);
  }

  function ageText(order, task) {
    let base = order.order_date;
    let prefix = 'Ordered';
    if (['needs_packing', 'overdue'].includes(task) && order.latest_payment_date) { base = order.latest_payment_date; prefix = 'Paid'; }
    if (['packing', 'waiting_stock', 'ready_to_ship', 'missing_tracking'].includes(task)) { base = TF.isoDate(order.last_status_at || order.updated_at); prefix = 'Waiting'; }
    const days = TF.daysBetween(base);
    if (!base) return 'No date';
    if (days === 0) return `${prefix} today`;
    if (days === 1) return `${prefix} 1 day ago`;
    return `${prefix} ${days} days ago`;
  }

  function customerUpdate(order) {
    const tracking = order.tracking_number ? `\nTracking number: ${order.tracking_number}` : '';
    if (order.status === 'waiting_stock') return `Hi! Confirmed na po ang payment for ${order.order_number}. Waiting lang po tayo sa requested stock/design. We’ll update you once ready for packing.`;
    if (['confirmed', 'ready_to_pack'].includes(order.status)) return `Hi! Confirmed na po ang payment for ${order.order_number}. Naka-queue na po ito for packing.`;
    if (order.status === 'packing') return `Hi! Currently being packed na po ang order ${order.order_number}. We’ll send the tracking number once available.`;
    if (order.status === 'ready_to_ship') return `Hi! Ready to ship na po ang order ${order.order_number}. Waiting na lang po sa courier handoff and tracking number.`;
    if (order.status === 'shipped') return `Hi! Shipped na po ang order ${order.order_number}.${tracking}\nThank you!`;
    return `Hi! Update for order ${order.order_number}: ${TF.statusLabel(order.status)}.`;
  }

  function filteredRows() {
    const taskFilter = TF.$('todoTaskFilter').value;
    const teamFilter = TF.$('todoTeamFilter').value;
    const query = TF.$('todoSearch').value.trim().toLowerCase();
    const { start, end } = range();
    const rows = orders.filter((order) => {
      const tasks = orderTasks(order);
      if (!tasks.length) return false;
      if (taskFilter !== 'all' && !tasks.includes(taskFilter)) return false;
      if (teamFilter !== 'all' && !tasks.some((task) => taskTeam(task) === teamFilter)) return false;
      if ((start || end) && !TF.dateInRange(relevantDate(order), start, end)) return false;
      if (query && ![order.order_number, order.customer_name, order.phone, order.facebook_profile, order.tracking_number].some((value) => String(value || '').toLowerCase().includes(query))) return false;
      return true;
    });
    const sort = TF.$('todoSort').value;
    const priorityIndex = { missing_tracking: 0, waiting_stock: 1, overdue: 2, ready_to_ship: 3, packing: 4, needs_packing: 5, payment: 6, customer_update: 7 };
    rows.sort((a, b) => {
      if (sort === 'oldest') return String(relevantDate(a) || '').localeCompare(String(relevantDate(b) || ''));
      if (sort === 'newest') return String(relevantDate(b) || '').localeCompare(String(relevantDate(a) || ''));
      const difference = (priorityIndex[primaryTask(a)] ?? 99) - (priorityIndex[primaryTask(b)] ?? 99);
      return difference || String(relevantDate(a) || '').localeCompare(String(relevantDate(b) || ''));
    });
    return rows;
  }

  function renderCounts() {
    const count = (task) => orders.filter((order) => orderTasks(order).includes(task)).length;
    TF.$('todoPaymentCount').textContent = count('payment');
    TF.$('todoPackingCount').textContent = count('needs_packing') + count('packing');
    TF.$('todoStockCount').textContent = count('waiting_stock');
    TF.$('todoReadyCount').textContent = count('ready_to_ship');
    TF.$('todoTrackingCount').textContent = count('missing_tracking');
    TF.$('todoOverdueCount').textContent = count('overdue');
  }

  function actionButtons(order) {
    const task = primaryTask(order);
    const buttons = [`<a class="btn small" href="./orderpage.html?open=${order.id}">Open</a>`];
    if (order.facebook_profile) buttons.push(`<a class="btn small" target="_blank" rel="noopener" href="${TF.esc(facebookHref(order.facebook_profile))}">Facebook</a>`);
    if (task === 'payment' && TF.can('confirm_payments')) buttons.push(`<a class="btn primary small" href="./orderpage.html?open=${order.id}&focus=payment">Confirm Payment</a>`);
    if ((task === 'needs_packing' || (task === 'waiting_stock' && TF.num(order.shortage_quantity) === 0)) && TF.can('update_tracking')) buttons.push(`<button class="btn primary small" data-action="packing" data-id="${order.id}">Start Packing</button>`);
    if (task === 'packing' && TF.can('update_tracking')) buttons.push(`<button class="btn primary small" data-action="ready" data-id="${order.id}">Ready to Ship</button>`);
    if (['ready_to_ship', 'missing_tracking'].includes(task) && TF.can('update_tracking')) buttons.push(`<a class="btn primary small" href="./orderpage.html?open=${order.id}&focus=tracking">${task === 'missing_tracking' ? 'Add Tracking' : 'Tracking / Ship'}</a>`);
    if (task === 'ready_to_ship' && order.tracking_number && order.fulfillment_method !== 'unselected' && TF.can('update_tracking')) buttons.push(`<button class="btn small" data-action="shipped" data-id="${order.id}">Mark Shipped</button>`);
    if (orderTasks(order).includes('customer_update')) buttons.push(`<button class="btn small" data-action="copyUpdate" data-id="${order.id}">Copy Update</button>`);
    return buttons.join('');
  }

  function render() {
    renderCounts();
    const rows = filteredRows();
    TF.$('todoResultCount').textContent = `${rows.length.toLocaleString()} order${rows.length === 1 ? '' : 's'} need attention.`;
    TF.$('todoTable').innerHTML = `<table><thead><tr><th>Priority</th><th>Order</th><th>Customer</th><th>Pieces</th><th>Payment</th><th>Age</th><th>Actions</th></tr></thead><tbody>${rows.map((order) => {
      const task = primaryTask(order);
      return `<tr class="${['missing_tracking', 'overdue'].includes(task) ? 'attention-row' : ''}"><td><span class="pill ${taskTone(task)}">${TF.esc(taskLabel(task, order))}</span></td><td><strong>${TF.esc(order.order_number)}</strong><br><small>${TF.formatDate(order.order_date)}</small></td><td>${TF.esc(order.customer_name)}<br><small>${TF.esc(order.phone || '')}</small></td><td>${TF.num(order.total_quantity).toLocaleString()}</td><td>${TF.statusPill(order.payment_status)}<br><small>${TF.esc(order.latest_payment_account_name || '—')}</small></td><td><strong>${TF.esc(ageText(order, task))}</strong><br><small>${TF.formatDateTime(order.last_activity_at)}</small></td><td><div class="row-actions">${actionButtons(order)}</div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty ok-empty">No tasks match the selected filters.</td></tr>'}</tbody></table>`;
  }

  async function updateStatus(order, status) {
    const result = await TF.state.supa.rpc('update_order_operations_v14', {
      p_order_id: order.id,
      p_status: status,
      p_fulfillment_method: order.fulfillment_method,
      p_tracking_number: order.tracking_number,
      p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
      p_shipped_date: status === 'shipped' ? TF.today() : null,
      p_delivered_date: null,
      p_customer_update_note: order.customer_update_note,
      p_status_note: `Updated from To Do page: ${TF.statusLabel(status)}`
    });
    if (result.error) throw result.error;
    TF.toast(`Order marked ${TF.statusLabel(status)}`);
    await load();
  }

  async function tableAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const order = orders.find((row) => row.id === button.dataset.id);
    if (!order) return;
    try {
      if (button.dataset.action === 'packing') await updateStatus(order, 'packing');
      if (button.dataset.action === 'ready') await updateStatus(order, 'ready_to_ship');
      if (button.dataset.action === 'shipped') await updateStatus(order, 'shipped');
      if (button.dataset.action === 'copyUpdate') await TF.copyText(customerUpdate(order), 'Customer update copied');
    } catch (error) {
      TF.fail(error, 'To Do action failed');
    }
  }

  function updateCustomUi() {
    const custom = TF.$('todoPreset').value === 'custom';
    TF.$('todoStartWrap').classList.toggle('hidden', !custom);
    TF.$('todoEndWrap').classList.toggle('hidden', !custom);
  }

  async function load() {
    const result = await TF.state.supa.from('v_daily_ops_orders_v15').select('*').order('order_date', { ascending: true }).limit(10000);
    if (result.error) throw result.error;
    orders = result.data || [];
    render();
  }

  TF.ready.then(async () => {
    updateCustomUi();
    ['todoTaskFilter', 'todoTeamFilter', 'todoDateBasis', 'todoSort', 'todoStart', 'todoEnd'].forEach((id) => TF.$(id).addEventListener('change', render));
    TF.$('todoPreset').addEventListener('change', () => { updateCustomUi(); render(); });
    TF.$('todoSearch').addEventListener('input', render);
    TF.$('todoTable').addEventListener('click', tableAction);
    TF.$$('button[data-task-card]').forEach((button) => button.addEventListener('click', () => { TF.$('todoTaskFilter').value = button.dataset.taskCard; render(); }));
    TF.$('clearTodoFilters').addEventListener('click', () => {
      TF.$('todoTaskFilter').value = 'all';
      TF.$('todoTeamFilter').value = 'all';
      TF.$('todoDateBasis').value = 'order';
      TF.$('todoPreset').value = 'all';
      TF.$('todoStart').value = '';
      TF.$('todoEnd').value = '';
      TF.$('todoSearch').value = '';
      TF.$('todoSort').value = 'priority';
      updateCustomUi();
      render();
    });
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'To Do failed')));
    await load();
  }).catch((error) => TF.fail(error, 'To Do failed'));
})();
