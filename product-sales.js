(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let items = [];

  function paidSale(order) {
    if (['cancelled', 'refunded'].includes(String(order.status || '').toLowerCase())) return false;
    return ['paid', 'overpaid'].includes(String(order.payment_status || '').toLowerCase());
  }

  async function loadRowsInChunks(table, selectColumns, filterColumn, ids, chunkSize = 150) {
    const rows = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const result = await TF.state.supa.from(table).select(selectColumns).in(filterColumn, chunk);
      if (result.error) throw result.error;
      rows.push(...(result.data || []));
    }
    return rows;
  }

  function categoryRows() {
    const grouped = new Map(
      TF.state.categories.map((category) => [
        category.id,
        { id: category.id, code: category.code, name: category.name, pieces: 0, orderIds: new Set() }
      ])
    );

    items.forEach((item) => {
      const category = TF.state.categoryById.get(item.category_id);
      const id = item.category_id || 'unknown';
      if (!grouped.has(id)) {
        grouped.set(id, {
          id,
          code: category?.code || '',
          name: category?.name || 'Unknown Category',
          pieces: 0,
          orderIds: new Set()
        });
      }
      const row = grouped.get(id);
      row.pieces += TF.num(item.quantity);
      row.orderIds.add(item.order_id);
    });

    return [...grouped.values()].sort((a, b) => b.pieces - a.pieces || a.name.localeCompare(b.name));
  }

  function render() {
    const rows = categoryRows();
    const soldRows = rows.filter((row) => row.pieces > 0);
    const totalPieces = soldRows.reduce((sum, row) => sum + row.pieces, 0);
    const maxPieces = Math.max(...rows.map((row) => row.pieces), 1);
    const top = soldRows[0];

    TF.$('psPieces').textContent = totalPieces.toLocaleString();
    TF.$('psOrders').textContent = orders.length.toLocaleString();
    TF.$('psCategories').textContent = soldRows.length.toLocaleString();
    TF.$('psTop').textContent = top ? `${top.name} · ${top.pieces.toLocaleString()}` : '—';
    TF.$('psDateNote').textContent = `${TF.formatDate(TF.$('productSalesDate').value)} • paid orders only`;

    TF.$('productSalesCards').innerHTML = rows.map((row) => {
      const width = row.pieces ? Math.max(6, Math.round((row.pieces / maxPieces) * 100)) : 0;
      return `<article class="product-sales-category-card ${row.pieces ? '' : 'zero'}">
        <div class="product-sales-category-head">
          <div><strong>${TF.esc(row.name)}</strong><small>${TF.esc(row.code || '')}</small></div>
          <span>${row.pieces.toLocaleString()}</span>
        </div>
        <div class="progress"><span style="width:${width}%"></span></div>
        <div class="product-sales-category-foot">${row.pieces === 1 ? '1 piece sold' : `${row.pieces.toLocaleString()} pieces sold`} • ${row.orderIds.size} ${row.orderIds.size === 1 ? 'order' : 'orders'}</div>
      </article>`;
    }).join('');

    TF.$('productSalesTable').innerHTML = `<table>
      <thead><tr><th>Category</th><th>Pieces Sold</th><th>Paid Orders</th></tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>
          <td><strong>${TF.esc(row.name)}</strong><br><small>${TF.esc(row.code || '')}</small></td>
          <td><strong>${row.pieces.toLocaleString()}</strong></td>
          <td>${row.orderIds.size.toLocaleString()}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="empty">No categories found.</td></tr>'}
      </tbody>
    </table>`;
  }

  async function load() {
    const date = TF.$('productSalesDate').value || TF.today();

    const orderResult = await TF.state.supa
      .from('v_daily_ops_orders_v16')
      .select('*')
      .eq('order_date', date)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (orderResult.error) throw orderResult.error;

    orders = (orderResult.data || []).filter(paidSale);
    const ids = orders.map((order) => order.id).filter(Boolean);

    if (!ids.length) {
      items = [];
      render();
      return;
    }

    items = await loadRowsInChunks(
      'order_items',
      'order_id,category_id,quantity',
      'order_id',
      ids
    );

    render();
  }

  function moveDate(days) {
    TF.$('productSalesDate').value = TF.addDays(TF.$('productSalesDate').value || TF.today(), days);
    load().catch((error) => TF.fail(error, 'Product sales failed'));
  }

  async function init() {
    await TF.ready;
    TF.$('productSalesDate').value = TF.today();
    TF.$('productSalesDate').addEventListener('change', () => load().catch((error) => TF.fail(error, 'Product sales failed')));
    TF.$('todaySalesBtn').addEventListener('click', () => {
      TF.$('productSalesDate').value = TF.today();
      load().catch((error) => TF.fail(error, 'Product sales failed'));
    });
    TF.$('prevDayBtn').addEventListener('click', () => moveDate(-1));
    TF.$('nextDayBtn').addEventListener('click', () => moveDate(1));
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Product sales failed')));
    await load();
  }

  init().catch((error) => TF.fail(error, 'Product sales failed'));
})();
