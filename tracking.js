(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];

  function filtered() {
    const query = String(TF.$('trackingSearch')?.value || '').trim().toLowerCase();
    if (!query) return orders;
    return orders.filter((order) => [
      order.order_number,
      order.customer_name,
      order.tracking_number
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }

  function render() {
    const table = TF.$('trackingTable');
    if (!table) return;
    const rows = filtered();

    table.innerHTML = `
      <table class="tracking-clean-table">
        <thead>
          <tr>
            <th>Order Number</th>
            <th>Customer Name</th>
            <th>J&amp;T Tracking Number</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((order) => `
            <tr>
              <td><strong class="order-number-text">${TF.esc(order.order_number || '—')}</strong></td>
              <td><strong>${TF.esc(order.customer_name || '—')}</strong></td>
              <td>${order.tracking_number
                ? `<code>${TF.esc(order.tracking_number)}</code>`
                : '<span class="muted">No tracking recorded yet</span>'}
              </td>
            </tr>
          `).join('') || '<tr><td colspan="3" class="empty">No J&amp;T tracking records found.</td></tr>'}
        </tbody>
      </table>`;
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
    TF.$('trackingSearch')?.addEventListener('input', render);
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Tracking failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Tracking failed'));
})();
