(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];

  function monthRange(month) {
    const [year, monthNumber] = month.split('-').map(Number);
    const next = new Date(Date.UTC(year, monthNumber, 1));
    return {
      start: `${month}-01`,
      end: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`
    };
  }

  function renderUrgent(rows) {
    const paidLate = rows.filter((order) => order.paid_not_shipped_alert);
    const missingTracking = rows.filter((order) => order.missing_tracking);
    const waiting = rows.filter((order) => order.status === 'waiting_stock');
    const ready = rows.filter((order) => order.status === 'ready_to_ship');
    const needsPacking = rows.filter((order) => ['confirmed', 'ready_to_pack', 'packing'].includes(order.status));
    const stockReady = rows.filter((order) => order.status === 'waiting_stock' && TF.num(order.shortage_quantity) === 0);
    const tasks = [
      { count: paidLate.length, label: 'Paid orders have not been shipped on time', href: './orderpage.html?filter=paid_late', tone: 'danger' },
      { count: missingTracking.length, label: 'Shipped orders are missing tracking numbers', href: './tracking.html?filter=missing_tracking', tone: 'danger' },
      { count: stockReady.length, label: 'Waiting orders now have enough stock', href: './orderpage.html?filter=waiting_stock', tone: 'info' },
      { count: waiting.filter((order) => TF.num(order.shortage_quantity) > 0).length, label: 'Paid orders are waiting for stock', href: './orderpage.html?filter=waiting_stock', tone: 'warn' },
      { count: needsPacking.length, label: 'Paid orders need packing', href: './orderpage.html?filter=packing', tone: 'warn' },
      { count: ready.length, label: 'Orders are ready to ship', href: './tracking.html?filter=ready_to_ship', tone: 'info' }
    ].filter((task) => task.count > 0);

    TF.$('urgentTasks').innerHTML = tasks.map((task) => `
      <a class="list-row task-row ${task.tone}" href="${task.href}">
        <div><strong>${task.count}</strong><span>${TF.esc(task.label)}</span></div><b>Open →</b>
      </a>`).join('') || '<div class="empty ok-empty">No urgent order issues right now.</div>';
  }

  function renderMonthProgress(rows) {
    const total = rows.length;
    const pieces = rows.reduce((sum, order) => sum + TF.num(order.total_quantity), 0);
    const paid = rows.filter((order) => ['paid', 'overpaid'].includes(order.payment_status)).length;
    const shipped = rows.filter((order) => ['shipped', 'delivered'].includes(order.status)).length;
    const delivered = rows.filter((order) => order.status === 'delivered').length;
    const verified = rows.reduce((sum, order) => sum + TF.num(order.verified_total_paid), 0);
    TF.$('monthProgress').innerHTML = [
      ['Orders entered', total.toLocaleString()],
      ['Pieces recorded', pieces.toLocaleString()],
      ['Fully paid', paid.toLocaleString()],
      ['Shipped', shipped.toLocaleString()],
      ['Delivered', delivered.toLocaleString()],
      ['Verified payments', TF.money(verified)]
    ].map(([label, value]) => `<div class="summary-box"><span>${label}</span><strong>${value}</strong></div>`).join('');
  }

  function renderWaiting(rows) {
    const waiting = rows.filter((order) => order.status === 'waiting_stock').slice(0, 12);
    TF.$('waitingStockTable').innerHTML = `
      <table><thead><tr><th>Order</th><th>Customer</th><th>Pieces</th><th>Short</th><th>Paid</th></tr></thead>
      <tbody>${waiting.map((order) => `<tr>
        <td><a href="./orderpage.html?open=${order.id}"><strong>${TF.esc(order.order_number)}</strong></a><br><small>${TF.formatDate(order.order_date)}</small></td>
        <td>${TF.esc(order.customer_name)}<br><small>${TF.esc(order.phone || '')}</small></td>
        <td>${TF.num(order.total_quantity)}</td>
        <td>${TF.num(order.shortage_quantity) > 0 ? `<span class="pill danger">${TF.num(order.shortage_quantity)} short</span>` : '<span class="pill ok">Ready now</span>'}</td>
        <td>${TF.money(order.verified_total_paid)}<br><small>${TF.esc(order.latest_payment_account_name || 'No account')}</small></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No waiting-for-stock orders.</td></tr>'}</tbody></table>`;
  }

  function renderLowStock(rows) {
    const low = rows.filter((row) => row.is_low_stock).sort((a, b) => TF.num(a.total_available) - TF.num(b.total_available));
    TF.$('lowStockList').innerHTML = low.map((row) => `
      <div class="list-row"><div><strong>${TF.esc(row.category_name)}</strong><span>${TF.num(row.total_available).toLocaleString()} available • alert at ${TF.num(row.low_stock_level)}</span></div>${TF.statusPill('waiting_stock')}</div>
    `).join('') || '<div class="empty ok-empty">No category is below its low-stock level.</div>';
  }

  function renderRecent(rows) {
    const recent = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20);
    TF.$('recentOrders').innerHTML = `
      <table><thead><tr><th>Order</th><th>Customer</th><th>Payment</th><th>Order status</th><th>Tracking</th><th>Last update</th></tr></thead>
      <tbody>${recent.map((order) => `<tr>
        <td><a href="./orderpage.html?open=${order.id}"><strong>${TF.esc(order.order_number)}</strong></a><br><small>${TF.formatDate(order.order_date)}</small></td>
        <td>${TF.esc(order.customer_name)}<br><small>${TF.esc(order.phone || '')}</small></td>
        <td>${TF.statusPill(order.payment_status)}<br><small>${TF.esc(order.latest_payment_account_name || '')}</small></td>
        <td>${TF.statusPill(order.status)}</td>
        <td>${order.tracking_number ? `<code>${TF.esc(order.tracking_number)}</code>` : '<span class="muted">Not available</span>'}</td>
        <td>${TF.formatDateTime(order.last_activity_at)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No orders entered yet.</td></tr>'}</tbody></table>`;
  }

  async function load() {
    try {
      const month = TF.$('dashboardMonth').value || TF.monthKey();
      const range = monthRange(month);
      const [ordersResult, inventoryResult] = await Promise.all([
        TF.state.supa.from('v_daily_ops_orders_v14').select('*').gte('order_date', range.start).lt('order_date', range.end).order('created_at', { ascending: false }).limit(3000),
        TF.state.supa.from('v_daily_inventory_v14').select('*').order('category_name')
      ]);
      if (ordersResult.error || inventoryResult.error) throw ordersResult.error || inventoryResult.error;
      orders = ordersResult.data || [];
      const currentDate = TF.today();
      TF.$('kpiOrdersToday').textContent = orders.filter((order) => order.order_date === currentDate).length;
      TF.$('kpiAwaiting').textContent = orders.filter((order) => ['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status)).length;
      TF.$('kpiPacking').textContent = orders.filter((order) => ['confirmed', 'ready_to_pack', 'packing'].includes(order.status)).length;
      TF.$('kpiWaitingStock').textContent = orders.filter((order) => order.status === 'waiting_stock').length;
      TF.$('kpiMissingTracking').textContent = orders.filter((order) => order.missing_tracking).length;
      TF.$('kpiReadyToShip').textContent = orders.filter((order) => order.status === 'ready_to_ship').length;
      renderUrgent(orders);
      renderMonthProgress(orders);
      renderWaiting(orders);
      renderLowStock(inventoryResult.data || []);
      renderRecent(orders);
    } catch (error) {
      TF.fail(error, 'Dashboard failed');
    }
  }

  TF.ready.then(() => {
    TF.$('dashboardMonth').value = TF.monthKey();
    TF.$('dashboardMonth').addEventListener('change', load);
    window.addEventListener('twofly:refresh', load);
    load();
  }).catch((error) => TF.fail(error, 'Dashboard failed'));
})();
