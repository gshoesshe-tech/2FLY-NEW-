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

  function isJnt(order) {
    return String(order?.fulfillment_method || '').toLowerCase() === 'jnt';
  }

  function hasFulfillment(order) {
    return ['jnt', 'lalamove', 'walk_in'].includes(String(order?.fulfillment_method || '').toLowerCase());
  }

  function fulfillmentText(order) {
    if (order.fulfillment_method === 'jnt') return 'J&T';
    if (order.fulfillment_method === 'lalamove') return 'Lalamove';
    if (order.fulfillment_method === 'walk_in') return 'Walk-in / Pickup';
    return 'Not selected';
  }

  function simpleStatus(order) {
    if (order?.status === 'delivered') return 'delivered';
    if (['packing', 'ready_to_ship', 'shipped'].includes(order?.status)) return 'processing';
    return 'pending';
  }

  function simpleStatusPill(order) {
    const value = simpleStatus(order);
    const label = value === 'delivered' ? 'Delivered' : value === 'processing' ? 'Processing' : 'Pending';
    const tone = value === 'delivered' ? 'ok' : value === 'processing' ? 'info' : 'warn';
    return `<span class="pill simple-order-status ${tone}">${label}</span>`;
  }

  function fulfillmentBadge(order) {
    const method = order?.fulfillment_method;
    const css = method === 'jnt' ? 'jnt' : method === 'lalamove' ? 'lalamove' : method === 'walk_in' ? 'walkin' : 'unselected';
    return `<span class="fulfillment-badge ${css}">${TF.esc(fulfillmentText(order))}</span>`;
  }

  function needsTracking(order) {
    return isJnt(order) && ['ready_to_ship', 'shipped'].includes(order.status) && !String(order.tracking_number || '').trim();
  }

  function orderTasks(order) {
    const tasks = [];
    if (TF.num(order.pending_payment_count) > 0 && !['cancelled', 'refunded'].includes(order.status)) tasks.push('verification');
    else if (['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status)) tasks.push('payment');
    if (['confirmed', 'ready_to_pack'].includes(order.status)) tasks.push('needs_packing');
    if (order.status === 'packing') tasks.push('packing');
    if (order.status === 'waiting_stock') tasks.push('waiting_stock');
    if (order.status === 'ready_to_ship') tasks.push('ready_to_ship');
    if (needsTracking(order)) tasks.push('missing_tracking');
    if (order.paid_not_shipped_alert) tasks.push('overdue');
    if (order.status === 'waiting_stock' || needsTracking(order) || order.paid_not_shipped_alert) tasks.push('customer_update');
    return [...new Set(tasks)];
  }

  function taskTeam(task) {
    if (['payment', 'waiting_stock', 'customer_update'].includes(task)) return 'customer_service';
    if (task === 'verification') return 'owner';
    if (['needs_packing', 'packing'].includes(task)) return 'packing';
    if (['ready_to_ship', 'missing_tracking'].includes(task)) return 'shipping';
    return 'owner';
  }

  function primaryTask(order) {
    const tasks = orderTasks(order);
    const priority = ['verification', 'missing_tracking', 'waiting_stock', 'overdue', 'ready_to_ship', 'packing', 'needs_packing', 'payment', 'customer_update'];
    return priority.find((task) => tasks.includes(task)) || '';
  }

  function taskLabel(task, order) {
    const labels = {
      verification: `Verify Payment • ${TF.money(order.pending_payment_amount)}`,
      payment: 'Payment Not Submitted',
      needs_packing: 'Start Packing',
      packing: 'Finish Packing',
      waiting_stock: TF.num(order.shortage_quantity) > 0 ? `Waiting for Stock • ${TF.num(order.shortage_quantity)} short` : 'Stock Available Now',
      ready_to_ship: isJnt(order) && !order.tracking_number ? 'Add J&T Tracking' : 'Ready to Ship',
      missing_tracking: 'Add Missing J&T Tracking',
      overdue: 'Paid Too Long — Follow Up',
      customer_update: 'Customer Update Needed'
    };
    return labels[task] || TF.statusLabel(order.status);
  }

  function taskTone(task) {
    if (['missing_tracking', 'overdue'].includes(task)) return 'danger';
    if (['waiting_stock', 'payment', 'verification'].includes(task)) return 'warn';
    if (['ready_to_ship', 'needs_packing', 'packing'].includes(task)) return 'info';
    return '';
  }

  function relevantDate(order) {
    const basis = TF.$('todoDateBasis').value;
    if (basis === 'payment') return order.latest_submission_at || order.latest_payment_date;
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
    if (task === 'verification' && order.latest_submission_at) { base = TF.isoDate(order.latest_submission_at); prefix = 'Submitted'; }
    if (['needs_packing', 'overdue'].includes(task) && order.latest_payment_date) { base = order.latest_payment_date; prefix = 'Paid'; }
    if (['packing', 'waiting_stock', 'ready_to_ship', 'missing_tracking'].includes(task)) { base = TF.isoDate(order.last_status_at || order.updated_at); prefix = 'Waiting'; }
    const days = TF.daysBetween(base);
    if (!base) return 'No date';
    if (days === 0) return `${prefix} today`;
    if (days === 1) return `${prefix} 1 day ago`;
    return `${prefix} ${days} days ago`;
  }

  function customerUpdate(order) {
    const jnt = isJnt(order);
    const tracking = jnt && order.tracking_number ? `
Tracking number: ${order.tracking_number}` : '';
    const method = fulfillmentText(order);
    if (TF.num(order.pending_payment_count) > 0) return `Hi! Nareceive na po namin ang payment details for ${order.order_number}. For verification pa po ito sa selected GCash account. We’ll update you once confirmed.`;
    if (order.status === 'waiting_stock') return `Hi! Confirmed na po ang payment for ${order.order_number}. Waiting lang po tayo sa requested stock/design. We’ll update you once ready for packing.`;
    if (['confirmed', 'ready_to_pack'].includes(order.status)) return `Hi! Confirmed na po ang payment for ${order.order_number}. Naka-queue na po ito for packing.`;
    if (order.status === 'packing') return jnt ? `Hi! Currently being packed na po ang order ${order.order_number}. We’ll send the J&T tracking number once available.` : `Hi! Currently being prepared na po ang order ${order.order_number} for ${method}. We’ll update you once released.`;
    if (order.status === 'ready_to_ship') return jnt ? `Hi! Ready to ship na po ang order ${order.order_number}. Waiting na lang po sa J&T handoff and tracking number.` : `Hi! Ready na po ang order ${order.order_number} for ${method}. We’ll update you once released.`;
    if (order.status === 'shipped') return jnt ? `Hi! Shipped na po ang order ${order.order_number}.${tracking}
Thank you!` : `Hi! Released na po ang order ${order.order_number} through ${method}. No tracking number is needed. Thank you!`;
    return `Hi! Update for order ${order.order_number}: ${TF.statusLabel(order.status)}.`;
  }

  function filteredRows() {
    const taskFilter = TF.$('todoTaskFilter').value;
    const teamFilter = TF.$('todoTeamFilter').value;
    const fulfillmentFilter = TF.$('todoFulfillmentFilter').value;
    const query = TF.$('todoSearch').value.trim().toLowerCase();
    const { start, end } = range();
    const rows = orders.filter((order) => {
      const tasks = orderTasks(order);
      if (!tasks.length) return false;
      if (taskFilter !== 'all' && !tasks.includes(taskFilter)) return false;
      if (teamFilter !== 'all' && !tasks.some((task) => taskTeam(task) === teamFilter)) return false;
      if (fulfillmentFilter !== 'all' && order.fulfillment_method !== fulfillmentFilter) return false;
      if ((start || end) && !TF.dateInRange(relevantDate(order), start, end)) return false;
      if (query && ![order.order_number, order.customer_name, order.phone, order.facebook_profile, order.tracking_number].some((value) => String(value || '').toLowerCase().includes(query))) return false;
      return true;
    });
    const sort = TF.$('todoSort').value;
    const priorityIndex = { verification: 0, missing_tracking: 1, waiting_stock: 2, overdue: 3, ready_to_ship: 4, packing: 5, needs_packing: 6, payment: 7, customer_update: 8 };
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
    TF.$('todoVerificationCount').textContent = count('verification');
    TF.$('todoPaymentCount').textContent = count('payment');
    TF.$('todoPackingCount').textContent = count('needs_packing') + count('packing');
    TF.$('todoStockCount').textContent = count('waiting_stock');
    TF.$('todoReadyCount').textContent = count('ready_to_ship');
    TF.$('todoTrackingCount').textContent = count('missing_tracking');
    TF.$('todoOverdueCount').textContent = count('overdue');
  }

  function actionButtons(order) {
    const task = primaryTask(order);
    const buttons = [`<a class="btn small" href="./orderpage.html?open=${order.id}">View</a>`];
    if (task === 'verification' && TF.can('confirm_payments')) buttons.unshift(`<a class="btn primary small" href="./orderpage.html?open=${order.id}&focus=payment">Review Payment</a>`);
    else if (task === 'payment' && (TF.can('create_orders') || TF.can('edit_orders'))) buttons.unshift(`<a class="btn primary small" href="./orderpage.html?open=${order.id}&focus=payment">Submit Payment</a>`);
    else if (simpleStatus(order) === 'pending' && !hasFulfillment(order)) buttons.unshift(`<a class="btn primary small" href="./orderpage.html?open=${order.id}">Set Fulfillment</a>`);
    else if (simpleStatus(order) === 'pending' && hasFulfillment(order) && ['paid', 'overpaid'].includes(order.payment_status) && TF.num(order.shortage_quantity) <= 0 && TF.can('update_tracking')) buttons.unshift(`<button class="btn primary small" data-action="processing" data-id="${order.id}">Start Processing</button>`);
    else if (simpleStatus(order) === 'processing' && TF.can('update_tracking')) {
      if (isJnt(order) && !order.tracking_number) buttons.unshift(`<a class="btn primary small" href="./orderpage.html?open=${order.id}&focus=tracking">Add J&T Tracking</a>`);
      else buttons.unshift(`<button class="btn primary small" data-action="complete" data-id="${order.id}">Mark Delivered</button>`);
    }
    if (order.facebook_profile) buttons.push(`<a class="btn small" target="_blank" rel="noopener" href="${TF.esc(facebookHref(order.facebook_profile))}">Facebook</a>`);
    return buttons.join('');
  }

  function render() {
    renderCounts();
    const rows = filteredRows();
    TF.$('todoResultCount').textContent = `${rows.length.toLocaleString()} order${rows.length === 1 ? '' : 's'} need attention.`;
    TF.$('todoTable').innerHTML = `<table class="todo-clean-table todo-fulfillment-table"><thead><tr><th>Task</th><th>Order</th><th>Customer</th><th>Fulfillment</th><th>Status</th><th>Payment</th><th>Age</th><th>Action</th></tr></thead><tbody>${rows.map((order) => {
      const task = primaryTask(order);
      return `<tr class="${['missing_tracking', 'overdue'].includes(task) ? 'attention-row' : ''}">
        <td data-label="Task"><span class="pill ${taskTone(task)}">${TF.esc(taskLabel(task, order))}</span></td>
        <td data-label="Order"><strong>${TF.esc(order.order_number)}</strong><small>${TF.formatDate(order.order_date)}</small></td>
        <td data-label="Customer"><strong>${TF.esc(order.customer_name)}</strong><small>${TF.esc(order.phone || '')}</small></td>
        <td data-label="Fulfillment">${fulfillmentBadge(order)}</td>
        <td data-label="Status">${simpleStatusPill(order)}</td>
        <td data-label="Payment">${TF.num(order.pending_payment_count) > 0 ? TF.statusPill('submitted') : TF.statusPill(order.payment_status)}<small>${TF.esc(order.latest_submission_account_name || order.latest_payment_account_name || '—')}</small></td>
        <td data-label="Age"><strong>${TF.esc(ageText(order, task))}</strong><small>${TF.formatDateTime(order.last_activity_at)}</small></td>
        <td data-label="Action"><div class="row-actions">${actionButtons(order)}</div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="empty ok-empty">No tasks match the selected filters.</td></tr>'}</tbody></table>`;
  }

  async function updateStatus(order, status) {
    if (status === 'shipped' && isJnt(order) && !order.tracking_number) { location.href = `./orderpage.html?open=${order.id}&focus=tracking`; return; }
    const result = await TF.state.supa.rpc('update_order_operations_v14', {
      p_order_id: order.id,
      p_status: status,
      p_fulfillment_method: order.fulfillment_method,
      p_tracking_number: isJnt(order) ? order.tracking_number : '',
      p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
      p_shipped_date: ['shipped', 'delivered'].includes(status) ? (order.shipped_at ? String(order.shipped_at).slice(0, 10) : TF.today()) : null,
      p_delivered_date: status === 'delivered' ? TF.today() : null,
      p_customer_update_note: order.customer_update_note,
      p_status_note: status === 'packing' ? 'Simple status: Processing' : status === 'delivered' ? 'Simple status: Delivered' : null
    });
    if (result.error) throw result.error;
    await load();
  }

  async function completeOrder(order) {
    if (isJnt(order) && !order.tracking_number) { location.href = `./orderpage.html?open=${order.id}&focus=tracking`; return; }
    if (!confirm(`Mark ${order.order_number} as delivered/completed?`)) return;
    if (order.status !== 'shipped') await updateStatus(order, 'shipped');
    order = orders.find((row) => row.id === order.id) || order;
    await updateStatus(order, 'delivered');
    TF.toast('Order marked Delivered');
  }

  async function tableAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const order = orders.find((row) => row.id === button.dataset.id);
    if (!order) return;
    try {
      if (button.dataset.action === 'processing') await updateStatus(order, 'packing');
      if (button.dataset.action === 'complete') await completeOrder(order);
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
    const result = await TF.state.supa.from('v_daily_ops_orders_v16').select('*').order('order_date', { ascending: true }).limit(10000);
    if (result.error) throw result.error;
    orders = result.data || [];
    render();
  }

  TF.ready.then(async () => {
    const queryTask = new URLSearchParams(location.search).get('task');
    if (queryTask && [...TF.$('todoTaskFilter').options].some((option) => option.value === queryTask)) TF.$('todoTaskFilter').value = queryTask;
    updateCustomUi();
    ['todoTaskFilter', 'todoTeamFilter', 'todoFulfillmentFilter', 'todoDateBasis', 'todoSort', 'todoStart', 'todoEnd'].forEach((id) => TF.$(id).addEventListener('change', render));
    TF.$('todoPreset').addEventListener('change', () => { updateCustomUi(); render(); });
    TF.$('todoSearch').addEventListener('input', render);
    TF.$('todoTable').addEventListener('click', tableAction);
    TF.$$('button[data-task-card]').forEach((button) => button.addEventListener('click', () => { TF.$('todoTaskFilter').value = button.dataset.taskCard; render(); }));
    TF.$('clearTodoFilters').addEventListener('click', () => {
      TF.$('todoTaskFilter').value = 'all';
      TF.$('todoTeamFilter').value = 'all';
      TF.$('todoFulfillmentFilter').value = 'all';
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
