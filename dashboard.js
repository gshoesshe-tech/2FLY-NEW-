(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let payments = [];
  let allocations = [];
  let items = [];

  function statusGroup(order) {
    if (['cancelled', 'refunded'].includes(order.status)) return 'cancelled';
    if (order.status === 'delivered') return 'delivered';
    if (order.status === 'shipped') return 'shipped';
    if (['draft', 'payment_review'].includes(order.status)) return 'pending';
    return 'processing';
  }

  function filteredByStatus(rows) {
    const value = TF.$('dashboardStatus').value;
    return value === 'all' ? rows : rows.filter((order) => statusGroup(order) === value);
  }

  function selectedRange() {
    const preset = TF.$('dashboardPreset').value;
    if (preset === 'custom') return { start: TF.$('dashboardStart').value, end: TF.$('dashboardEnd').value };
    return TF.presetRange(preset);
  }

  function orderDateForBasis(order, basis) {
    if (basis === 'order') return order.order_date;
    if (basis === 'shipped') return order.shipped_at;
    if (basis === 'delivered') return order.delivered_at;
    return '';
  }

  function buildSelection() {
    const basis = TF.$('dashboardDateBasis').value;
    const { start, end } = selectedRange();
    const verifiedPayments = payments.filter((payment) => payment.status === 'verified');
    const paymentIdsInRange = new Set(verifiedPayments.filter((payment) => TF.dateInRange(payment.payment_date, start, end)).map((payment) => payment.id));
    const orderIdsPaidInRange = new Set(verifiedPayments.filter((payment) => paymentIdsInRange.has(payment.id)).map((payment) => payment.order_id));

    let selectedOrders = basis === 'payment'
      ? orders.filter((order) => orderIdsPaidInRange.has(order.id))
      : orders.filter((order) => TF.dateInRange(orderDateForBasis(order, basis), start, end));
    selectedOrders = filteredByStatus(selectedOrders);
    const orderIds = new Set(selectedOrders.map((order) => order.id));

    const selectedPayments = basis === 'payment'
      ? verifiedPayments.filter((payment) => paymentIdsInRange.has(payment.id) && orderIds.has(payment.order_id))
      : verifiedPayments.filter((payment) => orderIds.has(payment.order_id));
    const selectedPaymentIds = new Set(selectedPayments.map((payment) => payment.id));
    const selectedAllocations = allocations.filter((allocation) => selectedPaymentIds.has(allocation.payment_id));
    const selectedItems = items.filter((item) => orderIds.has(item.order_id));

    return { basis, start, end, selectedOrders, selectedPayments, selectedAllocations, selectedItems };
  }

  function renderKpis(selection) {
    const cash = selection.selectedPayments.reduce((sum, payment) => sum + TF.num(payment.amount), 0);
    const product = selection.selectedAllocations.filter((row) => row.allocation_type === 'product').reduce((sum, row) => sum + TF.num(row.amount), 0);
    const shipping = selection.selectedAllocations.filter((row) => row.allocation_type === 'jnt_shipping').reduce((sum, row) => sum + TF.num(row.amount), 0);
    const pieces = selection.selectedOrders.reduce((sum, order) => sum + TF.num(order.total_quantity), 0);
    const count = selection.selectedOrders.length;
    TF.$('kpiCash').textContent = TF.money(cash);
    TF.$('kpiProductSales').textContent = TF.money(product);
    TF.$('kpiShipping').textContent = TF.money(shipping);
    TF.$('kpiOrders').textContent = count.toLocaleString();
    TF.$('kpiPieces').textContent = pieces.toLocaleString();
    TF.$('kpiAverage').textContent = TF.money(count ? cash / count : 0);
  }

  function groupDateForRecord(selection, order, payment) {
    if (selection.basis === 'payment') return payment?.payment_date || '';
    return TF.isoDate(orderDateForBasis(order, selection.basis));
  }

  function renderSalesByDay(selection) {
    const byDay = new Map();
    const orderMap = new Map(selection.selectedOrders.map((order) => [order.id, order]));
    const paymentMap = new Map(selection.selectedPayments.map((payment) => [payment.id, payment]));

    if (selection.basis === 'payment') {
      selection.selectedPayments.forEach((payment) => {
        const date = payment.payment_date;
        if (!byDay.has(date)) byDay.set(date, { date, orderIds: new Set(), pieces: 0, product: 0, shipping: 0, cash: 0 });
        const row = byDay.get(date);
        row.orderIds.add(payment.order_id);
        row.cash += TF.num(payment.amount);
      });
      selection.selectedAllocations.forEach((allocation) => {
        const payment = paymentMap.get(allocation.payment_id);
        if (!payment || !byDay.has(payment.payment_date)) return;
        const row = byDay.get(payment.payment_date);
        if (allocation.allocation_type === 'product') row.product += TF.num(allocation.amount);
        if (allocation.allocation_type === 'jnt_shipping') row.shipping += TF.num(allocation.amount);
      });
      byDay.forEach((row) => {
        row.pieces = [...row.orderIds].reduce((sum, id) => sum + TF.num(orderMap.get(id)?.total_quantity), 0);
      });
    } else {
      selection.selectedOrders.forEach((order) => {
        const date = groupDateForRecord(selection, order);
        if (!date) return;
        if (!byDay.has(date)) byDay.set(date, { date, orderIds: new Set(), pieces: 0, product: 0, shipping: 0, cash: 0 });
        const row = byDay.get(date);
        row.orderIds.add(order.id);
        row.pieces += TF.num(order.total_quantity);
      });
      const dayByOrder = new Map();
      byDay.forEach((row, date) => row.orderIds.forEach((id) => dayByOrder.set(id, date)));
      selection.selectedPayments.forEach((payment) => {
        const date = dayByOrder.get(payment.order_id);
        if (date) byDay.get(date).cash += TF.num(payment.amount);
      });
      selection.selectedAllocations.forEach((allocation) => {
        const date = dayByOrder.get(allocation.order_id);
        if (!date) return;
        if (allocation.allocation_type === 'product') byDay.get(date).product += TF.num(allocation.amount);
        if (allocation.allocation_type === 'jnt_shipping') byDay.get(date).shipping += TF.num(allocation.amount);
      });
    }

    const rows = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
    TF.$('salesByDayTable').innerHTML = `<table><thead><tr><th>Date</th><th>Orders</th><th>Pieces</th><th>Product Sales</th><th>Shipping</th><th>Cash</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${TF.formatDate(row.date)}</strong></td><td>${row.orderIds.size}</td><td>${row.pieces.toLocaleString()}</td><td>${TF.money(row.product)}</td><td>${TF.money(row.shipping)}</td><td><strong>${TF.money(row.cash)}</strong></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No records in this period.</td></tr>'}</tbody></table>`;
  }

  function renderStatus(selection) {
    const groups = [
      ['pending', 'Pending'], ['processing', 'Processing'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']
    ];
    const total = Math.max(selection.selectedOrders.length, 1);
    TF.$('statusBreakdown').innerHTML = groups.map(([key, label]) => {
      const count = selection.selectedOrders.filter((order) => statusGroup(order) === key).length;
      const percent = Math.round((count / total) * 100);
      const params = new URLSearchParams({ filter: key, basis: selection.basis, preset: 'custom', start: selection.start || '', end: selection.end || '' });
      return `<a class="status-break-row" href="./orderpage.html?${params.toString()}"><div><strong>${label}</strong><span>${count.toLocaleString()}</span></div><div class="progress"><i style="width:${percent}%"></i></div></a>`;
    }).join('');
  }

  function renderAccounts(selection) {
    const totals = new Map();
    selection.selectedPayments.forEach((payment) => {
      const name = payment.cash_accounts?.name || 'Unknown account';
      const current = totals.get(name) || { count: 0, amount: 0 };
      current.count += 1;
      current.amount += TF.num(payment.amount);
      totals.set(name, current);
    });
    const rows = [...totals.entries()].sort((a, b) => b[1].amount - a[1].amount);
    TF.$('paymentsByAccount').innerHTML = `<table><thead><tr><th>Account</th><th>Payments</th><th>Total</th></tr></thead><tbody>${rows.map(([name, row]) => `<tr><td><strong>${TF.esc(name)}</strong></td><td>${row.count}</td><td><strong>${TF.money(row.amount)}</strong></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No verified payments in this period.</td></tr>'}</tbody></table>`;
  }

  function renderCategories(selection) {
    const totals = new Map();
    selection.selectedItems.forEach((item) => {
      const category = TF.state.categoryById.get(item.category_id);
      const name = category?.name || 'Unknown category';
      const current = totals.get(name) || { pieces: 0, amount: 0 };
      current.pieces += TF.num(item.quantity);
      current.amount += TF.num(item.line_total);
      totals.set(name, current);
    });
    const rows = [...totals.entries()].sort((a, b) => b[1].pieces - a[1].pieces);
    TF.$('categoryBreakdown').innerHTML = `<table><thead><tr><th>Category</th><th>Pieces</th><th>Order Value</th></tr></thead><tbody>${rows.map(([name, row]) => `<tr><td><strong>${TF.esc(name)}</strong></td><td>${row.pieces.toLocaleString()}</td><td>${TF.money(row.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No category records in this period.</td></tr>'}</tbody></table>`;
  }

  function updateFilterUi() {
    const custom = TF.$('dashboardPreset').value === 'custom';
    TF.$('dashboardStartWrap').classList.toggle('hidden', !custom);
    TF.$('dashboardEndWrap').classList.toggle('hidden', !custom);
  }

  function render() {
    const selection = buildSelection();
    const basisLabels = { order: 'Order Date', payment: 'Payment Date', shipped: 'Shipped Date', delivered: 'Delivered Date' };
    const rangeText = selection.start || selection.end ? `${TF.formatDate(selection.start)} to ${TF.formatDate(selection.end)}` : 'All dates';
    TF.$('dashboardBasisNote').textContent = `Based on ${basisLabels[selection.basis]} • ${rangeText}`;
    TF.$('salesByDayNote').textContent = `Grouped by ${basisLabels[selection.basis]}.`;
    renderKpis(selection);
    renderSalesByDay(selection);
    renderStatus(selection);
    renderAccounts(selection);
    renderCategories(selection);
  }

  async function load() {
    const [ordersResult, paymentsResult, allocationsResult, itemsResult] = await Promise.all([
      TF.state.supa.from('v_daily_ops_orders_v15').select('*').order('order_date', { ascending: false }).limit(10000),
      TF.state.supa.from('payments').select('id,order_id,payment_date,amount,status,cash_account_id,cash_accounts(name)').order('payment_date', { ascending: false }).limit(20000),
      TF.state.supa.from('payment_allocations').select('payment_id,order_id,allocation_type,amount').limit(50000),
      TF.state.supa.from('order_items').select('order_id,category_id,quantity,line_total').limit(50000)
    ]);
    const error = ordersResult.error || paymentsResult.error || allocationsResult.error || itemsResult.error;
    if (error) throw error;
    orders = ordersResult.data || [];
    payments = paymentsResult.data || [];
    allocations = allocationsResult.data || [];
    items = itemsResult.data || [];
    render();
  }

  TF.ready.then(async () => {
    updateFilterUi();
    TF.$('dashboardPreset').addEventListener('change', () => { updateFilterUi(); if (TF.$('dashboardPreset').value !== 'custom') render(); });
    TF.$('dashboardDateBasis').addEventListener('change', render);
    TF.$('dashboardStatus').addEventListener('change', render);
    TF.$('dashboardStart').addEventListener('change', render);
    TF.$('dashboardEnd').addEventListener('change', render);
    TF.$('applyDashboardFilter').addEventListener('click', render);
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Dashboard failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Dashboard failed'));
})();
