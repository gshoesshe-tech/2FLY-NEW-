(() => {
  'use strict';
  const TF = window.TwoFly;
  const page = document.body.dataset.page || 'orders';
  const has = (id) => Boolean(TF.$(id));
  const isEntryPage = () => has('orderEntry');
  const isListPage = () => has('ordersTable');
  let parsedItems = [];
  let orders = [];
  let activeOrder = null;
  let activeItems = [];
  let editingOrderId = null;
  let lastExpected = 0;
  let paymentDatesByOrder = new Map();
  let orderItemsByOrder = new Map();
  const selectedOrderIds = new Set();
  const SAVED_FILTERS_KEY = '2fly.dailyOps.orderFilters.v1';

  function categoryCode(item) {
    return TF.state.categoryById.get(item?.category_id)?.code || item?.category_code || '';
  }

  function unitLabel(code, quantity) {
    if (code === 'EARRINGS') return quantity === 1 ? 'pair' : 'pairs';
    return 'pcs';
  }


  function isJnt(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    return String(method || '').toLowerCase() === 'jnt';
  }

  function hasFulfillment(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    return ['jnt', 'lalamove', 'walk_in'].includes(String(method || '').toLowerCase());
  }

  function fulfillmentText(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    if (method === 'jnt') return 'J&T';
    if (method === 'lalamove') return 'Lalamove';
    if (method === 'walk_in') return 'Walk-in / Pickup';
    return 'Not selected';
  }

  function needsTracking(order) {
    return isJnt(order) && ['ready_to_ship', 'shipped'].includes(order.status) && !String(order.tracking_number || '').trim();
  }

  function simpleStatus(order) {
    if (order?.status === 'delivered') return 'delivered';
    if (['packing', 'ready_to_ship', 'shipped'].includes(order?.status)) return 'processing';
    return 'pending';
  }

  function simpleStatusFromRaw(status) {
    if (status === 'delivered') return 'delivered';
    if (['packing', 'ready_to_ship', 'shipped'].includes(status)) return 'processing';
    return 'pending';
  }

  function simpleStatusLabel(value) {
    return value === 'delivered' ? 'Delivered' : value === 'processing' ? 'Processing' : 'Pending';
  }

  function simpleStatusPill(order) {
    const value = simpleStatus(order);
    const tone = value === 'delivered' ? 'ok' : value === 'processing' ? 'info' : 'warn';
    return `<span class="pill simple-order-status ${tone}">${simpleStatusLabel(value)}</span>`;
  }

  function fulfillmentBadge(value) {
    const method = typeof value === 'string' ? value : value?.fulfillment_method;
    const css = method === 'jnt' ? 'jnt' : method === 'lalamove' ? 'lalamove' : method === 'walk_in' ? 'walkin' : 'unselected';
    return `<span class="fulfillment-badge ${css}">${TF.esc(fulfillmentText(method))}</span>`;
  }

  function facebookUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^(?:www\.)?(?:facebook\.com|m\.facebook\.com|fb\.com|messenger\.com)\//i.test(raw)) return `https://${raw}`;
    if (/^@?[a-z0-9.]+$/i.test(raw)) return `https://www.facebook.com/${raw.replace(/^@/, '')}`;
    return `https://www.facebook.com/search/top?q=${encodeURIComponent(raw)}`;
  }

  function facebookLink(value, label = 'Open Facebook') {
    const url = facebookUrl(value);
    if (!url) return '';
    return `<a class="btn small" href="${TF.esc(url)}" target="_blank" rel="noopener noreferrer">${TF.esc(label)}</a>`;
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
    if (has('paymentAccount')) TF.$('paymentAccount').innerHTML = TF.accountOptions(true);
    if (has('addPaymentAccount')) TF.$('addPaymentAccount').innerHTML = TF.accountOptions(true);
    if (has('orderDate')) TF.$('orderDate').value = TF.today();
    if (has('paymentDate')) TF.$('paymentDate').value = TF.today();
    if (has('addPaymentDate')) TF.$('addPaymentDate').value = TF.today();
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
    const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const getField = (name) => {
      const regex = new RegExp(`^${escapeRegex(name)}\\s*:\\s*(.*)$`, 'i');
      const line = lines.find((value) => regex.test(value));
      return line ? line.match(regex)[1].trim() : '';
    };
    const getAnyField = (names) => names.map(getField).find(Boolean) || '';

    TF.$('orderCustomer').value = getField('Name');
    TF.$('orderPhone').value = getField('Phone');
    TF.$('orderFacebook').value = getAnyField([
      'Facebook Link / Profile', 'Facebook Link', 'Facebook Profile',
      'FB Link / Profile', 'FB Link', 'FB Profile', 'Messenger Link', 'Facebook'
    ]);
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

  function validatePaymentSubmission(method, accountId, reference, proofFile, amount) {
    if (TF.num(amount) <= 0) throw new Error('Enter the amount sent.');
    if (!accountId) throw new Error('Select the account where the customer says the payment entered.');
    if (method === 'gcash' && !String(reference || '').trim()) throw new Error('GCash reference number is required.');
    if (method === 'gcash' && !proofFile) throw new Error('Upload the GCash payment proof.');
  }

  async function saveOrder(submitPayment) {
    const button = submitPayment ? TF.$('saveSubmitBtn') : TF.$('saveAwaitingBtn');
    TF.setLoading(button, true, submitPayment ? 'Submitting…' : 'Saving…');
    try {
      validateItems();
      const amount = TF.num(TF.$('paymentAmount').value);
      if (submitPayment) validatePaymentSubmission(
        TF.$('paymentMethod').value,
        TF.$('paymentAccount').value,
        TF.$('paymentReference').value,
        TF.$('paymentProof').files?.[0],
        amount
      );
      const raw = TF.$('orderPaste').value.trim();
      const fingerprint = raw ? await TF.sha256(raw) : await TF.sha256(JSON.stringify({ phone: TF.$('orderPhone').value, date: TF.$('orderDate').value, items: parsedItems, total: productTotal() + shippingFee() }));
      if (!(await duplicateWarning(fingerprint))) return;
      const proof = submitPayment ? await uploadProof(TF.$('paymentProof')) : '';
      const order = {
        raw_order_form: raw,
        form_fingerprint: fingerprint,
        customer_name: TF.$('orderCustomer').value.trim(),
        phone: TF.$('orderPhone').value.trim(),
        facebook_profile: TF.$('orderFacebook').value.trim(),
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
      const payment = submitPayment ? {
        payment_date: TF.$('paymentDate').value || TF.today(),
        amount,
        payment_method: TF.$('paymentMethod').value,
        cash_account_id: TF.$('paymentAccount').value,
        reference_number: TF.$('paymentReference').value.trim(),
        proof_storage_path: proof,
        notes: null
      } : null;
      const result = submitPayment
        ? await TF.state.supa.rpc('create_order_with_payment_submission_v16', { p_order: order, p_items: items, p_payment: payment })
        : await TF.state.supa.rpc('create_daily_order_v14', { p_order: order, p_items: items, p_payment: null, p_confirm_payment: false });
      if (result.error) throw result.error;
      TF.toast(submitPayment ? 'Order saved and payment sent for verification' : 'Order saved as Awaiting Payment');
      const savedOrderId = result.data?.order_id || '';
      const savedOrderNumber = result.data?.order_number || '';
      resetForm();
      if (has('orderSaveSuccess')) {
        TF.$('orderEntry').classList.add('hidden');
        TF.$('orderSaveSuccess').classList.remove('hidden');
        TF.$('savedOrderMessage').textContent = savedOrderNumber ? `${savedOrderNumber} is now recorded.` : 'The order is now recorded.';
        TF.$('viewSavedOrderBtn').href = savedOrderId ? `./orderpage.html?open=${encodeURIComponent(savedOrderId)}` : './orderpage.html';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        await loadOrders();
        if (savedOrderId && has('orderDialog')) await openOrder(savedOrderId);
      }
    } catch (error) {
      TF.fail(error, 'Order not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  function resetForm() {
    if (!isEntryPage()) return;
    editingOrderId = null;
    if (has('orderSaveSuccess')) TF.$('orderSaveSuccess').classList.add('hidden');
    TF.$('orderEntry').classList.remove('hidden');
    parsedItems = [];
    ['orderPaste', 'orderCustomer', 'orderPhone', 'orderFacebook', 'orderAddress', 'orderNotes', 'paymentReference'].forEach((id) => { TF.$(id).value = ''; });
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
    TF.$('saveSubmitBtn').classList.toggle('hidden', !TF.can('create_orders'));
    TF.$('saveEditBtn').classList.add('hidden');
    ['paymentDate', 'paymentAmount', 'paymentMethod', 'paymentAccount', 'paymentReference', 'paymentProof', 'orderDate'].forEach((id) => { TF.$(id).disabled = false; });
    renderItems();
    updateConditions();
  }

  async function startEdit(order) {
    if (!TF.can('edit_orders')) throw new Error('You do not have permission to edit orders.');
    if (!isEntryPage()) {
      window.location.href = `./new-order.html?edit=${encodeURIComponent(order.id)}`;
      return;
    }
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
    TF.$('orderFacebook').value = order.facebook_profile || '';
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
    TF.$('saveSubmitBtn').classList.add('hidden');
    TF.$('saveEditBtn').classList.remove('hidden');
    ['paymentDate', 'paymentAmount', 'paymentMethod', 'paymentAccount', 'paymentReference', 'paymentProof'].forEach((id) => { TF.$(id).disabled = true; });
    renderItems();
    updateConditions();
    if (has('orderDialog') && TF.$('orderDialog').open) TF.$('orderDialog').close();
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
        facebook_profile: TF.$('orderFacebook').value.trim(),
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
      const savedId = editingOrderId;
      resetForm();
      if (has('orderSaveSuccess')) {
        TF.$('orderEntry').classList.add('hidden');
        TF.$('orderSaveSuccess').classList.remove('hidden');
        TF.$('savedOrderMessage').textContent = 'Order changes were saved successfully.';
        TF.$('viewSavedOrderBtn').href = `./orderpage.html?open=${encodeURIComponent(savedId)}`;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        await loadOrders();
      }
    } catch (error) {
      TF.fail(error, 'Order changes not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  function statusGroup(order) {
    return simpleStatus(order);
  }

  function filterRange() {
    const preset = TF.$('orderDatePreset').value;
    if (preset === 'custom') return { start: TF.$('orderStartDate').value, end: TF.$('orderEndDate').value };
    return TF.presetRange(preset);
  }

  function dateMatch(order, start, end) {
    if (!start && !end) return true;
    const basis = TF.$('orderDateBasis').value;
    if (basis === 'payment') return (paymentDatesByOrder.get(order.id) || []).some((date) => TF.dateInRange(date, start, end));
    if (basis === 'shipped') return TF.dateInRange(order.shipped_at, start, end);
    if (basis === 'delivered') return TF.dateInRange(order.delivered_at, start, end);
    return TF.dateInRange(order.order_date, start, end);
  }

  function filterState() {
    return {
      search: TF.$('orderSearch').value,
      date_basis: TF.$('orderDateBasis').value,
      date_preset: TF.$('orderDatePreset').value,
      start_date: TF.$('orderStartDate').value,
      end_date: TF.$('orderEndDate').value,
      status: TF.$('orderFilter').value,
      payment: TF.$('orderPaymentFilter').value,
      fulfillment: TF.$('orderFulfillmentFilter').value,
      sort: TF.$('orderSort').value
    };
  }

  function applyFilterState(state = {}) {
    const assign = (id, value) => { if (value !== undefined && TF.$(id)) TF.$(id).value = value; };
    assign('orderSearch', state.search || '');
    assign('orderDateBasis', state.date_basis || 'order');
    assign('orderDatePreset', state.date_preset || 'all');
    assign('orderStartDate', state.start_date || '');
    assign('orderEndDate', state.end_date || '');
    assign('orderFilter', state.status || 'all');
    assign('orderPaymentFilter', state.payment || 'all');
    assign('orderFulfillmentFilter', state.fulfillment || 'all');
    assign('orderSort', state.sort || 'newest_order');
    updateOrderDateControls();
  }

  function savedFilters() {
    try { return JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY) || '[]'); }
    catch { return []; }
  }

  function renderSavedFilters() {
    if (!has('savedFiltersSelect')) return;
    const filters = savedFilters();
    TF.$('savedFiltersSelect').innerHTML = '<option value="">Saved filters</option>' + filters.map((filter, index) => `<option value="${index}">${TF.esc(filter.name)}</option>`).join('');
  }

  function saveCurrentFilter() {
    const name = prompt('Name this filter:');
    if (!name?.trim()) return;
    const filters = savedFilters();
    const existing = filters.findIndex((filter) => filter.name.toLowerCase() === name.trim().toLowerCase());
    const record = { name: name.trim(), state: filterState() };
    if (existing >= 0) filters[existing] = record; else filters.push(record);
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(filters.slice(-20)));
    renderSavedFilters();
    TF.toast('Filter saved on this browser');
  }

  function deleteSavedFilter() {
    const value = TF.$('savedFiltersSelect').value;
    if (value === '') return TF.toast('Choose a saved filter first', true);
    const filters = savedFilters();
    filters.splice(Number(value), 1);
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(filters));
    renderSavedFilters();
    TF.toast('Saved filter deleted');
  }

  function sortRows(rows) {
    const sort = TF.$('orderSort').value;
    const earliestPayment = (order) => (paymentDatesByOrder.get(order.id) || [])[0] || '';
    const latestPayment = (order) => { const dates = paymentDatesByOrder.get(order.id) || []; return dates[dates.length - 1] || ''; };
    return [...rows].sort((a, b) => {
      if (sort === 'oldest_order') return String(a.order_date || '').localeCompare(String(b.order_date || '')) || String(a.created_at).localeCompare(String(b.created_at));
      if (sort === 'oldest_payment') return earliestPayment(a).localeCompare(earliestPayment(b)) || String(a.order_date || '').localeCompare(String(b.order_date || ''));
      if (sort === 'newest_payment') return latestPayment(b).localeCompare(latestPayment(a)) || String(b.order_date || '').localeCompare(String(a.order_date || ''));
      if (sort === 'oldest_status') return String(a.last_status_at || a.updated_at || '').localeCompare(String(b.last_status_at || b.updated_at || ''));
      return String(b.order_date || '').localeCompare(String(a.order_date || '')) || String(b.created_at).localeCompare(String(a.created_at));
    });
  }

  function filterRows() {
    const query = TF.$('orderSearch').value.trim().toLowerCase();
    const statusFilter = TF.$('orderFilter').value;
    const paymentFilter = TF.$('orderPaymentFilter').value;
    const fulfillment = TF.$('orderFulfillmentFilter').value;
    const { start, end } = filterRange();
    const rows = orders.filter((order) => {
      const searchMatch = !query || [order.order_number, order.customer_name, order.phone, order.facebook_profile, order.tracking_number, order.latest_payment_account_name, order.status, fulfillmentText(order)].some((value) => String(value || '').toLowerCase().includes(query));
      if (!searchMatch || !dateMatch(order, start, end)) return false;
      if (fulfillment !== 'all' && order.fulfillment_method !== fulfillment) return false;
      if (statusFilter !== 'all' && simpleStatus(order) !== statusFilter) return false;
      if (paymentFilter === 'verification' && TF.num(order.pending_payment_count) <= 0) return false;
      if (paymentFilter === 'unpaid' && (TF.num(order.pending_payment_count) > 0 || order.payment_status !== 'unpaid')) return false;
      if (paymentFilter === 'partial' && (TF.num(order.pending_payment_count) > 0 || order.payment_status !== 'partial')) return false;
      if (paymentFilter === 'paid' && !['paid', 'overpaid'].includes(order.payment_status)) return false;
      return true;
    });
    return sortRows(rows);
  }

  function orderAge(order) {
    let base = order.order_date;
    let label = 'Ordered';
    if (['confirmed', 'ready_to_pack', 'packing', 'waiting_stock', 'ready_to_ship'].includes(order.status) && order.latest_payment_date) { base = order.latest_payment_date; label = 'Paid'; }
    if (['packing', 'waiting_stock', 'ready_to_ship', 'shipped'].includes(order.status) && order.last_status_at) { base = order.last_status_at; label = 'Updated'; }
    const days = TF.daysBetween(base);
    return days === 0 ? `${label} today` : `${label} ${days} day${days === 1 ? '' : 's'} ago`;
  }

  function primaryStatus(order) {
    return simpleStatus(order);
  }

  function compactStatusPill(order) {
    return simpleStatusPill(order);
  }

  function categorySummary(order) {
    const items = orderItemsByOrder.get(order.id) || [];
    const grouped = new Map();
    items.forEach((item) => {
      const category = TF.state.categoryById.get(item.category_id);
      const name = String(category?.name || item.product_name || item.sku || 'Item').trim();
      grouped.set(name, (grouped.get(name) || 0) + TF.num(item.quantity));
    });
    const names = [...grouped.keys()];
    if (!names.length) return 'Category items';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names.join(' + ');
    return `${names[0]} +${names.length - 1} more`;
  }

  function quickMenuActions(order) {
    const actions = [];
    if (order.facebook_profile) actions.push(`<a href="${TF.esc(facebookUrl(order.facebook_profile))}" target="_blank" rel="noopener noreferrer">Open Facebook</a>`);
    if (TF.num(order.pending_payment_count) > 0 && TF.can('confirm_payments')) actions.push(`<button type="button" data-action="pay" data-id="${order.id}">Review Payment</button>`);
    if (!TF.num(order.pending_payment_count) && (TF.can('create_orders') || TF.can('edit_orders')) && ['unpaid', 'partial'].includes(order.payment_status) && !['cancelled', 'refunded'].includes(order.status)) actions.push(`<button type="button" data-action="pay" data-id="${order.id}">Submit Payment</button>`);
    if (TF.can('update_tracking') && simpleStatus(order) === 'pending' && hasFulfillment(order) && ['paid', 'overpaid'].includes(order.payment_status) && TF.num(order.shortage_quantity) <= 0) actions.push(`<button type="button" data-action="processing" data-id="${order.id}">Start Processing</button>`);
    if (TF.can('update_tracking') && simpleStatus(order) === 'processing') {
      if (isJnt(order) && !order.tracking_number) actions.push(`<button type="button" data-action="openTracking" data-id="${order.id}">Add J&T Tracking</button>`);
      else actions.push(`<button type="button" data-action="complete" data-id="${order.id}">Mark Delivered</button>`);
    }
    if (isJnt(order) && order.tracking_number) actions.push(`<button type="button" data-action="openTracking" data-id="${order.id}">Edit J&T Tracking</button>`);
    return actions.join('') || '<span class="order-menu-empty">No quick actions</span>';
  }

  function primaryOrderAction(order) {
    if (['cancelled', 'refunded'].includes(order.status)) return `<span class="action-state cancelled">Cancelled</span>`;
    if (simpleStatus(order) === 'delivered') return `<span class="action-state completed">Completed</span>`;
    if (TF.num(order.pending_payment_count) > 0) return `<button class="btn primary small" data-action="pay" data-id="${order.id}">Review Payment</button>`;
    if ((TF.can('create_orders') || TF.can('edit_orders')) && ['unpaid', 'partial'].includes(order.payment_status)) return `<button class="btn primary small" data-action="pay" data-id="${order.id}">Submit Payment</button>`;
    if (!TF.can('update_tracking')) return `<button class="btn small order-view-btn" data-action="view" data-id="${order.id}">View</button>`;
    if (simpleStatus(order) === 'pending') {
      if (!hasFulfillment(order)) return `<button class="btn primary small" data-action="view" data-id="${order.id}">Set Fulfillment</button>`;
      if (TF.num(order.shortage_quantity) > 0) return `<button class="btn small order-view-btn" data-action="view" data-id="${order.id}">View Order</button>`;
      return `<button class="btn primary small" data-action="processing" data-id="${order.id}">Start Processing</button>`;
    }
    if (simpleStatus(order) === 'processing') {
      if (isJnt(order) && !order.tracking_number) return `<button class="btn primary small" data-action="openTracking" data-id="${order.id}">Add Tracking</button>`;
      return `<button class="btn primary small" data-action="complete" data-id="${order.id}">Mark Delivered</button>`;
    }
    return `<button class="btn small order-view-btn" data-action="view" data-id="${order.id}">View</button>`;
  }

  function orderActions(order) {
    return `<div class="clean-order-actions">
      ${primaryOrderAction(order)}
      <button class="btn small order-view-btn" data-action="view" data-id="${order.id}">View</button>
      <details class="order-more-menu">
        <summary aria-label="More actions">⋮</summary>
        <div class="order-more-panel">${quickMenuActions(order)}</div>
      </details>
    </div>`;
  }

  function updateBulkBar() {
    if (!has('bulkOrderBar')) return;
    const count = selectedOrderIds.size;
    TF.$('bulkOrderBar').classList.toggle('hidden', count === 0);
    TF.$('bulkSelectedCount').textContent = `${count} selected`;
  }

  function renderOrders() {
    if (!isListPage()) return;
    const rows = filterRows();
    [...selectedOrderIds].forEach((id) => { if (!orders.some((order) => order.id === id)) selectedOrderIds.delete(id); });
    TF.$('orderResultCount').textContent = `${rows.length.toLocaleString()} order${rows.length === 1 ? '' : 's'}`;
    TF.$('ordersTable').className = 'table-wrap orders-clean-table-wrap';
    TF.$('ordersTable').innerHTML = `
      <table class="orders-clean-table simple-orders-table">
        <colgroup>
          <col class="col-select"><col class="col-order"><col class="col-customer"><col class="col-fulfillment"><col class="col-status"><col class="col-payment"><col class="col-items"><col class="col-total"><col class="col-tracking"><col class="col-date"><col class="col-actions">
        </colgroup>
        <thead><tr>
          <th><input id="selectAllOrders" type="checkbox" aria-label="Select all visible orders" ${rows.length && rows.every((row) => selectedOrderIds.has(row.id)) ? 'checked' : ''}></th>
          <th>Order</th><th>Customer</th><th>Fulfillment</th><th>Status</th><th>Payment</th><th>Items</th><th>Total</th><th>Tracking</th><th>Date</th><th>Action</th>
        </tr></thead>
        <tbody>${rows.map((order) => {
          const alert = order.paid_not_shipped_alert || needsTracking(order);
          const paid = ['paid', 'overpaid'].includes(order.payment_status);
          return `<tr data-open-row="${order.id}" class="clean-order-row ${alert ? 'attention-row' : ''} ${['cancelled', 'refunded'].includes(order.status) ? 'cancelled-order-row' : ''}">
            <td data-label="Select"><input type="checkbox" data-select-order="${order.id}" ${selectedOrderIds.has(order.id) ? 'checked' : ''}></td>
            <td data-label="Order"><strong class="order-number-text">${TF.esc(order.order_number)}</strong><small>${TF.formatDate(order.order_date)}</small>${['cancelled', 'refunded'].includes(order.status) ? '<span class="cancelled-mini">Cancelled</span>' : ''}</td>
            <td data-label="Customer"><strong class="customer-name-text">${TF.esc(order.customer_name)}</strong><div class="customer-subline"><span>${TF.esc(order.phone || 'No phone')}</span>${order.facebook_profile ? `<a class="facebook-mini-link" href="${TF.esc(facebookUrl(order.facebook_profile))}" target="_blank" rel="noopener noreferrer" title="Open Facebook profile">f</a>` : ''}</div></td>
            <td data-label="Fulfillment">${fulfillmentBadge(order)}</td>
            <td data-label="Status">${simpleStatusPill(order)}</td>
            <td data-label="Payment">${TF.num(order.pending_payment_count) > 0
              ? `<span class="payment-state is-submitted">For Verification</span><small>${TF.esc(order.latest_submission_account_name || 'Submitted account')}</small>`
              : `<span class="payment-state ${paid ? 'is-paid' : order.payment_status === 'partial' ? 'is-partial' : 'is-unpaid'}">${TF.esc(TF.statusLabel(order.payment_status))}</span><small>${TF.esc(order.latest_payment_account_name || 'No account')}</small>`}</td>
            <td data-label="Items"><strong>${TF.num(order.total_quantity).toLocaleString()} ${TF.num(order.total_quantity) === 1 ? 'pc' : 'pcs'}</strong><small title="${TF.esc(categorySummary(order))}">${TF.esc(categorySummary(order))}</small></td>
            <td data-label="Total"><strong>${TF.money(order.total_due)}</strong><small>${paid ? `${TF.money(order.verified_total_paid)} paid` : `${TF.money(order.verified_total_paid)} received`}</small></td>
            <td data-label="Tracking">${isJnt(order) ? (order.tracking_number ? `<code class="tracking-code">${TF.esc(order.tracking_number)}</code>` : `<span class="tracking-empty">No tracking yet</span>`) : `<span class="tracking-not-required">Not required</span>`}</td>
            <td data-label="Date"><strong>${TF.formatDate(order.order_date)}</strong><small>${TF.esc(orderAge(order))}</small></td>
            <td data-label="Action">${orderActions(order)}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="11" class="empty">No orders found.</td></tr>'}</tbody>
      </table>`;
    updateBulkBar();
  }

  async function loadOrders() {
    const params = new URLSearchParams(location.search);
    const editId = params.get('edit');
    const openId = params.get('open');
    const needsData = isListPage() || Boolean(editId) || Boolean(openId) || has('orderDialog');
    if (!needsData) return;
    const [ordersResult, paymentsResult, itemsResult] = await Promise.all([
      TF.state.supa.from('v_daily_ops_orders_v16').select('*').order('order_date', { ascending: false }).order('created_at', { ascending: false }).limit(10000),
      TF.state.supa.from('payments').select('order_id,payment_date,status').eq('status', 'verified').order('payment_date', { ascending: true }).limit(30000),
      TF.state.supa.from('order_items').select('order_id,category_id,product_name,sku,quantity').limit(50000)
    ]);
    if (ordersResult.error || paymentsResult.error || itemsResult.error) throw ordersResult.error || paymentsResult.error || itemsResult.error;
    orders = ordersResult.data || [];
    orderItemsByOrder = new Map();
    (itemsResult.data || []).forEach((item) => {
      const current = orderItemsByOrder.get(item.order_id) || [];
      current.push(item);
      orderItemsByOrder.set(item.order_id, current);
    });
    paymentDatesByOrder = new Map();
    (paymentsResult.data || []).forEach((payment) => {
      const dates = paymentDatesByOrder.get(payment.order_id) || [];
      if (!dates.includes(payment.payment_date)) dates.push(payment.payment_date);
      paymentDatesByOrder.set(payment.order_id, dates.sort());
    });
    if (isListPage()) renderOrders();
    if (editId && isEntryPage()) {
      const order = orders.find((row) => row.id === editId);
      history.replaceState({}, '', './new-order.html');
      if (!order) throw new Error('Order to edit was not found.');
      await startEdit(order);
      return;
    }
    const focus = params.get('focus');
    if (openId && has('orderDialog')) {
      history.replaceState({}, '', './orderpage.html');
      await openOrder(openId, focus === 'payment', focus === 'tracking');
    }
  }

  function itemText(items) {
    return summarizeStoredItems(items).map((item) => `${item.category} ×${item.quantity} — ${TF.money(item.line_total)}`).join('\n');
  }

  function customerUpdate(order) {
    const status = simpleStatus(order);
    const method = fulfillmentText(order);
    const tracking = isJnt(order) && order.tracking_number ? `
Tracking number: ${order.tracking_number}` : '';
    if (TF.num(order.pending_payment_count) > 0) return `Hi! Nareceive na po namin ang payment details for ${order.order_number}. For verification pa po ito. We’ll update you once confirmed.`;
    if (status === 'pending') return `Hi! Pending pa po ang order ${order.order_number}. We’ll update you once processing na.`;
    if (status === 'processing') return isJnt(order)
      ? `Hi! Processing na po ang order ${order.order_number} for J&T.${tracking}`
      : `Hi! Processing na po ang order ${order.order_number} for ${method}. No tracking number is needed for this method.`;
    return isJnt(order)
      ? `Hi! Delivered na po ang order ${order.order_number}.${tracking}
Thank you for ordering!`
      : `Hi! Completed na po ang order ${order.order_number} through ${method}. Thank you for ordering!`;
  }

  function updateOperationTrackingRule() {
    if (!has('operationMethod') || !has('operationTracking')) return;
    const jnt = isJnt(TF.$('operationMethod').value);
    const input = TF.$('operationTracking');
    input.disabled = !jnt;
    input.placeholder = jnt ? 'Enter J&T tracking when available' : 'Not required for this method';
    if (!jnt) input.value = '';
    TF.$('operationTrackingWrap')?.classList.toggle('tracking-disabled-field', !jnt);
    const help = TF.$('operationTrackingHelp');
    if (help) help.textContent = jnt ? 'Only J&T orders use a tracking number.' : `${fulfillmentText(TF.$('operationMethod').value)} orders do not need a tracking number.`;
  }

  async function proofButton(path) {
    if (!path) return '';
    const result = await TF.state.supa.storage.from('payment-proofs').createSignedUrl(path, 3600);
    if (result.error || !result.data?.signedUrl) return '<span class="muted">Proof unavailable</span>';
    return `<a class="btn small" href="${TF.esc(result.data.signedUrl)}" target="_blank" rel="noopener noreferrer">View Proof</a>`;
  }

  async function renderPaymentSubmissions(payments) {
    const pending = payments.filter((payment) => payment.status === 'submitted');
    TF.$('pendingPaymentCount').textContent = `${pending.length} waiting`;
    const cards = [];
    for (const payment of payments) {
      const proof = await proofButton(payment.proof_storage_path);
      const reviewActions = payment.status === 'submitted' && payment.can_current_user_review
        ? `<button class="btn primary small" data-review-payment="confirm" data-payment-id="${payment.payment_id}">Confirm</button><button class="btn danger small" data-review-payment="reject" data-payment-id="${payment.payment_id}">Reject</button>`
        : '';
      cards.push(`<article class="payment-submission-card ${TF.esc(payment.status)}">
        <div class="payment-submission-head"><div><strong>${TF.money(payment.amount)}</strong><span>${TF.statusPill(payment.status)}</span></div><small>${TF.formatDate(payment.payment_date)} • ${TF.esc(payment.cash_account_name || 'Unknown account')}</small></div>
        <div class="payment-submission-grid">
          <div><span>Reference</span><strong>${TF.esc(payment.reference_number || '—')}</strong></div>
          <div><span>Submitted by</span><strong>${TF.esc(payment.submitted_by_name || payment.submitted_by_email || '—')}</strong></div>
          <div><span>Submitted</span><strong>${TF.formatDateTime(payment.submitted_at)}</strong></div>
          <div><span>Reviewed by</span><strong>${TF.esc(payment.reviewed_by_name || payment.reviewed_by_email || '—')}</strong></div>
        </div>
        ${payment.notes ? `<p class="payment-submission-note">${TF.esc(payment.notes)}</p>` : ''}
        ${payment.rejection_reason ? `<div class="notice danger">Rejected: ${TF.esc(payment.rejection_reason)}</div>` : ''}
        <div class="payment-submission-actions">${proof}${reviewActions}</div>
      </article>`);
    }
    TF.$('paymentSubmissionsList').innerHTML = cards.join('') || '<div class="empty">No payment details submitted yet.</div>';
  }

  async function openOrder(id, focusPayment = false, focusTracking = false) {
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    const [itemsResult, activityResult, paymentsResult] = await Promise.all([
      TF.state.supa.from('order_items').select('*').eq('order_id', id).order('line_number'),
      TF.state.supa.from('v_order_activity_v14').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(100),
      TF.state.supa.from('v_payment_verification_queue_v16').select('*').eq('order_id', id).order('submitted_at', { ascending: false, nullsFirst: false }).order('payment_date', { ascending: false })
    ]);
    if (itemsResult.error || activityResult.error || paymentsResult.error) throw itemsResult.error || activityResult.error || paymentsResult.error;
    activeOrder = order;
    activeItems = summarizeStoredItems(itemsResult.data || []);
    TF.$('detailTitle').textContent = `${order.order_number} — ${order.customer_name}`;
    TF.$('detailStatus').innerHTML = `${simpleStatusPill(order)} ${TF.num(order.pending_payment_count) > 0 ? TF.statusPill('submitted') : TF.statusPill(order.payment_status)}`;
    TF.$('detailCustomer').textContent = order.customer_name || '—';
    TF.$('detailPhone').textContent = order.phone || '—';
    TF.$('detailFacebook').innerHTML = order.facebook_profile ? `${TF.esc(order.facebook_profile)}<br>${facebookLink(order.facebook_profile, 'Open Facebook / Messenger')}` : '—';
    TF.$('detailAddress').textContent = order.address || '—';
    TF.$('detailOrderDate').textContent = TF.formatDate(order.order_date);
    TF.$('detailPieces').textContent = TF.num(order.total_quantity).toLocaleString();
    TF.$('detailTotal').textContent = TF.money(order.total_due);
    TF.$('detailPaid').textContent = TF.money(order.verified_total_paid);
    TF.$('detailAccount').textContent = order.latest_payment_account_name || '—';
    if (has('detailFulfillment')) TF.$('detailFulfillment').innerHTML = fulfillmentBadge(order);
    TF.$('detailTracking').textContent = isJnt(order) ? (order.tracking_number || 'Not available yet') : 'Not required';
    TF.$('detailItems').innerHTML = activeItems.map((item) => `<div class="simple-line"><strong>${TF.esc(item.category)}</strong><span>${TF.num(item.quantity)} ${unitLabel(item.category_code, TF.num(item.quantity))} • ${TF.money(item.line_total)}</span></div>`).join('') || '<div class="empty">No items.</div>';
    const balance = Math.max(TF.num(order.remaining_balance), 0);
    TF.$('detailBalance').textContent = `Verified balance ${TF.money(balance)}`;
    TF.$('addPaymentSection').classList.toggle('hidden', !(TF.can('create_orders') || TF.can('edit_orders') || TF.can('confirm_payments')) || balance <= 0 || ['cancelled', 'refunded', 'delivered'].includes(order.status));
    TF.$('addPaymentAmount').value = balance > 0 ? balance.toFixed(2) : '';
    TF.$('addPaymentDate').value = TF.today();
    TF.$('addPaymentReference').value = '';
    TF.$('addPaymentProof').value = '';
    TF.$('addPaymentNotes').value = '';
    await renderPaymentSubmissions(paymentsResult.data || []);
    TF.$('operationStatus').value = simpleStatus(order);
    TF.$('operationMethod').value = order.fulfillment_method || 'unselected';
    TF.$('operationTracking').value = isJnt(order) ? (order.tracking_number || '') : '';
    updateOperationTrackingRule();
    TF.$('operationShippedDate').value = order.shipped_at ? String(order.shipped_at).slice(0, 10) : '';
    TF.$('operationDeliveredDate').value = order.delivered_at ? String(order.delivered_at).slice(0, 10) : '';
    TF.$('operationCourierCost').value = order.courier_cost_finalized ? TF.num(order.actual_courier_cost).toFixed(2) : '';
    TF.$('operationCustomerNote').value = order.customer_update_note || '';
    TF.$('operationStatusNote').value = '';
    TF.$('customerUpdatePreview').textContent = customerUpdate(order);
    TF.$('activityList').innerHTML = (activityResult.data || []).map((activity) => `<div class="timeline-item"><span></span><div><strong>${TF.esc(activity.action.replaceAll('_', ' '))}</strong><small>${TF.formatDateTime(activity.created_at)} • ${TF.esc(activity.full_name || activity.email || 'System')}</small>${activity.old_status !== activity.new_status && simpleStatusFromRaw(activity.old_status) !== simpleStatusFromRaw(activity.new_status) ? `<p>${simpleStatusLabel(simpleStatusFromRaw(activity.old_status))} → ${simpleStatusLabel(simpleStatusFromRaw(activity.new_status))}</p>` : ''}</div></div>`).join('') || '<div class="empty">No activity history yet.</div>';
    TF.$('detailRaw').textContent = order.raw_order_form || 'No original form saved.';
    TF.$('editOrderBtn').classList.toggle('hidden', !TF.can('edit_orders') || ['packing', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(order.status));
    TF.$('cancelOrderBtn').classList.toggle('hidden', !TF.isManagement() || ['cancelled', 'refunded', 'delivered'].includes(order.status));
    TF.$('orderDialog').showModal();
    if (focusPayment) {
      const pendingCard = TF.$('paymentSubmissionsList').querySelector('.payment-submission-card.submitted');
      if (pendingCard) pendingCard.scrollIntoView({ block: 'center' });
      else if (!TF.$('addPaymentSection').classList.contains('hidden')) TF.$('addPaymentAmount').focus();
    }
    if (focusTracking) { if (isJnt(order)) TF.$('operationTracking').focus(); else TF.$('operationStatus').focus(); }
  }

  async function submitAdditionalPayment(event) {
    event.preventDefault();
    if (!activeOrder) return;
    const button = event.submitter;
    TF.setLoading(button, true, 'Submitting…');
    try {
      validatePaymentSubmission(
        TF.$('addPaymentMethod').value,
        TF.$('addPaymentAccount').value,
        TF.$('addPaymentReference').value,
        TF.$('addPaymentProof').files?.[0],
        TF.$('addPaymentAmount').value
      );
      const proof = await uploadProof(TF.$('addPaymentProof'));
      const orderId = activeOrder.id;
      const result = await TF.state.supa.rpc('submit_order_payment_v16', {
        p_order_id: orderId,
        p_payment_date: TF.$('addPaymentDate').value,
        p_amount: TF.num(TF.$('addPaymentAmount').value),
        p_payment_method: TF.$('addPaymentMethod').value,
        p_cash_account_id: TF.$('addPaymentAccount').value,
        p_reference_number: TF.$('addPaymentReference').value.trim(),
        p_proof_storage_path: proof,
        p_notes: TF.$('addPaymentNotes').value.trim() || null
      });
      if (result.error) throw result.error;
      TF.toast('Payment sent for verification');
      TF.$('orderDialog').close();
      await loadOrders();
      await openOrder(orderId, true, false);
    } catch (error) {
      TF.fail(error, 'Payment not submitted');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function reviewPayment(button) {
    const paymentId = button.dataset.paymentId;
    const decision = button.dataset.reviewPayment;
    const reason = decision === 'reject' ? prompt('Why is this payment being rejected?') : null;
    if (decision === 'reject' && !reason?.trim()) return;
    if (decision === 'confirm' && !confirm('Confirm that this payment is visible in the selected account?')) return;
    TF.setLoading(button, true, decision === 'confirm' ? 'Confirming…' : 'Rejecting…');
    try {
      const orderId = activeOrder?.id;
      const result = await TF.state.supa.rpc('review_submitted_payment_v16', {
        p_payment_id: paymentId,
        p_decision: decision,
        p_rejection_reason: reason
      });
      if (result.error) throw result.error;
      TF.toast(decision === 'confirm' ? 'Payment verified and inventory updated' : 'Payment submission rejected');
      TF.$('orderDialog').close();
      await loadOrders();
      if (orderId) await openOrder(orderId, true, false);
    } catch (error) {
      TF.fail(error, 'Payment review failed');
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
      const method = TF.$('operationMethod').value;
      const desired = TF.$('operationStatus').value;
      const tracking = isJnt(method) ? TF.$('operationTracking').value.trim() : '';
      if (['processing', 'delivered'].includes(desired) && !hasFulfillment(method)) throw new Error('Select J&T, Lalamove, or Walk-in / Pickup first.');
      if (desired === 'processing' && (!['paid', 'overpaid'].includes(activeOrder.payment_status) || TF.num(activeOrder.pending_payment_count) > 0)) throw new Error('Verify the full payment before starting processing.');
      if (desired === 'processing' && TF.num(activeOrder.shortage_quantity) > 0) throw new Error('This order is still short on stock.');
      if (desired === 'delivered' && (!['paid', 'overpaid'].includes(activeOrder.payment_status) || TF.num(activeOrder.pending_payment_count) > 0)) throw new Error('Verify the full payment before marking delivered.');
      if (desired === 'delivered' && TF.num(activeOrder.shortage_quantity) > 0) throw new Error('This order is still short on stock.');
      if (desired === 'delivered' && isJnt(method) && !tracking) throw new Error('Add the J&T tracking number before marking the order delivered.');

      const common = {
        p_order_id: activeOrder.id,
        p_fulfillment_method: method,
        p_tracking_number: tracking,
        p_actual_courier_cost: TF.$('operationCourierCost').value.trim() === '' ? null : TF.num(TF.$('operationCourierCost').value),
        p_customer_update_note: TF.$('operationCustomerNote').value,
        p_status_note: TF.$('operationStatusNote').value || `Simple status updated to ${simpleStatusLabel(desired)}`
      };

      if (desired === 'delivered') {
        if (activeOrder.status !== 'shipped') {
          const shippedResult = await TF.state.supa.rpc('update_order_operations_v14', {
            ...common,
            p_status: 'shipped',
            p_shipped_date: activeOrder.shipped_at ? String(activeOrder.shipped_at).slice(0, 10) : TF.today(),
            p_delivered_date: null
          });
          if (shippedResult.error) throw shippedResult.error;
        }
        const deliveredResult = await TF.state.supa.rpc('update_order_operations_v14', {
          ...common,
          p_status: 'delivered',
          p_shipped_date: activeOrder.shipped_at ? String(activeOrder.shipped_at).slice(0, 10) : TF.today(),
          p_delivered_date: TF.today()
        });
        if (deliveredResult.error) throw deliveredResult.error;
      } else {
        let targetStatus = activeOrder.status;
        if (desired === 'processing') targetStatus = ['packing', 'ready_to_ship', 'shipped'].includes(activeOrder.status) ? activeOrder.status : 'packing';
        if (desired === 'pending' && simpleStatus(activeOrder) !== 'pending') targetStatus = ['paid', 'overpaid'].includes(activeOrder.payment_status) ? 'ready_to_pack' : 'draft';
        const result = await TF.state.supa.rpc('update_order_operations_v14', {
          ...common,
          p_status: targetStatus,
          p_shipped_date: targetStatus === 'shipped' ? (activeOrder.shipped_at ? String(activeOrder.shipped_at).slice(0, 10) : TF.today()) : null,
          p_delivered_date: null
        });
        if (result.error) throw result.error;
      }
      TF.toast(`Order marked ${simpleStatusLabel(desired)}`);
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

  async function quickStatus(order, status, quiet = false) {
    const result = await TF.state.supa.rpc('update_order_operations_v14', {
      p_order_id: order.id,
      p_status: status,
      p_fulfillment_method: order.fulfillment_method,
      p_tracking_number: isJnt(order) ? order.tracking_number : '',
      p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
      p_shipped_date: ['shipped', 'delivered'].includes(status) ? (order.shipped_at ? String(order.shipped_at).slice(0, 10) : TF.today()) : null,
      p_delivered_date: status === 'delivered' ? TF.today() : null,
      p_customer_update_note: order.customer_update_note,
      p_status_note: `Simple status update: ${simpleStatusLabel(simpleStatusFromRaw(status))}`
    });
    if (result.error) throw result.error;
    if (!quiet) TF.toast(`Order marked ${simpleStatusLabel(simpleStatusFromRaw(status))}`);
    await loadOrders();
  }

  async function completeOrder(order) {
    if (isJnt(order) && !String(order.tracking_number || '').trim()) {
      TF.toast('Add the J&T tracking number first', true);
      await openOrder(order.id, false, true);
      return;
    }
    if (!confirm(`Mark ${order.order_number} as delivered/completed?`)) return;
    if (order.status !== 'shipped') {
      await quickStatus(order, 'shipped', true);
      order = orders.find((row) => row.id === order.id) || order;
    }
    await quickStatus(order, 'delivered');
  }

  async function tableAction(event) {
    if (event.target.id === 'selectAllOrders') {
      const rows = filterRows();
      if (event.target.checked) rows.forEach((order) => selectedOrderIds.add(order.id));
      else rows.forEach((order) => selectedOrderIds.delete(order.id));
      renderOrders();
      return;
    }
    const selector = event.target.closest('[data-select-order]');
    if (selector) {
      if (selector.checked) selectedOrderIds.add(selector.dataset.selectOrder);
      else selectedOrderIds.delete(selector.dataset.selectOrder);
      updateBulkBar();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (button) {
      const order = orders.find((row) => row.id === button.dataset.id);
      if (!order) return;
      try {
        if (button.dataset.action === 'view') await openOrder(order.id);
        if (button.dataset.action === 'pay') await openOrder(order.id, true, false);
        if (button.dataset.action === 'processing') {
          if (!hasFulfillment(order)) TF.toast('Set the fulfillment method first', true);
          else if (!['paid', 'overpaid'].includes(order.payment_status) || TF.num(order.pending_payment_count) > 0) TF.toast('Verify the full payment first', true);
          else if (TF.num(order.shortage_quantity) > 0) TF.toast('This order is still short on stock', true);
          else await quickStatus(order, 'packing');
        }
        if (button.dataset.action === 'openTracking') await openOrder(order.id, false, true);
        if (button.dataset.action === 'shipped') {
          if (isJnt(order) && !order.tracking_number) {
            TF.toast('Add the J&T tracking number first', true);
            await openOrder(order.id, false, true);
          } else if (confirm(`Mark ${order.order_number} as shipped/released?`)) {
            await quickStatus(order, 'shipped', true);
          }
        }
        if (button.dataset.action === 'complete') await completeOrder(order);
      } catch (error) {
        TF.fail(error, 'Order action failed');
      }
      return;
    }
    const row = event.target.closest('tr[data-open-row]');
    if (row && !event.target.closest('a,button,input,select,textarea,details,summary')) {
      await openOrder(row.dataset.openRow);
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

  function updateOrderDateControls() {
    const custom = TF.$('orderDatePreset').value === 'custom';
    TF.$('orderStartWrap').classList.toggle('hidden', !custom);
    TF.$('orderEndWrap').classList.toggle('hidden', !custom);
  }

  function clearOrderFilters() {
    applyFilterState({});
    selectedOrderIds.clear();
    TF.$('savedFiltersSelect').value = '';
    renderOrders();
  }

  async function applyBulkAction() {
    const action = TF.$('bulkOrderAction').value;
    const selected = orders.filter((order) => selectedOrderIds.has(order.id));
    if (!action) return TF.toast('Choose a bulk action first', true);
    if (!selected.length) return TF.toast('Select at least one order', true);
    const label = { processing: 'start processing', delivered: 'mark delivered', set_courier: 'set fulfillment' }[action];
    if (!confirm(`${label} for ${selected.length} selected order${selected.length === 1 ? '' : 's'}?`)) return;
    const button = TF.$('applyBulkOrderAction');
    TF.setLoading(button, true, 'Applying…');
    const errors = [];
    try {
      for (let order of selected) {
        try {
          if (action === 'processing') {
            if (!hasFulfillment(order)) throw new Error('fulfillment is not selected');
            if (!['paid', 'overpaid'].includes(order.payment_status) || TF.num(order.pending_payment_count) > 0) throw new Error('payment is not fully verified');
            if (TF.num(order.shortage_quantity) > 0) throw new Error('stock is short');
            await quickStatus(order, 'packing');
          } else if (action === 'delivered') {
            if (simpleStatus(order) !== 'processing') throw new Error('start processing first');
            if (isJnt(order) && !order.tracking_number) throw new Error('J&T tracking is missing');
            if (order.status !== 'shipped') await quickStatus(order, 'shipped', true);
            order = orders.find((row) => row.id === order.id) || order;
            await quickStatus(order, 'delivered');
          } else if (action === 'set_courier') {
            const method = TF.$('bulkCourier').value;
            const result = await TF.state.supa.rpc('update_order_operations_v14', {
              p_order_id: order.id,
              p_status: order.status,
              p_fulfillment_method: method,
              p_tracking_number: isJnt(method) ? order.tracking_number : '',
              p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
              p_shipped_date: order.shipped_at ? String(order.shipped_at).slice(0, 10) : null,
              p_delivered_date: order.delivered_at ? String(order.delivered_at).slice(0, 10) : null,
              p_customer_update_note: order.customer_update_note,
              p_status_note: 'Fulfillment updated from Orders page'
            });
            if (result.error) throw result.error;
          }
        } catch (error) {
          errors.push(`${order.order_number}: ${error.message}`);
        }
      }
      selectedOrderIds.clear();
      await loadOrders();
      if (errors.length) {
        console.warn('Bulk action errors', errors);
        TF.toast(`${selected.length - errors.length} updated; ${errors.length} failed`, true);
      } else {
        TF.toast(`${selected.length} order${selected.length === 1 ? '' : 's'} updated`);
      }
    } finally {
      TF.setLoading(button, false);
    }
  }

  function applyQueryFilter() {
    if (!isListPage()) return;
    const params = new URLSearchParams(location.search);
    const value = params.get('filter');
    if (value && [...TF.$('orderFilter').options].some((option) => option.value === value)) TF.$('orderFilter').value = value;
    const assignFromParam = (param, id) => {
      const input = TF.$(id);
      const val = params.get(param);
      if (!input || val === null) return;
      if (input.tagName === 'SELECT' && ![...input.options].some((option) => option.value === val)) return;
      input.value = val;
    };
    assignFromParam('basis', 'orderDateBasis');
    assignFromParam('preset', 'orderDatePreset');
    assignFromParam('start', 'orderStartDate');
    assignFromParam('end', 'orderEndDate');
    assignFromParam('payment', 'orderPaymentFilter');
    assignFromParam('fulfillment', 'orderFulfillmentFilter');
    assignFromParam('sort', 'orderSort');
    assignFromParam('search', 'orderSearch');
    updateOrderDateControls();
  }

  TF.ready.then(async () => {
    fillBase();
    if (isEntryPage()) {
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
      TF.$('saveSubmitBtn').addEventListener('click', () => saveOrder(true));
      TF.$('saveEditBtn').addEventListener('click', saveEdit);
      TF.$('cancelEditBtn').addEventListener('click', resetForm);
      if (has('createAnotherOrderBtn')) TF.$('createAnotherOrderBtn').addEventListener('click', () => { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }
    if (isListPage()) {
      renderSavedFilters();
      applyQueryFilter();
      TF.$('orderSearch').addEventListener('input', renderOrders);
      ['orderDateBasis', 'orderFilter', 'orderPaymentFilter', 'orderFulfillmentFilter', 'orderSort', 'orderStartDate', 'orderEndDate'].forEach((id) => TF.$(id).addEventListener('change', renderOrders));
      TF.$('orderDatePreset').addEventListener('change', () => { updateOrderDateControls(); renderOrders(); });
      TF.$('clearOrderFilters').addEventListener('click', clearOrderFilters);
      TF.$('saveCurrentFilterBtn').addEventListener('click', saveCurrentFilter);
      TF.$('deleteSavedFilterBtn').addEventListener('click', deleteSavedFilter);
      TF.$('savedFiltersSelect').addEventListener('change', () => {
        const value = TF.$('savedFiltersSelect').value;
        if (value === '') return;
        const filter = savedFilters()[Number(value)];
        if (filter) { applyFilterState(filter.state); renderOrders(); }
      });
      TF.$('applyBulkOrderAction').addEventListener('click', () => applyBulkAction().catch((error) => TF.fail(error, 'Bulk update failed')));
      TF.$('clearBulkSelection').addEventListener('click', () => { selectedOrderIds.clear(); renderOrders(); });
      TF.$('ordersTable').addEventListener('click', tableAction);
    }
    if (has('orderDialog')) {
      TF.$('closeOrderDialog').addEventListener('click', () => TF.$('orderDialog').close());
      TF.$('closeOrderDialogBottom').addEventListener('click', () => TF.$('orderDialog').close());
      TF.$('addPaymentForm').addEventListener('submit', submitAdditionalPayment);
      TF.$('paymentSubmissionsList').addEventListener('click', (event) => {
        const button = event.target.closest('[data-review-payment]');
        if (button) reviewPayment(button);
      });
      TF.$('operationsForm').addEventListener('submit', saveOperations);
      TF.$('operationMethod').addEventListener('change', updateOperationTrackingRule);
      TF.$('copyOrderItemsBtn').addEventListener('click', () => TF.copyText(`${activeOrder.order_number} — ${activeOrder.customer_name}
${itemText(activeItems)}`, 'Order details copied'));
      TF.$('copyCustomerUpdateBtn').addEventListener('click', () => TF.copyText(TF.$('customerUpdatePreview').textContent, 'Customer update copied'));
      TF.$('copyOriginalBtn').addEventListener('click', () => TF.copyText(activeOrder?.raw_order_form || '', 'Original order form copied'));
      TF.$('editOrderBtn').addEventListener('click', () => activeOrder && startEdit(activeOrder).catch((error) => TF.fail(error, 'Edit failed')));
      TF.$('cancelOrderBtn').addEventListener('click', () => cancelOrder().catch((error) => TF.fail(error, 'Cancellation failed')));
    }
    window.addEventListener('twofly:refresh', () => loadOrders().catch((error) => TF.fail(error, 'Orders failed')));
    await loadOrders();
  }).catch((error) => TF.fail(error, 'Orders failed'));

})();
