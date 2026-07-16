(() => {
  'use strict';
  const TF = window.TwoFly;
  const S = { orders: [], payments: [], allocations: [], attention: [], entered: [], shipped: [], delivered: [] };

  function dayBounds(date) {
    return {
      start: `${date}T00:00:00+08:00`,
      end: `${date}T23:59:59.999+08:00`
    };
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + TF.num(typeof key === 'function' ? key(row) : row[key]), 0);
  }

  function paymentAccountName(payment) {
    return payment.cash_accounts?.name || 'Unspecified account';
  }

  function renderPaymentsByAccount() {
    const grouped = new Map();
    S.payments.forEach((payment) => {
      const name = paymentAccountName(payment);
      const row = grouped.get(name) || { name, count: 0, amount: 0 };
      row.count += 1;
      row.amount += TF.num(payment.amount);
      grouped.set(name, row);
    });
    const rows = Array.from(grouped.values()).sort((a, b) => b.amount - a.amount);
    TF.$('accountTotalsTable').innerHTML = `<table><thead><tr><th>Account</th><th>Payments</th><th>Total received</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${TF.esc(row.name)}</strong></td><td>${row.count}</td><td><strong>${TF.money(row.amount)}</strong></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No verified payments on this date.</td></tr>'}</tbody></table>`;
  }

  function renderBreakdown() {
    const totals = { product: 0, jnt_shipping: 0, unapplied: 0, refund: 0 };
    S.allocations.forEach((allocation) => { totals[allocation.allocation_type] = (totals[allocation.allocation_type] || 0) + TF.num(allocation.amount); });
    TF.$('paymentBreakdown').innerHTML = [
      ['Product payments', totals.product],
      ['Shipping collected', totals.jnt_shipping],
      ['Unapplied / overpayment', totals.unapplied],
      ['Refund allocation', totals.refund]
    ].map(([label, value]) => `<div class="summary-line"><span>${TF.esc(label)}</span><strong>${TF.money(value)}</strong></div>`).join('');
  }

  function orderRows(rows, empty) {
    return `<table><thead><tr><th>Order</th><th>Customer</th><th>Pieces</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map((order) => `<tr><td><a href="./orderpage.html?open=${encodeURIComponent(order.id)}"><strong>${TF.esc(order.order_number)}</strong></a><br><small>${TF.formatDate(order.order_date)}</small></td><td>${TF.esc(order.customer_name)}<br><small>${TF.esc(order.phone || '')}</small></td><td>${order.total_quantity || 0}</td><td>${TF.money(order.total_due)}</td><td>${TF.statusPill(order.status)}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">${TF.esc(empty)}</td></tr>`}</tbody></table>`;
  }

  function renderOrders() {
    TF.$('enteredOrdersTable').innerHTML = orderRows(S.entered, 'No orders entered for this date.');
    const activity = [
      ...S.shipped.map((order) => ({ ...order, event: 'Shipped' })),
      ...S.delivered.map((order) => ({ ...order, event: 'Delivered' }))
    ].sort((a, b) => String(a.order_number).localeCompare(String(b.order_number)));
    TF.$('fulfillmentTable').innerHTML = `<table><thead><tr><th>Order</th><th>Customer</th><th>Event</th><th>Tracking</th></tr></thead><tbody>${activity.map((order) => `<tr><td><a href="./tracking.html?order=${encodeURIComponent(order.id)}"><strong>${TF.esc(order.order_number)}</strong></a></td><td>${TF.esc(order.customer_name)}</td><td>${TF.esc(order.event)}</td><td>${TF.esc(order.tracking_number || 'Not available')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No shipping or delivery activity for this date.</td></tr>'}</tbody></table>`;
  }

  function renderAttention() {
    const groups = [
      ['Awaiting payment', S.attention.filter((o) => ['draft', 'payment_review'].includes(o.status)).length, './orderpage.html?filter=awaiting'],
      ['Waiting for stock', S.attention.filter((o) => o.status === 'waiting_stock').length, './orderpage.html?filter=waiting_stock'],
      ['Needs packing', S.attention.filter((o) => ['confirmed', 'ready_to_pack', 'packing'].includes(o.status)).length, './orderpage.html?filter=packing'],
      ['Ready to ship', S.attention.filter((o) => o.status === 'ready_to_ship').length, './tracking.html?filter=ready_to_ship'],
      ['Missing tracking', S.attention.filter((o) => o.missing_tracking).length, './tracking.html?filter=missing_tracking'],
      ['Paid too long', S.attention.filter((o) => o.paid_not_shipped_alert).length, './tracking.html?filter=paid_late']
    ];
    TF.$('attentionGrid').innerHTML = groups.map(([label, value, href]) => `<a class="attention-card" href="${href}"><span>${TF.esc(label)}</span><strong>${value}</strong></a>`).join('');
  }

  function buildSummary(date) {
    const accountTotals = new Map();
    S.payments.forEach((payment) => accountTotals.set(paymentAccountName(payment), (accountTotals.get(paymentAccountName(payment)) || 0) + TF.num(payment.amount)));
    const allocations = { product: 0, shipping: 0 };
    S.allocations.forEach((a) => {
      if (a.allocation_type === 'product') allocations.product += TF.num(a.amount);
      if (a.allocation_type === 'jnt_shipping') allocations.shipping += TF.num(a.amount);
    });
    const lines = [
      `2FLY Daily Operations — ${TF.formatDate(date)}`,
      '',
      `Orders entered: ${S.entered.length}`,
      `Payments confirmed: ${S.payments.length}`,
      `Total received: ${TF.money(sum(S.payments, 'amount'))}`,
      `Product payments: ${TF.money(allocations.product)}`,
      `Shipping collected: ${TF.money(allocations.shipping)}`,
      `Pieces in paid orders: ${paidPieces()}`,
      `Orders shipped: ${S.shipped.length}`,
      `Orders delivered: ${S.delivered.length}`,
      '',
      'Payments by account:'
    ];
    if (accountTotals.size) Array.from(accountTotals.entries()).sort((a, b) => b[1] - a[1]).forEach(([name, amount]) => lines.push(`• ${name}: ${TF.money(amount)}`));
    else lines.push('• No verified payments');
    lines.push('', 'Open queues:');
    lines.push(`• Awaiting payment: ${S.attention.filter((o) => ['draft', 'payment_review'].includes(o.status)).length}`);
    lines.push(`• Waiting for stock: ${S.attention.filter((o) => o.status === 'waiting_stock').length}`);
    lines.push(`• Needs packing: ${S.attention.filter((o) => ['confirmed', 'ready_to_pack', 'packing'].includes(o.status)).length}`);
    lines.push(`• Ready to ship: ${S.attention.filter((o) => o.status === 'ready_to_ship').length}`);
    lines.push(`• Missing tracking: ${S.attention.filter((o) => o.missing_tracking).length}`);
    return lines.join('\n');
  }

  function paidPieces() {
    const paidOrderIds = new Set(S.payments.map((payment) => payment.order_id).filter(Boolean));
    return S.orders.filter((order) => paidOrderIds.has(order.id)).reduce((total, order) => total + TF.num(order.total_quantity), 0);
  }

  function renderKpis() {
    TF.$('ordersEntered').textContent = S.entered.length;
    TF.$('paymentsCount').textContent = S.payments.length;
    TF.$('totalReceived').textContent = TF.money(sum(S.payments, 'amount'));
    TF.$('piecesPaid').textContent = paidPieces();
    TF.$('ordersShipped').textContent = S.shipped.length;
    TF.$('ordersDelivered').textContent = S.delivered.length;
    TF.$('summaryPreview').textContent = buildSummary(TF.$('summaryDate').value);
  }

  async function load() {
    const date = TF.$('summaryDate').value || TF.today();
    const bounds = dayBounds(date);
    try {
      const [ordersResult, paymentsResult, attentionResult] = await Promise.all([
        TF.state.supa.from('v_daily_ops_orders_v14').select('*').order('order_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
        TF.state.supa.from('payments').select('id,order_id,payment_date,amount,payment_method,cash_account_id,status,reference_number,cash_accounts(name)').eq('status', 'verified').eq('payment_date', date).order('created_at'),
        TF.state.supa.from('v_daily_ops_orders_v14').select('*').not('status', 'in', '(delivered,cancelled,refunded)').order('last_activity_at', { ascending: false }).limit(3000)
      ]);
      if (ordersResult.error || paymentsResult.error || attentionResult.error) throw ordersResult.error || paymentsResult.error || attentionResult.error;
      S.orders = ordersResult.data || [];
      S.payments = paymentsResult.data || [];
      S.attention = attentionResult.data || [];
      S.entered = S.orders.filter((order) => order.order_date === date);
      S.shipped = S.orders.filter((order) => order.shipped_at && new Date(order.shipped_at) >= new Date(bounds.start) && new Date(order.shipped_at) <= new Date(bounds.end));
      S.delivered = S.orders.filter((order) => order.delivered_at && new Date(order.delivered_at) >= new Date(bounds.start) && new Date(order.delivered_at) <= new Date(bounds.end));

      const ids = S.payments.map((payment) => payment.id);
      if (ids.length) {
        const allocationResult = await TF.state.supa.from('payment_allocations').select('payment_id,allocation_type,amount').in('payment_id', ids);
        if (allocationResult.error) throw allocationResult.error;
        S.allocations = allocationResult.data || [];
      } else S.allocations = [];

      renderKpis();
      renderPaymentsByAccount();
      renderBreakdown();
      renderOrders();
      renderAttention();
    } catch (error) {
      TF.fail(error, 'Daily summary failed');
    }
  }

  function exportCsv() {
    const rows = [['Type', 'Date', 'Order', 'Customer', 'Account', 'Amount', 'Status', 'Tracking']];
    S.payments.forEach((payment) => {
      const order = S.orders.find((item) => item.id === payment.order_id);
      rows.push(['Payment', payment.payment_date, order?.order_number || '', order?.customer_name || '', paymentAccountName(payment), payment.amount, payment.status, order?.tracking_number || '']);
    });
    S.entered.forEach((order) => rows.push(['Order Entered', order.order_date, order.order_number, order.customer_name, order.latest_payment_account_name || '', order.total_due, order.status, order.tracking_number || '']));
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `2FLY_DAILY_SUMMARY_${TF.$('summaryDate').value}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function init() {
    await TF.ready;
    TF.$('summaryDate').value = TF.today();
    TF.$('summaryDate').addEventListener('change', load);
    TF.$('todayBtn').addEventListener('click', () => { TF.$('summaryDate').value = TF.today(); load(); });
    TF.$('copySummaryBtn').addEventListener('click', () => TF.copyText(TF.$('summaryPreview').textContent, 'Daily summary copied'));
    TF.$('exportCsvBtn').addEventListener('click', exportCsv);
    window.addEventListener('twofly:refresh', load);
    await load();
  }

  init().catch((error) => TF.fail(error, 'Daily Summary failed'));
})();
