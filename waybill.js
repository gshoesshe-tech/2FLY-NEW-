(() => {
  'use strict';
  const TF = window.TwoFly;
  let orders = [];
  let itemMap = new Map();
  let selectedId = null;
  let currentPreviewUrl = '';

  const q = {
    search: 'all',
    queue: 'all',
    status: 'all',
    preset: 'all'
  };

  function isJnt(order) {
    return String(order?.fulfillment_method || '').toLowerCase() === 'jnt';
  }

  function simpleStatus(order) {
    if (order?.status === 'delivered') return 'delivered';
    if (['packing', 'ready_to_ship', 'shipped'].includes(order?.status)) return 'processing';
    return 'pending';
  }

  function simpleStatusLabel(value) {
    if (value === 'processing') return 'Processing';
    if (value === 'delivered') return 'Delivered';
    return 'Pending';
  }

  function simpleStatusPill(value) {
    const cls = value === 'delivered' ? 'ok' : value === 'processing' ? 'warn' : '';
    return `<span class="pill ${cls}">${TF.esc(simpleStatusLabel(value))}</span>`;
  }

  function queueOf(order) {
    if (simpleStatus(order) === 'delivered') return 'delivered';
    return order.waybill_storage_path && String(order.tracking_number || '').trim() ? 'ready' : 'missing';
  }

  function queueLabel(queue) {
    if (queue === 'ready') return 'Ready to scan';
    if (queue === 'delivered') return 'Delivered';
    return 'Missing waybill';
  }

  function queuePill(order) {
    const queue = queueOf(order);
    const cls = queue === 'ready' ? 'ok' : queue === 'delivered' ? 'ok' : 'warn';
    return `<span class="pill ${cls}">${TF.esc(queueLabel(queue))}</span>`;
  }

  function paymentPill(order) {
    if (TF.num(order.pending_payment_count) > 0) return TF.statusPill('submitted');
    return TF.statusPill(order.payment_status || 'unpaid');
  }

  function piecesText(order) {
    const pieces = TF.num(order.total_quantity || 0);
    return `${pieces.toLocaleString()} ${pieces === 1 ? 'pc' : 'pcs'}`;
  }

  function itemSummary(orderId) {
    const items = itemMap.get(orderId) || [];
    if (!items.length) return 'No items';
    if (items.length === 1) return items[0].category || 'Item';
    return `${items[0].category || 'Item'} +${items.length - 1} more`;
  }

  function orderSearchText(order) {
    return [
      order.order_number,
      order.customer_name,
      order.phone,
      order.facebook_profile,
      order.tracking_number,
      ...(itemMap.get(order.id) || []).map((item) => item.category)
    ].join(' ').toLowerCase();
  }

  function applyFilters() {
    const preset = TF.presetRange(q.preset);
    return orders.filter((order) => {
      if (!isJnt(order)) return false;
      if (q.queue !== 'all' && queueOf(order) !== q.queue) return false;
      if (q.status !== 'all' && simpleStatus(order) !== q.status) return false;
      if (!TF.dateInRange(order.order_date, preset.start, preset.end)) return false;
      const text = TF.$('wbSearch')?.value.trim().toLowerCase() || '';
      if (text && !orderSearchText(order).includes(text)) return false;
      return true;
    });
  }

  function refreshCounts() {
    const jntOrders = orders.filter((order) => isJnt(order));
    TF.$('wbAllCount').textContent = jntOrders.length.toLocaleString();
    TF.$('wbMissingCount').textContent = jntOrders.filter((order) => queueOf(order) === 'missing').length.toLocaleString();
    TF.$('wbReadyCount').textContent = jntOrders.filter((order) => queueOf(order) === 'ready').length.toLocaleString();
    TF.$('wbDeliveredCount').textContent = jntOrders.filter((order) => queueOf(order) === 'delivered').length.toLocaleString();
  }

  function renderTable() {
    const filtered = applyFilters();
    if (!filtered.some((row) => row.id === selectedId)) selectedId = filtered[0]?.id || null;
    const rows = filtered.map((order) => {
      const selected = order.id === selectedId ? ' selected' : '';
      return `<tr class="waybill-row${selected}" data-waybill-row="${order.id}">
        <td>
          <strong>${TF.esc(order.order_number)}</strong>
          <small>${TF.formatDate(order.order_date)}</small>
        </td>
        <td>
          <strong>${TF.esc(order.customer_name || '—')}</strong>
          <small>${TF.esc(order.phone || '—')}</small>
        </td>
        <td>
          <strong>${piecesText(order)}</strong>
          <small>${TF.esc(itemSummary(order.id))}</small>
        </td>
        <td>${paymentPill(order)}</td>
        <td>${simpleStatusPill(simpleStatus(order))}<div class="waybill-fulfillment-text">J&amp;T</div></td>
        <td>${queuePill(order)}</td>
        <td>
          <strong>${TF.esc(order.tracking_number || 'Not added yet')}</strong>
          <small>${order.waybill_storage_path ? 'Waybill uploaded' : 'No waybill file yet'}</small>
        </td>
        <td><button class="btn small" data-open-waybill="${order.id}">Open</button></td>
      </tr>`;
    }).join('');

    TF.$('waybillTableWrap').innerHTML = `<table class="waybill-table">
      <thead>
        <tr>
          <th>Order</th>
          <th>Customer</th>
          <th>Items</th>
          <th>Payment</th>
          <th>Status</th>
          <th>Waybill</th>
          <th>Tracking</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="8" class="empty">No J&amp;T orders match your filters.</td></tr>`}</tbody>
    </table>`;

    renderSidePanel();
  }

  async function signedWaybillUrl(path) {
    if (!path) return '';
    const result = await TF.state.supa.storage.from('waybills').createSignedUrl(path, 3600);
    if (result.error) throw result.error;
    return result.data?.signedUrl || '';
  }

  function isPreviewable(path) {
    return /\.(png|jpg|jpeg|webp|gif|pdf)$/i.test(String(path || ''));
  }

  async function renderSidePanel() {
    const panel = TF.$('waybillSidePanel');
    const order = orders.find((row) => row.id === selectedId);
    if (!order) {
      panel.innerHTML = '<div class="waybill-panel-empty">Select a J&amp;T order to manage its waybill.</div>';
      return;
    }

    const items = itemMap.get(order.id) || [];
    panel.innerHTML = `<div class="waybill-panel-head">
        <div>
          <h3>${TF.esc(order.order_number)}</h3>
          <p>${TF.esc(order.customer_name || '—')} • ${piecesText(order)}</p>
        </div>
        <div class="waybill-head-pills">${simpleStatusPill(simpleStatus(order))}${queuePill(order)}</div>
      </div>
      <div class="waybill-info-grid">
        <div><span>Customer</span><strong>${TF.esc(order.customer_name || '—')}</strong></div>
        <div><span>Phone</span><strong>${TF.esc(order.phone || '—')}</strong></div>
        <div><span>Facebook</span><strong>${order.facebook_profile ? `<a href="${TF.esc(order.facebook_profile)}" target="_blank" rel="noopener noreferrer">Open profile</a>` : '—'}</strong></div>
        <div><span>Order date</span><strong>${TF.formatDate(order.order_date)}</strong></div>
        <div><span>Payment</span><strong>${TF.statusLabel(order.payment_status || 'unpaid')}</strong></div>
        <div><span>Received in</span><strong>${TF.esc(order.latest_payment_account_name || '—')}</strong></div>
        <div class="span-2"><span>Address</span><strong>${TF.esc(order.address || '—')}</strong></div>
      </div>

      <section class="waybill-section">
        <div class="dialog-section-head"><h4>Order items</h4><button id="wbCopyItemsBtn" class="btn small" type="button">Copy order details</button></div>
        <div class="simple-lines">${items.map((item) => `<div class="simple-line"><strong>${TF.esc(item.category || 'Item')}</strong><span>${TF.num(item.quantity)} pcs • ${TF.money(item.line_total)}</span></div>`).join('') || '<div class="empty">No items</div>'}</div>
      </section>

      <section class="waybill-section">
        <div class="dialog-section-head"><div><h4>Waybill file</h4><p class="muted">Upload the J&amp;T waybill once you generate it. Staff will scan this later.</p></div>${order.waybill_storage_path ? '<button id="wbOpenFileBtn" class="btn small" type="button">Open file</button>' : ''}</div>
        <div id="wbPreviewBox" class="waybill-preview-box">${order.waybill_storage_path ? '<div class="muted">Loading waybill preview…</div>' : '<div class="waybill-panel-empty">No waybill uploaded yet.</div>'}</div>
      </section>

      <section class="waybill-section">
        <div class="dialog-section-head"><div><h4>Upload / update waybill</h4><p class="muted">This saves the tracking number and uploaded file to the order.</p></div></div>
        <form id="wbForm" class="form-grid cols-2">
          <label>J&amp;T tracking number<input id="wbTrackingInput" value="${TF.esc(order.tracking_number || '')}" placeholder="Enter J&amp;T tracking" required></label>
          <label>Waybill file<input id="wbFileInput" type="file" accept="image/*,application/pdf"></label>
          <label class="span-2">Internal note<textarea id="wbInternalNote" placeholder="Optional note, for example: waybill generated and ready to scan."></textarea></label>
          <div class="waybill-inline-actions span-2">
            <button class="btn primary" id="wbSaveBtn">Save waybill</button>
            <button class="btn" id="wbMarkShippedBtn" type="button">Mark as shipped</button>
            <button class="btn" id="wbCopyTrackingBtn" type="button">Copy tracking</button>
          </div>
          <div class="span-2 muted small-note">Only J&amp;T orders need a waybill and tracking number.</div>
        </form>
      </section>`;

    TF.$('wbCopyItemsBtn')?.addEventListener('click', () => {
      const text = `${order.order_number}\n${items.map((item) => `${item.category} — ${TF.num(item.quantity)} pcs — ${TF.money(item.line_total)}`).join('\n')}`;
      TF.copyText(text, 'Order details copied');
    });
    TF.$('wbCopyTrackingBtn')?.addEventListener('click', () => TF.copyText(order.tracking_number || '', 'Tracking copied'));
    TF.$('wbForm')?.addEventListener('submit', saveWaybill);
    TF.$('wbMarkShippedBtn')?.addEventListener('click', markShipped);

    if (order.waybill_storage_path) {
      try {
        currentPreviewUrl = await signedWaybillUrl(order.waybill_storage_path);
        const preview = TF.$('wbPreviewBox');
        if (!preview) return;
        if (!currentPreviewUrl) {
          preview.innerHTML = '<div class="notice danger">The waybill file could not be opened.</div>';
        } else if (!isPreviewable(order.waybill_storage_path)) {
          preview.innerHTML = '<div class="waybill-panel-empty">Preview is not available for this file type. Use the Open file button.</div>';
        } else if (/\.pdf$/i.test(order.waybill_storage_path)) {
          preview.innerHTML = `<iframe class="waybill-preview-frame" src="${TF.esc(currentPreviewUrl)}"></iframe>`;
        } else {
          preview.innerHTML = `<img class="waybill-preview-image" src="${TF.esc(currentPreviewUrl)}" alt="Waybill preview">`;
        }
        TF.$('wbOpenFileBtn')?.addEventListener('click', () => window.open(currentPreviewUrl, '_blank', 'noopener'));
      } catch (error) {
        TF.fail(error, 'Waybill preview failed');
        TF.$('wbPreviewBox').innerHTML = '<div class="notice danger">The waybill preview failed to load.</div>';
      }
    }
  }

  async function uploadWaybill(file, orderId) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = `${TF.state.session.user.id}/orders/${orderId}/${TF.today()}-${crypto.randomUUID()}-${safe}`;
    const result = await TF.state.supa.storage.from('waybills').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    });
    if (result.error) throw result.error;
    return path;
  }

  async function saveWaybill(event) {
    event.preventDefault();
    const order = orders.find((row) => row.id === selectedId);
    if (!order) return;
    const button = TF.$('wbSaveBtn');
    TF.setLoading(button, true, 'Saving…');
    try {
      const tracking = TF.$('wbTrackingInput').value.trim();
      const file = TF.$('wbFileInput').files?.[0];
      const note = TF.$('wbInternalNote').value.trim();
      if (!tracking) throw new Error('Add the J&T tracking number first.');
      if (!file && !order.waybill_storage_path) throw new Error('Upload the waybill file first.');
      const storagePath = file ? await uploadWaybill(file, order.id) : order.waybill_storage_path;
      const result = await TF.state.supa.rpc('save_order_waybill_v1', {
        p_order_id: order.id,
        p_tracking_number: tracking,
        p_waybill_storage_path: storagePath,
        p_fulfillment_method: 'jnt',
        p_status_note: note || 'Waybill saved from the Waybill tab'
      });
      if (result.error) throw result.error;
      TF.toast('Waybill saved');
      await load();
    } catch (error) {
      TF.fail(error, 'Waybill save failed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function markShipped() {
    const order = orders.find((row) => row.id === selectedId);
    if (!order) return;
    const button = TF.$('wbMarkShippedBtn');
    TF.setLoading(button, true, 'Marking…');
    try {
      const tracking = TF.$('wbTrackingInput').value.trim() || order.tracking_number || '';
      if (!tracking) throw new Error('Add the J&T tracking number first.');
      if (!order.waybill_storage_path) throw new Error('Upload the waybill file first.');
      const result = await TF.state.supa.rpc('update_order_operations_v14', {
        p_order_id: order.id,
        p_status: 'shipped',
        p_fulfillment_method: 'jnt',
        p_tracking_number: tracking,
        p_actual_courier_cost: order.courier_cost_finalized ? order.actual_courier_cost : null,
        p_shipped_date: order.shipped_at ? String(order.shipped_at).slice(0, 10) : TF.today(),
        p_delivered_date: null,
        p_customer_update_note: order.customer_update_note || '',
        p_status_note: 'Marked shipped from Waybill tab'
      });
      if (result.error) throw result.error;
      TF.toast('Order marked shipped');
      await load();
    } catch (error) {
      TF.fail(error, 'Ship update failed');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function load() {
    const viewResult = await TF.state.supa.from('v_daily_ops_orders_v16').select('*').eq('fulfillment_method', 'jnt').order('order_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000);
    if (viewResult.error) throw viewResult.error;
    const baseRows = viewResult.data || [];
    const ids = baseRows.map((row) => row.id);
    if (!ids.length) {
      orders = [];
      itemMap = new Map();
      refreshCounts();
      renderTable();
      return;
    }
    const [orderResult, itemsResult] = await Promise.all([
      TF.state.supa.from('orders').select('id,waybill_storage_path,waybill_uploaded_at,waybill_uploaded_by,tracking_number,fulfillment_method,status').in('id', ids),
      TF.state.supa.from('order_items').select('order_id,category,category_code,quantity,line_total,line_number').in('order_id', ids).order('order_id').order('line_number')
    ]);
    if (orderResult.error || itemsResult.error) throw orderResult.error || itemsResult.error;

    const orderExtras = new Map((orderResult.data || []).map((row) => [row.id, row]));
    const nextItemMap = new Map();
    (itemsResult.data || []).forEach((item) => {
      if (!nextItemMap.has(item.order_id)) nextItemMap.set(item.order_id, []);
      nextItemMap.get(item.order_id).push(item);
    });
    itemMap = nextItemMap;
    orders = baseRows.map((row) => ({ ...row, ...(orderExtras.get(row.id) || {}) }));
    refreshCounts();
    renderTable();
  }

  function bindFilters() {
    TF.$('wbSearch').addEventListener('input', renderTable);
    TF.$('wbQueueFilter').addEventListener('change', (event) => { q.queue = event.target.value; renderTable(); });
    TF.$('wbStatusFilter').addEventListener('change', (event) => { q.status = event.target.value; renderTable(); });
    TF.$('wbDatePreset').addEventListener('change', (event) => { q.preset = event.target.value; renderTable(); });
    TF.$('wbClearBtn').addEventListener('click', () => {
      TF.$('wbSearch').value = '';
      TF.$('wbQueueFilter').value = 'all';
      TF.$('wbStatusFilter').value = 'all';
      TF.$('wbDatePreset').value = 'all';
      q.queue = 'all'; q.status = 'all'; q.preset = 'all';
      renderTable();
    });
    TF.$('waybillTableWrap').addEventListener('click', (event) => {
      const rowButton = event.target.closest('[data-open-waybill]');
      const row = event.target.closest('[data-waybill-row]');
      const id = rowButton?.dataset.openWaybill || row?.dataset.waybillRow;
      if (!id) return;
      selectedId = id;
      renderTable();
    });
    TF.$$('a[data-queue-card]').forEach((card) => card.addEventListener('click', (event) => {
      event.preventDefault();
      const queue = card.dataset.queueCard || 'all';
      q.queue = queue;
      TF.$('wbQueueFilter').value = queue;
      renderTable();
    }));
    window.addEventListener('twofly:refresh', async () => {
      try {
        await load();
      } catch (error) {
        TF.fail(error, 'Refresh failed');
      }
    });
  }

  async function init() {
    await TF.ready;
    bindFilters();
    await load();
  }

  init().catch((error) => TF.fail(error, 'Waybill page failed'));
})();
