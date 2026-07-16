(() => {
  'use strict';
  const TF = window.TwoFly;
  let parsedItems = [];
  let orders = [];
  let activeOrder = null;
  let activeItems = [];
  let editingOrderId = null;
  let lastExpected = 0;

  function categoryCode(item) {
    return TF.state.categoryById.get(item?.category_id)?.code || item?.category_code || '';
  }

  function unitLabel(code, quantity) {
    if (code === 'EARRINGS') return quantity === 1 ? 'pair' : 'pairs';
    return 'pcs';
  }

  function representativeProduct(categoryId, preferredSku = '') {
    const preferred = TF.state.productByCode.get(String(preferredSku || '').toUpperCase());
    if (preferred && preferred.category_id === categoryId) return preferred;
    return TF.state.products.find((product) => product.category_id === categoryId && product.active) || null;
  }

  function categoryOptions(selectedId = '') {
    return TF.state.categories.map((category) => `<option value="${TF.esc(category.id)}" ${category.id === selectedId ? 'selected' : ''}>${TF.esc(category.name)}</option>`).join('');
  }

  function summarizeStoredItems(items) {
    const grouped = new Map();
    (items || []).forEach((item) => {
      const category = TF.state.categoryById.get(item.category_id);
      const key = item.category_id || item.sku;
      const existing = grouped.get(key) || {
        category_id: item.category_id,
        category_code: category?.code || '',
        category: category?.name || item.product_name || item.sku,
        sku: item.sku,
        quantity: 0,
        line_total: 0,
        unit_price: 0
      };
      existing.quantity += TF.num(item.quantity);
      existing.line_total += TF.num(item.line_total ?? (TF.num(item.quantity) * TF.num(item.unit_price)));
      grouped.set(key, existing);
    });
    return [...grouped.values()].map((item) => ({
      ...item,
      unit_price: item.quantity > 0 ? item.line_total / item.quantity : 0
    }));
  }

  function fillBase() {
    TF.$('paymentAccount').innerHTML = TF.accountOptions(true);
    TF.$('addPaymentAccount').innerHTML = TF.accountOptions(true);
    TF.$('orderDate').value = TF.today();
    TF.$('paymentDate').value = TF.today();
    TF.$('addPaymentDate').value = TF.today();
  }

  function parseOrder() {
    const raw = TF.$('orderPaste').value.trim();
    if (!raw) {
      TF.toast('Paste an order form first', true);
      return;
    }
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    const groups = [];
    const warnings = [];
    let current = null;
    const getField = (name) => {
      const regex = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'i');
      const line = lines.find((value) => regex.test(value));
      return line ? line.match(regex)[1].trim() : '';
    };

    TF.$('orderCustomer').value = getField('Name');
    TF.$('orderPhone').value = getField('Phone');
    TF.$('orderAddress').value = getField('Address');

    for (const line of lines) {
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        current = { label: TF.normalizeCategoryLabel(header[1]), items: [], quantity: null, amount: null };
        groups.push(current);
        continue;
      }
      if (!current) continue;
      const item = line.match(/^[•*]\s*(.+?)\s+[–—-]\s*x\s*(\d+)\s*$/i);
      if (item) {
        current.items.push({ sku: item[1].replace(/\(\s*Size\s*:[^)]+\)/i, '').trim().toUpperCase(), quantity: Number(item[2]) });
        continue;
      }
      const quantity = line.match(/^Category Qty\s*:\s*(\d+)/i);
      if (quantity) current.quantity = Number(quantity[1]);
      const amount = line.match(/^Category Amount\s*:\s*₱?\s*([\d,]+(?:\.\d+)?)/i);
      if (amount) current.amount = Number(amount[1].replace(/,/g, ''));
    }

    const groupedCategories = new Map();
    groups.forEach((group) => {
      const category = TF.state.aliasToCategory.get(group.label);
      if (!category) {
        warnings.push(`Unknown category: ${group.label}`);
        return;
      }

      const itemQuantity = group.items.reduce((sum, item) => sum + item.quantity, 0);
      const totalQuantity = group.quantity ?? itemQuantity;
      if (group.quantity !== null && itemQuantity > 0 && itemQuantity !== group.quantity) {
        warnings.push(`${group.label}: design lines total ${itemQuantity}, but Category Qty says ${group.quantity}. Category Qty was used.`);
      }
      if (!totalQuantity || totalQuantity <= 0) {
        warnings.push(`${group.label}: quantity is missing or zero.`);
        return;
      }

      const preferredSku = group.items.find((item) => {
        const product = TF.state.productByCode.get(item.sku);
        return product?.category_id === category.id;
      })?.sku || '';
      const product = representativeProduct(category.id, preferredSku);
      if (!product) {
        warnings.push(`${category.name}: no active product is available internally for saving.`);
        return;
      }

      let amount = group.amount;
      if (amount === null) {
        const designTotal = group.items.reduce((sum, item) => {
          const design = TF.state.productByCode.get(item.sku);
          return sum + item.quantity * TF.num(design?.default_sell_price);
        }, 0);
        amount = designTotal || totalQuantity * TF.num(product.default_sell_price);
      }

      const existing = groupedCategories.get(category.id) || {
        category_id: category.id,
        category_code: category.code,
        category: category.name,
        sku: product.code,
        quantity: 0,
        amount: 0
      };
      existing.quantity += totalQuantity;
      existing.amount += TF.num(amount);
      groupedCategories.set(category.id, existing);
    });

    const result = [...groupedCategories.values()].map((item) => ({
      category_id: item.category_id,
      category_code: item.category_code,
      category: item.category,
      sku: item.sku,
      quantity: item.quantity,
      unit_price: item.quantity > 0 ? item.amount / item.quantity : 0,
      name: item.category
    }));

    const totalLine = lines.find((line) => /^Total Amount\s*:/i.test(line));
    const shownTotal = totalLine ? Number((totalLine.match(/₱?\s*([\d,]+(?:\.\d+)?)/) || [])[1]?.replace(/,/g, '') || 0) : 0;
    const calculated = result.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    if (shownTotal && Math.abs(shownTotal - calculated) > 0.02) warnings.push(`Order form total is ${TF.money(shownTotal)}, while category totals equal ${TF.money(calculated)}.`);

    parsedItems = result;
    renderItems();
    TF.$('paymentAmount').value = String(calculated + shippingFee());
    lastExpected = calculated + shippingFee();
    TF.$('parseWarnings').innerHTML = warnings.length
      ? warnings.map((warning) => `• ${TF.esc(warning)}`).join('<br>')
      : 'Order form recognized. Customer details were filled automatically and designs were combined into category totals.';
    TF.$('parseWarnings').classList.remove('hidden');
  }

  function renderItems() {
    TF.$('parsedItemsBody').innerHTML = parsedItems.map((item, index) => {
      const category = TF.state.categoryById.get(item.category_id);
      return `<tr>
        <td><select data-field="category_id" data-index="${index}"><option value="">Select category</option>${categoryOptions(item.category_id)}</select></td>
        <td><input data-field="quantity" data-index="${index}" type="number" min="1" step="1" value="${TF.num(item.quantity)}"><small>${unitLabel(category?.code || item.category_code, TF.num(item.quantity))}</small></td>
        <td><input data-field="unit_price" data-index="${index}" type="number" min="0" step="0.01" value="${TF.num(item.unit_price).toFixed(2)}"></td>
        <td><strong>${TF.money(TF.num(item.quantity) * TF.num(item.unit_price))}</strong></td>
        <td><button class="btn danger small" data-remove="${index}">Remove</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">Paste an order form or add a category.</td></tr>';
    updateTotals();
  }

  function editItem(event) {
    const index = Number(event.target.dataset.index);
    const field = event.target.dataset.field;
    if (!Number.isInteger(index) || !field || !parsedItems[index]) return;
    let value = event.target.value;
    if (['quantity', 'unit_price'].includes(field)) value = Number(value || 0);
    parsedItems[index][field] = value;
    if (field === 'category_id') {
      const category = TF.state.categoryById.get(value);
      const product = representativeProduct(value);
      Object.assign(parsedItems[index], {
        category_id: value,
        category_code: category?.code || '',
        category: category?.name || '',
        sku: product?.code || '',
        name: category?.name || ''
      });
      if (!parsedItems[index].unit_price) parsedItems[index].unit_price = Number(product?.default_sell_price || 0);
    }
    renderItems();
  }

  function productTotal() {
    return parsedItems.reduce((sum, item) => sum + TF.num(item.quantity) * TF.num(item.unit_price), 0);
  }

  function shippingFee() {
    return TF.$('fulfillmentMethod').value === 'jnt' ? TF.num(TF.$('shippingFee').value) : 0;
  }

  function updateConditions() {
    const jnt = TF.$('fulfillmentMethod').value === 'jnt';
    TF.$('shippingFee').disabled = !jnt;
    TF.$('courierCost').disabled = !jnt;
    if (!jnt) {
      TF.$('shippingFee').value = '0';
      TF.$('courierCost').value = '';
    }
    TF.$('releaseDateWrap').classList.toggle('hidden', TF.$('orderType').value !== 'made_to_order');
    updateTotals(true);
  }

  function updateTotals(syncPayment = false) {
    const products = productTotal();
    const shipping = shippingFee();
    const expected = products + shipping;
    TF.$('orderProductTotal').textContent = TF.money(products);
    TF.$('orderShippingTotal').textContent = TF.money(shipping);
    TF.$('orderExpectedTotal').textContent = TF.money(expected);
    TF.$('parsedSummary').textContent = `${parsedItems.length} categories • ${parsedItems.reduce((sum, item) => sum + TF.num(item.quantity), 0)} pieces • ${TF.money(products)}`;
    if (syncPayment) {
      const current = TF.num(TF.$('paymentAmount').value);
      if (!current || Math.abs(current - lastExpected) < 0.02) TF.$('paymentAmount').value = expected.toFixed(2);
    }
    lastExpected = expected;
  }

  async function uploadProof(input) {
    const file = input.files?.[0];
    if (!file) return '';
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = `${TF.state.session.user.id}/${TF.today()}/${crypto.randomUUID()}-${safe}`;
    const result = await TF.state.supa.storage.from('payment-proofs').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    });
    if (result.error) throw result.error;
    return path;
  }

  function validateItems() {
    if (!parsedItems.length) throw new Error('Add at least one category.');
    for (const item of parsedItems) {
      const category = TF.state.categoryById.get(item.category_id);
      const product = representativeProduct(item.category_id, item.sku);
      if (!category) throw new Error('Select a valid category.');
      if (!product) throw new Error(`${category.name} is not configured for order saving.`);
      item.sku = product.code;
      item.category = category.name;
      item.category_code = category.code;
      if (TF.num(item.quantity) <= 0) throw new Error(`Invalid quantity for ${category.name}`);
      if (TF.num(item.unit_price) < 0) throw new Error(`Invalid unit price for ${category.name}`);
    }
    if (!TF.$('orderCustomer').value.trim()) throw new Error('Customer name is required.');
    if (TF.$('orderType').value === 'made_to_order' && !TF.$('expectedReleaseDate').value) throw new Error('Made-to-order needs an expected release date.');
  }

  async function duplicateWarning(fingerprint) {
    const result = await TF.state.supa.rpc('check_duplicate_order_v14', {
      p_phone: TF.$('orderPhone').value.trim(),
      p_customer_name: TF.$('orderCustomer').value.trim(),
      p_total_due: productTotal() + shippingFee(),
      p_order_date: TF.$('orderDate').value || TF.today(),
      p_form_fingerprint: fingerprint
    });
    if (result.error) throw result.error;
    const matches = result.data || [];
    if (!matches.length) return true;
    const list = matches.map((order) => `${order.order_number} — ${order.customer_name} — ${TF.money(order.total_due)} — ${order.order_date}`).join('\n');
    return window.confirm(`Possible duplicate order found:\n\n${list}\n\nSave this order anyway?`);
  }

  async function saveOrder(confirmPayment) {
    const button = confirmPayment ? TF.$('saveConfirmBtn') : TF.$('saveAwaitingBtn');
    TF.setLoading(button, true, confirmPayment ? 'Confirming…' : 'Saving…');
    try {
      validateItems();
      if (confirmPayment && !TF.can('confirm_payments')) throw new Error('You do not have permission to confirm payments.');
      const amount = TF.num(TF.$('paymentAmount').value);
      if (confirmPayment && amount <= 0) throw new Error('Enter the amount received.');
      if (confirmPayment && !TF.$('paymentAccount').value) throw new Error('Select the account where the payment entered.');
      const raw = TF.$('orderPaste').value.trim();
      const fingerprint = raw ? await TF.sha256(raw) : await TF.sha256(JSON.stringify({ phone: TF.$('orderPhone').value, date: TF.$('orderDate').value, items: parsedItems, total: productTotal() + shippingFee() }));
      if (!(await duplicateWarning(fingerprint))) return;
      const proof = confirmPayment ? await uploadProof(TF.$('paymentProof')) : '';
      const order = {
        raw_order_form: raw,
        form_fingerprint: fingerprint,
        customer_name: TF.$('orderCustomer').value.trim(),
        phone: TF.$('orderPhone').value.trim(),
        address: TF.$('orderAddress').value.trim(),
        order_type: TF.$('orderType').value,
        fulfillment_method: TF.$('fulfillmentMethod').value,
        order_date: TF.$('orderDate').value || TF.today(),
        expected_release_date: TF.$('expectedReleaseDate').value || null,
        shipping_fee_due: shippingFee(),
        actual_courier_cost: TF.$('fulfillmentMethod').value === 'jnt' && TF.$('courierCost').value.trim() !== '' ? TF.num(TF.$('courierCost').value) : 0,
        notes: TF.$('orderNotes').value.trim()
      };
      const items = parsedItems.map((item) => ({
        sku: String(item.sku).toUpperCase(),
        size: String(item.size || '').toUpperCase(),
        quantity: TF.num(item.quantity),
        unit_price: TF.num(item.unit_price)
      }));
      const payment = confirmPayment ? {
        payment_date: TF.$('paymentDate').value || TF.today(),
        amount,
        payment_method: TF.$('paymentMethod').value,
        cash_account_id: TF.$('paymentAccount').value,
        reference_number: TF.$('paymentReference').value.trim(),
        proof_storage_path: proof
      } : null;
      const result = await TF.state.supa.rpc('create_daily_order_v14', {
        p_order: order,
        p_items: items,
        p_payment: payment,
        p_confirm_payment: confirmPayment
      });
      if (result.error) throw result.error;
      TF.toast(confirmPayment ? 'Order saved and payment confirmed' : 'Order saved as Awaiting Payment');
      resetForm();
      await loadOrders();
      if (result.data?.order_id) await openOrder(result.data.order_id);
    } catch (error) {
      TF.fail(error, 'Order not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  function resetForm() {
    editingOrderId = null;
    parsedItems = [];
    ['orderPaste', 'orderCustomer', 'orderPhone', 'orderAddress', 'orderNotes', 'paymentReference'].forEach((id) => { TF.$(id).value = ''; });
    TF.$('paymentProof').value = '';
    TF.$('orderDate').value = TF.today();
    TF.$('paymentDate').value = TF.today();
    TF.$('orderType').value = 'regular';
    TF.$('fulfillmentMethod').value = 'unselected';
    TF.$('expectedReleaseDate').value = '';
    TF.$('shippingFee').value = '0';
    TF.$('courierCost').value = '';
    TF.$('paymentAmount').value = '';
    TF.$('parseWarnings').classList.add('hidden');
    TF.$('editOrderBanner').classList.add('hidden');
    TF.$('saveAwaitingBtn').classList.remove('hidden');
    TF.$('saveConfirmBtn').classList.toggle('hidden', !TF.can('confirm_payments'));
    TF.$('saveEditBtn').classList.add('hidden');
    ['paymentDate', 'paymentAmount', 'paymentMethod', 'paymentAccount', 'paymentReference', 'paymentProof', 'orderDate'].forEach((id) => { TF.$(id).disabled = false; });
    renderItems();
    updateConditions();
  }

  async function startEdit(order) {
    if (!TF.can('edit_orders')) throw new Error('You do not have permission to edit orders.');
    if (['packing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(order.status)) throw new Error('Items cannot be changed after inventory has been committed. Status and tracking can still be updated.');
    const result = await TF.state.supa.from('order_items').select('*').eq('order_id', order.id).order('line_number');
    if (result.error) throw result.error;
    editingOrderId = order.id;
    parsedItems = summarizeStoredItems((result.data || []).filter((item) => !item.is_system_included)).map((item) => ({
      category_id: item.category_id,
      category_code: item.category_code,
      category: item.category,
      sku: representativeProduct(item.category_id, item.sku)?.code || item.sku,
      quantity: item.quantity,
      unit_price: item.unit_price,
      name: item.category
    }));
    TF.$('orderPaste').value = order.raw_order_form || '';
    TF.$('orderCustomer').value = order.customer_name || '';
    TF.$('orderPhone').value = order.phone || '';
    TF.$('orderAddress').value = order.address || '';
    TF.$('orderDate').value = order.order_date || TF.today();
    TF.$('orderType').value = order.order_type || 'regular';
    TF.$('fulfillmentMethod').value = order.fulfillment_method || 'unselected';
    TF.$('expectedReleaseDate').value = order.expected_release_date || '';
    TF.$('shippingFee').value = TF.num(order.shipping_fee_due).toFixed(2);
    TF.$('courierCost').value = order.courier_cost_finalized ? TF.num(order.actual_courier_cost).toFixed(2) : '';
    TF.$('orderNotes').value = order.notes || '';
    TF.$('editOrderBanner').classList.remove('hidden');
    TF.$('editOrderLabel').textContent = `Editing ${order.order_number}. Payment records are not changed.`;
    TF.$('saveAwaitingBtn').classList.add('hidden');
    TF.$('saveConfirmBtn').classList.add('hidden');
    TF.$('saveEditBtn').classList.remove('hidden');
    ['paymentDate', 'paymentAmount', 'paymentMethod', 'paymentAccount', 'paymentReference', 'paymentProof'].forEach((id) => { TF.$(id).disabled = true; });
    renderItems();
    updateConditions();
    TF.$('orderDialog').close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveEdit() {
    if (!editingOrderId) return;
    const button = TF.$('saveEditBtn');
    TF.setLoading(button, true, 'Saving…');
    try {
      validateItems();
      const order = {
        raw_order_form: TF.$('orderPaste').value.trim(),
        customer_name: TF.$('orderCustomer').value.trim(),
        phone: TF.$('orderPhone').value.trim(),
        address: TF.$('orderAddress').value.trim(),
        order_type: TF.$('orderType').value,
        fulfillment_method: TF.$('fulfillmentMethod').value,
        expected_release_date: TF.$('expectedReleaseDate').value || null,
        shipping_fee_due: shippingFee(),
        actual_courier_cost: TF.$('fulfillmentMethod').value === 'jnt' && TF.$('courierCost').value.trim() !== '' ? TF.num(TF.$('courierCost').value) : 0,
        notes: TF.$('orderNotes').value.trim()
      };
      const items = parsedItems.map((item) => ({ sku: String(item.sku).toUpperCase(), size: String(item.size || '').toUpperCase(), quantity: TF.num(item.quantity), unit_price: TF.num(item.unit_price) }));
      const result = await TF.state.supa.rpc('update_order_v3', { p_order_id: editingOrderId, p_order: order, p_items: items });
      if (result.error) throw result.error;
      const shippingResult = await TF.state.supa.rpc('update_order_shipping', {
        p_order_id: editingOrderId,
        p_fulfillment_method: order.fulfillment_method,
        p_shipping_fee_due: order.shipping_fee_due,
        p_actual_courier_cost: TF.$('courierCost').value.trim() === '' ? null : TF.num(TF.$('courierCost').value)
      });
      if (shippingResult.error) throw shippingResult.error;
      TF.toast('Order changes saved');
      resetForm();
      await loadOrders();
    } catch (error) {
      TF.fail(error, 'Order changes not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  function filterRows() {
    const query = TF.$('orderSearch').value.trim().toLowerCase();
    const filter = TF.$('orderFilter').value;
    return orders.filter((order) => {
      const searchMatch = !query || [order.order_number, order.customer_name, order.phone, order.tracking_number, order.latest_payment_account_name, order.status].some((value) => String(value || '').toLowerCase().includes(query));
      if (!searchMatch) return false;
      if (filter === 'all') return true;
      if (filter === 'today') return order.order_date === TF.today();
      if (filter === 'awaiting') return ['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status);
      if (filter === 'paid') return ['paid', 'overpaid'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status);
      if (filter === 'packing') return ['confirmed', 'ready_to_pack', 'packing'].includes(order.status);
      if (filter === 'missing_tracking') return order.missing_tracking;
      if (filter === 'paid_late') return order.paid_not_shipped_alert;
      return order.status === filter;
    });
  }

  function quickActions(order) {
    const actions = [`<button class="btn small" data-action="view" data-id="${order.id}">Open</button>`];
    if (TF.can('confirm_payments') && ['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status)) actions.push(`<button class="btn primary small" data-action="pay" data-id="${order.id}">Confirm Payment</button>`);
    if (TF.can('update_tracking')) {
      if (['confirmed', 'ready_to_pack'].includes(order.status) || (order.status === 'waiting_stock' && TF.num(order.shortage_quantity) === 0)) actions.push(`<button class="btn small" data-action="packing" data-id="${order.id}">Start Packing</button>`);
      if (order.status === 'packing') actions.push(`<button class="btn primary small" data-action="ready" data-id="${order.id}">Ready to Ship</button>`);
      if (order.status === 'ready_to_ship') actions.push(`<button class="btn primary small" data-action="openTracking" data-id="${order.id}">Add Tracking</button>`);
      if (order.status === 'shipped') actions.push(`<button class="btn small" data-action="openTracking" data-id="${order.id}">${order.tracking_number ? 'Edit Tracking' : 'Add Tracking'}</button>`);
    }
    return actions.join('');
  }

  function renderOrders() {
    const rows = filterRows();
    TF.$('ordersTable').innerHTML = `
      <table><thead><tr><th>Order</th><th>Customer</th><th>Pieces</th><th>Total / Paid</th><th>Received in</th><th>Status</th><th>Tracking</th><th>Actions</th></tr></thead>
      <tbody>${rows.map((order) => `<tr class="${order.paid_not_shipped_alert || order.missing_tracking ? 'attention-row' : ''}">
        <td><strong>${TF.esc(order.order_number)}</strong><br><small>${TF.formatDate(order.order_date)}</small></td>
        <td>${TF.esc(order.customer_name)}<br><small>${TF.esc(order.phone || '')}</small></td>
        <td>${TF.num(order.total_quantity).toLocaleString()}</td>
        <td>${TF.money(order.total_due)}<br><small>${TF.money(order.verified_total_paid)} verified</small></td>
        <td>${TF.esc(order.latest_payment_account_name || '—')}<br><small>${TF.formatDate(order.latest_payment_date)}</small></td>
        <td>${TF.statusPill(order.payment_status)} ${TF.statusPill(order.status)}${order.shortage_quantity ? `<br><span class="pill danger">${order.shortage_quantity} short</span>` : (order.status === 'waiting_stock' ? '<br><span class="pill ok">Stock available now</span>' : '')}</td>
        <td>${order.tracking_number ? `<code>${TF.esc(order.tracking_number)}</code>` : '<span class="muted">Not available</span>'}${order.missing_tracking ? '<br><span class="pill danger">Missing</span>' : ''}</td>
        <td><div class="row-actions">${quickActions(order)}</div></td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">No orders found.</td></tr>'}</tbody></table>`;
  }

  async function loadOrders() {
    const result = await TF.state.supa.from('v_daily_ops_orders_v14').select('*').order('order_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000);
    if (result.error) throw result.error;
    orders = result.data || [];
    renderOrders();
    const openId = new URLSearchParams(location.search).get('open');
    if (openId) {
      history.replaceState({}, '', './orderpage.html');
      await openOrder(openId);
    }
  }

  function itemText(items) {
    return summarizeStoredItems(items).map((item) => `${item.category} ×${item.quantity} — ${TF.money(item.line_total)}`).join('\n');
  }

  function customerUpdate(order) {
    const tracking = order.tracking_number ? `\nTracking number: ${order.tracking_number}` : '';
    if (order.status === 'waiting_stock') return `Hi! Confirmed na po ang payment for ${order.order_number}. Waiting lang po tayo sa requested stock/design. We’ll update you once ready for packing.`;
    if (['confirmed', 'ready_to_pack'].includes(order.status)) return `Hi! Confirmed na po ang payment for ${order.order_number}. Ready na po ang stock and naka-queue na for packing.`;
    if (order.status === 'packing') return `Hi! Currently being packed na po ang order ${order.order_number}. We’ll send the tracking number once available.`;
    if (order.status === 'ready_to_ship') return `Hi! Ready to ship na po ang order ${order.order_number}. Waiting na lang po sa courier handoff and tracking number.`;
    if (order.status === 'shipped') return `Hi! Shipped na po ang order ${order.order_number} through ${String(order.fulfillment_method || '').toUpperCase().replace('_', '-')}.${tracking}\nThank you!`;
    if (order.status === 'delivered') return `Hi! Marked delivered na po ang order ${order.order_number}.${tracking}\nThank you for ordering!`;
    if (['unpaid', 'partial'].includes(order.payment_status)) return `Hi! Naka-record na po ang order ${order.order_number}. Payment status: ${TF.statusLabel(order.payment_status)}.`;
    return `Hi! Update for order ${order.order_number}: ${TF.statusLabel(order.status)}.`;
  }

  async function openOrder(id, focusPayment = false, focusTracking = false) {
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    const [itemsResult, activityResult] = await Promise.all([
      TF.state.supa.from('order_items').select('*').eq('order_id', id).order('line_number'),
      TF.state.supa.from('v_order_activity_v14').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(100)
    ]);
    if (itemsResult.error || activityResult.error) throw itemsResult.error || activityResult.error;
    activeOrder = order;
    activeItems = summarizeStoredItems(itemsResult.data || []);
    TF.$('detailTitle').textContent = `${order.order_number} — ${order.customer_name}`;
    TF.$('detailStatus').innerHTML = `${TF.statusPill(order.payment_status)} ${TF.statusPill(order.status)}`;
    TF.$('detailCustomer').textContent = order.customer_name || '—';
    TF.$('detailPhone').textContent = order.phone || '—';
    TF.$('detailAddress').textContent = order.address || '—';
    TF.$('detailOrderDate').textContent = TF.formatDate(order.order_date);
    TF.$('detailPieces').textContent = TF.num(order.total_quantity).toLocaleString();
    TF.$('detailTotal').textContent = TF.money(order.total_due);
    TF.$('detailPaid').textContent = TF.money(order.verified_total_paid);
    TF.$('detailAccount').textContent = order.latest_payment_account_name || '—';
    TF.$('detailTracking').textContent = order.tracking_number || 'Not available';
    TF.$('detailItems').innerHTML = activeItems.map((item) => `<div class="simple-line"><strong>${TF.esc(item.category)}</strong><span>${TF.num(item.quantity)} ${unitLabel(item.category_code, TF.num(item.quantity))} • ${TF.money(item.line_total)}</span></div>`).join('') || '<div class="empty">No items.</div>';
    const balance = Math.max(TF.num(order.remaining_balance), 0);
    TF.$('detailBalance').textContent = `Balance ${TF.money(balance)}`;
    TF.$('addPaymentSection').classList.toggle('hidden', !TF.can('confirm_payments') || balance <= 0 || ['cancelled', 'refunded'].includes(order.status));
    TF.$('addPaymentAmount').value = balance > 0 ? balance.toFixed(2) : '';
    TF.$('addPaymentDate').value = order.latest_payment_date || order.order_date || TF.today();
    TF.$('operationStatus').value = order.status;
    TF.$('operationMethod').value = order.fulfillment_method || 'unselected';
    TF.$('operationTracking').value = order.tracking_number || '';
    TF.$('operationShippedDate').value = order.shipped_at ? String(order.shipped_at).slice(0, 10) : '';
    TF.$('operationDeliveredDate').value = order.delivered_at ? String(order.delivered_at).slice(0, 10) : '';
    TF.$('operationCourierCost').value = order.courier_cost_finalized ? TF.num(order.actual_courier_cost).toFixed(2) : '';
    TF.$('operationCustomerNote').value = order.customer_update_note || '';
    TF.$('operationStatusNote').value = '';
    TF.$('customerUpdatePreview').textContent = customerUpdate(order);
    TF.$('activityList').innerHTML = (activityResult.data || []).map((activity) => `<div class="timeline-item"><span></span><div><strong>${TF.esc(activity.action.replaceAll('_', ' '))}</strong><small>${TF.formatDateTime(activity.created_at)} • ${TF.esc(activity.full_name || activity.email || 'System')}</small>${activity.old_status !== activity.new_status ? `<p>${TF.esc(TF.statusLabel(activity.old_status))} → ${TF.esc(TF.statusLabel(activity.new_status))}</p>` : ''}</div></div>`).join('') || '<div class="empty">No activity history yet.</div>';
    TF.$('detailRaw').textContent = order.raw_order_form || 'No original form saved.';
    TF.$('editOrderBtn').classList.toggle('hidden', !TF.can('edit_orders') || ['packing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(order.status));
    TF.$('cancelOrderBtn').classList.toggle('hidden', !TF.isManagement() || ['cancelled', 'refunded', 'delivered'].includes(order.status));
    TF.$('orderDialog').showModal();
    if (focusPayment && !TF.$('addPaymentSection').classList.contains('hidden')) TF.$('addPaymentAmount').focus();
    if (focusTracking) TF.$('operationTracking').focus();
  }

  async function confirmAdditionalPayment(event) {
    event.preventDefault();
    if (!activeOrder) return;
    const button = event.submitter;
    TF.setLoading(button, true, 'Confirming…');
    try {
      if (!TF.$('addPaymentAccount').value) throw new Error('Select the account where the payment entered.');
      const proof = await uploadProof(TF.$('addPaymentProof'));
      const result = await TF.state.supa.rpc('confirm_order_payment_v14', {
        p_order_id: activeOrder.id,
        p_payment_date: TF.$('addPaymentDate').value,
        p_amount: TF.num(TF.$('addPaymentAmount').value),
        p_payment_method: TF.$('addPaymentMethod').value,
        p_cash_account_id: TF.$('addPaymentAccount').value,
        p_reference_number: TF.$('addPaymentReference').value.trim(),
        p_proof_storage_path: proof,
        p_notes: null
      });
      if (result.error) throw result.error;
      TF.toast('Payment confirmed');
      TF.$('orderDialog').close();
      await loadOrders();
      await openOrder(activeOrder.id);
    } catch (error) {
      TF.fail(error, 'Payment not confirmed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function saveOperations(event) {
    event.preventDefault();
    if (!activeOrder) return;
    const button = event.submitter;
    TF.setLoading(button, true, 'Saving…');
    try {
      const result = await TF.state.supa.rpc('update_order_operations_v14', {
        p_order_id: activeOrder.id,
        p_status: TF.$('operationStatus').value,
        p_fulfillment_method: TF.$('operationMethod').value,
        p_tracking_number: TF.$('operationTracking').value,
        p_actual_courier_cost: TF.$('operationCourierCost').value.trim() === '' ? null : TF.num(TF.$('operationCourierCost').value),
        p_shipped_date: TF.$('operationShippedDate').value || null,
        p_delivered_date: TF.$('operationDeliveredDate').value || null,
        p_customer_update_note: TF.$('operationCustomerNote').value,
        p_status_note: TF.$('operationStatusNote').value
      });
      if (result.error) throw result.error;
      TF.toast('Status and tracking updated');
      const id = activeOrder.id;
      TF.$('orderDialog').close();
      await loadOrders();
      await openOrder(id);
    } catch (error) {
      TF.fail(error, 'Order update failed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function quickStatus(order, status) {
    const result = await TF.state.supa.rpc('update_order_operations_v14', {
      p_order_id: order.id,
      p_status: status,
      p_fulfillment_method: order.fulfillment_method,
      p_tracking_number: order.tracking_number,
      p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
      p_shipped_date: null,
      p_delivered_date: null,
      p_customer_update_note: order.customer_update_note,
      p_status_note: null
    });
    if (result.error) throw result.error;
    TF.toast(`Order marked ${TF.statusLabel(status)}`);
    await loadOrders();
  }

  async function tableAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const order = orders.find((row) => row.id === button.dataset.id);
    if (!order) return;
    try {
      if (button.dataset.action === 'view') await openOrder(order.id);
      if (button.dataset.action === 'pay') await openOrder(order.id, true, false);
      if (button.dataset.action === 'packing') await quickStatus(order, 'packing');
      if (button.dataset.action === 'ready') await quickStatus(order, 'ready_to_ship');
      if (button.dataset.action === 'openTracking') await openOrder(order.id, false, true);
    } catch (error) {
      TF.fail(error, 'Order action failed');
    }
  }

  async function cancelOrder() {
    if (!activeOrder) return;
    const reason = prompt('Cancellation reason:');
    if (!reason) return;
    if (!confirm(`Cancel ${activeOrder.order_number}? Reserved or committed stock will be released or returned.`)) return;
    const result = await TF.state.supa.rpc('cancel_order', { p_order_id: activeOrder.id, p_reason: reason });
    if (result.error) throw result.error;
    TF.toast('Order cancelled');
    TF.$('orderDialog').close();
    await loadOrders();
  }

  function applyQueryFilter() {
    const value = new URLSearchParams(location.search).get('filter');
    if (value && [...TF.$('orderFilter').options].some((option) => option.value === value)) TF.$('orderFilter').value = value;
  }

  TF.ready.then(async () => {
    fillBase();
    applyQueryFilter();
    renderItems();
    updateConditions();
    TF.$('parseOrderBtn').addEventListener('click', parseOrder);
    TF.$('addItemBtn').addEventListener('click', () => { parsedItems.push({ category_id: '', category_code: '', category: '', sku: '', quantity: 1, unit_price: 0, name: '' }); renderItems(); });
    TF.$('parsedItemsBody').addEventListener('input', editItem);
    TF.$('parsedItemsBody').addEventListener('change', editItem);
    TF.$('parsedItemsBody').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      parsedItems.splice(Number(button.dataset.remove), 1);
      renderItems();
    });
    TF.$('orderType').addEventListener('change', updateConditions);
    TF.$('fulfillmentMethod').addEventListener('change', updateConditions);
    TF.$('shippingFee').addEventListener('input', () => updateTotals(true));
    TF.$('saveAwaitingBtn').addEventListener('click', () => saveOrder(false));
    TF.$('saveConfirmBtn').addEventListener('click', () => saveOrder(true));
    TF.$('saveEditBtn').addEventListener('click', saveEdit);
    TF.$('cancelEditBtn').addEventListener('click', resetForm);
    TF.$('newOrderBtn').addEventListener('click', () => { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    TF.$('orderSearch').addEventListener('input', renderOrders);
    TF.$('orderFilter').addEventListener('change', renderOrders);
    TF.$('ordersTable').addEventListener('click', tableAction);
    TF.$('closeOrderDialog').addEventListener('click', () => TF.$('orderDialog').close());
    TF.$('closeOrderDialogBottom').addEventListener('click', () => TF.$('orderDialog').close());
    TF.$('addPaymentForm').addEventListener('submit', confirmAdditionalPayment);
    TF.$('operationsForm').addEventListener('submit', saveOperations);
    TF.$('copyOrderItemsBtn').addEventListener('click', () => TF.copyText(`${activeOrder.order_number} — ${activeOrder.customer_name}\n${itemText(activeItems)}`, 'Order details copied'));
    TF.$('copyCustomerUpdateBtn').addEventListener('click', () => TF.copyText(TF.$('customerUpdatePreview').textContent, 'Customer update copied'));
    TF.$('copyOriginalBtn').addEventListener('click', () => TF.copyText(activeOrder?.raw_order_form || '', 'Original order form copied'));
    TF.$('editOrderBtn').addEventListener('click', () => activeOrder && startEdit(activeOrder).catch((error) => TF.fail(error, 'Edit failed')));
    TF.$('cancelOrderBtn').addEventListener('click', () => cancelOrder().catch((error) => TF.fail(error, 'Cancellation failed')));
    window.addEventListener('twofly:refresh', () => loadOrders().catch((error) => TF.fail(error, 'Orders failed')));
    await loadOrders();
  }).catch((error) => TF.fail(error, 'Orders failed'));
})();
