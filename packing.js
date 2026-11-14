(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let packingOwners = new Map();

  function isPaid(order) {
    return ['paid', 'overpaid'].includes(String(order.payment_status || '').toLowerCase()) && TF.num(order.pending_payment_count) <= 0;
  }

  function hasFulfillment(order) {
    return ['jnt', 'lalamove', 'walk_in'].includes(String(order.fulfillment_method || '').toLowerCase());
  }

  function fulfillmentText(order) {
    if (order.fulfillment_method === 'jnt') return 'J&T';
    if (order.fulfillment_method === 'lalamove') return 'Lalamove';
    if (order.fulfillment_method === 'walk_in') return 'Walk-in / Pickup';
    return 'Not selected';
  }

  function queueStage(order) {
    return order.status === 'packing' ? 'packing' : 'needs';
  }

  function ageBase(order) {
    if (order.status === 'packing') return TF.isoDate(order.last_status_at || order.updated_at || order.order_date);
    return TF.isoDate(order.latest_payment_date || order.order_date);
  }

  function ageDays(order) {
    return TF.daysBetween(ageBase(order));
  }

  function isOverdue(order) {
    const days = ageDays(order);
    if (order.status === 'packing') return days >= 1;
    return days >= 2;
  }

  function ageLabel(order) {
    const days = ageDays(order);
    if (order.status === 'packing') {
      if (days === 0) return 'Started today';
      if (days === 1) return 'Packing 1 day';
      return `Packing ${days} days`;
    }
    if (days === 0) return 'Ready today';
    if (days === 1) return 'Waiting 1 day';
    return `Waiting ${days} days`;
  }

  function ageTone(order) {
    if (isOverdue(order)) return 'overdue';
    if (ageDays(order) >= 1) return 'waiting';
    return 'today';
  }

  function filteredRows() {
    const search = TF.$('packingSearch').value.trim().toLowerCase();
    const stage = TF.$('packingStage').value;
    const fulfillment = TF.$('packingFulfillment').value;
    const sort = TF.$('packingSort').value;
    const rows = orders.filter((order) => {
      if (stage !== 'all' && queueStage(order) !== stage) return false;
      if (fulfillment !== 'all' && String(order.fulfillment_method || 'unselected') !== fulfillment) return false;
      if (search && ![order.order_number, order.customer_name, order.phone, order.facebook_profile].some((value) => String(value || '').toLowerCase().includes(search))) return false;
      return true;
    });
    rows.sort((a, b) => {
      const av = ageBase(a) || '';
      const bv = ageBase(b) || '';
      if (sort === 'newest') return bv.localeCompare(av) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
      return av.localeCompare(bv) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    return rows;
  }

  function renderCounts() {
    const needs = orders.filter((order) => queueStage(order) === 'needs').length;
    const active = orders.filter((order) => queueStage(order) === 'packing').length;
    const overdue = orders.filter(isOverdue).length;
    TF.$('packingNeedsCount').textContent = needs.toLocaleString();
    TF.$('packingActiveCount').textContent = active.toLocaleString();
    TF.$('packingOverdueCount').textContent = overdue.toLocaleString();
  }

  function actionHtml(order) {
    if (order.status === 'packing') {
      const owner = packingOwners.get(order.id);
      return `<div class="packing-action-stack">${owner ? `<span class="packing-owner">Packing by ${TF.esc(owner.name)}</span>` : ''}<button class="btn primary small" data-packing-action="packed" data-id="${order.id}">Mark Packed</button><a class="btn small" href="./orderpage.html?open=${encodeURIComponent(order.id)}">View</a></div>`;
    }
    if (!hasFulfillment(order)) {
      return `<div class="packing-action-stack"><a class="btn primary small" href="./orderpage.html?open=${encodeURIComponent(order.id)}">Set Fulfillment</a><span class="muted">Required before packing starts</span></div>`;
    }
    return `<div class="packing-action-stack"><button class="btn primary small" data-packing-action="start" data-id="${order.id}">Start Packing</button><a class="btn small" href="./orderpage.html?open=${encodeURIComponent(order.id)}">View</a></div>`;
  }

  function render() {
    renderCounts();
    const rows = filteredRows();
    TF.$('packingResultCount').textContent = `${rows.length.toLocaleString()} order${rows.length === 1 ? '' : 's'} in this view.`;
    TF.$('packingTable').innerHTML = `<table class="packing-table"><thead><tr><th>Order</th><th>Customer</th><th>Fulfillment</th><th>Pieces</th><th>Stage</th><th>Age</th><th>Action</th></tr></thead><tbody>${rows.map((order) => {
      const stage = queueStage(order);
      const owner = packingOwners.get(order.id);
      return `<tr class="${isOverdue(order) ? 'packing-row-overdue' : ''}">
        <td data-label="Order"><strong>${TF.esc(order.order_number)}</strong><small>Order date: ${TF.formatDate(order.order_date)}</small></td>
        <td data-label="Customer"><strong>${TF.esc(order.customer_name || '—')}</strong><small>${TF.esc(order.phone || '')}</small></td>
        <td data-label="Fulfillment">${TF.esc(fulfillmentText(order))}</td>
        <td data-label="Pieces"><strong>${TF.num(order.total_quantity).toLocaleString()}</strong></td>
        <td data-label="Stage"><span class="packing-stage ${stage === 'packing' ? 'active' : 'needs'}">${stage === 'packing' ? 'PACKING' : 'NEEDS PACKING'}</span>${owner && stage === 'packing' ? `<small>${TF.esc(owner.name)}</small>` : ''}</td>
        <td data-label="Age"><span class="packing-age ${ageTone(order)}">${TF.esc(ageLabel(order))}</span><small>${TF.formatDate(ageBase(order))}</small></td>
        <td data-label="Action">${actionHtml(order)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty ok-empty">Packing queue is clear.</td></tr>'}</tbody></table>`;
  }

  async function loadPackingOwners() {
    packingOwners = new Map();
    const ids = orders.filter((order) => order.status === 'packing').map((order) => order.id);
    for (let i = 0; i < ids.length; i += 100) {
      const result = await TF.state.supa
        .from('v_order_activity_v14')
        .select('order_id,new_status,created_at,full_name,email')
        .in('order_id', ids.slice(i, i + 100))
        .eq('new_status', 'packing')
        .order('created_at', { ascending: false });
      if (result.error) {
        console.warn('Could not load packing staff names:', result.error);
        return;
      }
      (result.data || []).forEach((row) => {
        if (!packingOwners.has(row.order_id)) packingOwners.set(row.order_id, {
          name: row.full_name || row.email || 'Staff',
          at: row.created_at
        });
      });
    }
  }

  async function updateStatus(order, status, note) {
    const result = await TF.state.supa.rpc('update_order_operations_v14', {
      p_order_id: order.id,
      p_status: status,
      p_fulfillment_method: order.fulfillment_method,
      p_tracking_number: order.fulfillment_method === 'jnt' ? (order.tracking_number || '') : '',
      p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
      p_shipped_date: null,
      p_delivered_date: null,
      p_customer_update_note: order.customer_update_note || '',
      p_status_note: note
    });
    if (result.error) throw result.error;
  }

  async function startPacking(order, button) {
    if (!isPaid(order)) throw new Error('Payment must be fully verified before packing starts.');
    if (TF.num(order.shortage_quantity) > 0) throw new Error('This order is still short on stock.');
    if (!hasFulfillment(order)) throw new Error('Set the fulfillment method first.');
    TF.setLoading(button, true, 'Starting…');
    try {
      const name = TF.state.profile?.full_name || TF.state.profile?.email || 'Staff';
      await updateStatus(order, 'packing', `Packing started by ${name}`);
      TF.toast(`${order.order_number} is now being packed`);
      await load();
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function markPacked(order, button) {
    if (order.status !== 'packing') throw new Error('Refresh first. This order is no longer in Packing.');
    if (!confirm(`Mark ${order.order_number} as fully packed and Ready to Ship?`)) return;
    TF.setLoading(button, true, 'Saving…');
    try {
      const name = TF.state.profile?.full_name || TF.state.profile?.email || 'Staff';
      await updateStatus(order, 'ready_to_ship', `Packing completed by ${name}; ready to ship`);
      TF.toast(`${order.order_number} is Ready to Ship`);
      await load();
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function handleAction(event) {
    const button = event.target.closest('[data-packing-action]');
    if (!button) return;
    const order = orders.find((row) => row.id === button.dataset.id);
    if (!order) return;
    try {
      if (button.dataset.packingAction === 'start') await startPacking(order, button);
      if (button.dataset.packingAction === 'packed') await markPacked(order, button);
    } catch (error) {
      TF.fail(error, 'Packing update failed');
    }
  }

  async function fetchAllQueueRows() {
    const all = [];
    const pageSize = 1000;
    for (let from = 0; from < 50000; from += pageSize) {
      const result = await TF.state.supa
        .from('v_daily_ops_orders_v16')
        .select('*')
        .in('status', ['confirmed', 'ready_to_pack', 'packing'])
        .order('order_date', { ascending: true })
        .range(from, from + pageSize - 1);
      if (result.error) throw result.error;
      const page = result.data || [];
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  }

  async function load() {
    const rows = await fetchAllQueueRows();
    orders = rows.filter((order) =>
      order.status === 'packing' ||
      (['confirmed', 'ready_to_pack'].includes(order.status) && isPaid(order) && TF.num(order.shortage_quantity) <= 0)
    );
    await loadPackingOwners();
    render();
  }

  TF.ready.then(async () => {
    ['packingSearch'].forEach((id) => TF.$(id).addEventListener('input', render));
    ['packingStage', 'packingFulfillment', 'packingSort'].forEach((id) => TF.$(id).addEventListener('change', render));
    TF.$('packingClear').addEventListener('click', () => {
      TF.$('packingSearch').value = '';
      TF.$('packingStage').value = 'all';
      TF.$('packingFulfillment').value = 'all';
      TF.$('packingSort').value = 'oldest';
      render();
    });
    TF.$('packingTable').addEventListener('click', handleAction);
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Packing Queue failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Packing Queue failed'));
})();
