(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];

  function filtered() {
    const query = TF.$('trackingSearch').value.trim().toLowerCase();
    if (!query) return orders;
    return orders.filter((order) => [
      order.order_number,
      order.customer_name,
      order.tracking_number
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }

  function render() {
    const rows = filtered();
    TF.$('trackingTable').innerHTML = `
      <table class="tracking-clean-table">
        <thead>
          <tr>
            <th>Order Number</th>
            <th>Name</th>
            <th>J&amp;T Tracking Number</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((order) => `
            <tr>
              <td><strong class="order-number-text">${TF.esc(order.order_number || '')}</strong></td>
              <td><strong>${TF.esc(order.customer_name || '')}</strong></td>
              <td>
                <div class="row-actions" style="flex-wrap:nowrap;align-items:center">
                  <input data-tracking-input="${TF.esc(order.id)}" value="${TF.esc(order.tracking_number || '')}" placeholder="Enter J&T tracking number" style="min-width:260px">
                  <button class="btn primary small" data-save-tracking="${TF.esc(order.id)}">Save</button>
                  ${order.tracking_number ? `<button class="btn small" data-copy-tracking="${TF.esc(order.id)}">Copy</button>` : ''}
                </div>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="3" class="empty">No J&amp;T orders found.</td></tr>'}
        </tbody>
      </table>`;
  }

  async function saveTracking(order, button) {
    const input = TF.$('trackingTable').querySelector(`[data-tracking-input="${order.id}"]`);
    const trackingNumber = String(input?.value || '').trim();
    TF.setLoading(button, true, 'Saving…');
    try {
      const result = await TF.state.supa.rpc('update_order_operations_v14', {
        p_order_id: order.id,
        p_fulfillment_method: 'jnt',
        p_tracking_number: trackingNumber,
        p_status: order.status,
        p_shipped_date: order.shipped_at ? String(order.shipped_at).slice(0, 10) : null,
        p_delivered_date: order.delivered_at ? String(order.delivered_at).slice(0, 10) : null,
        p_actual_courier_cost: order.courier_cost_finalized ? TF.num(order.actual_courier_cost) : null,
        p_customer_update_note: order.customer_update_note || '',
        p_status_note: 'J&T tracking number updated'
      });
      if (result.error) throw result.error;
      TF.toast('Tracking number saved');
      await load();
    } catch (error) {
      TF.fail(error, 'Tracking update failed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function action(event) {
    const saveButton = event.target.closest('[data-save-tracking]');
    const copyButton = event.target.closest('[data-copy-tracking]');
    const id = saveButton?.dataset.saveTracking || copyButton?.dataset.copyTracking;
    if (!id) return;
    const order = orders.find((row) => String(row.id) === String(id));
    if (!order) return;
    if (saveButton) await saveTracking(order, saveButton);
    if (copyButton) await TF.copyText(order.tracking_number || '', 'Tracking number copied');
  }

  async function load() {
    const result = await TF.state.supa
      .from('v_daily_ops_orders_v16')
      .select('*')
      .eq('fulfillment_method', 'jnt')
      .order('last_activity_at', { ascending: false })
      .limit(5000);
    if (result.error) throw result.error;
    orders = result.data || [];
    render();
  }

  TF.ready.then(async () => {
    TF.$('trackingSearch').addEventListener('input', render);
    TF.$('trackingTable').addEventListener('click', (event) => {
      action(event).catch((error) => TF.fail(error, 'Tracking action failed'));
    });
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Tracking failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Tracking failed'));
})();
