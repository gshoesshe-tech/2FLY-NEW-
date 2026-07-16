(() => {
  'use strict';
  const TF = window.TwoFly;
  let inventory = [];

  function fill() {
    const options = TF.categoryOptions();
    TF.$('receiveCategory').innerHTML = options;
    TF.$('countCategory').innerHTML = options;
    TF.$('receiveDate').value = TF.today();
    TF.$('countDate').value = TF.today();
  }

  function unit(code, quantity) {
    if (code === 'EARRINGS') return quantity === 1 ? 'pair' : 'pairs';
    return 'pcs';
  }

  function render() {
    const query = TF.$('inventorySearch').value.trim().toLowerCase();
    const rows = inventory.filter((row) => !query || [row.category_name, row.category_code].some((value) => String(value).toLowerCase().includes(query)));
    TF.$('inventoryTable').innerHTML = `<table><thead><tr><th>Category</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Low-stock level</th><th>Status</th></tr></thead><tbody>${rows.map((row) => `<tr class="${row.is_low_stock ? 'attention-row' : ''}">
      <td><strong>${TF.esc(row.category_name)}</strong><br><small>${TF.esc(row.category_code)}</small></td>
      <td>${TF.num(row.total_on_hand).toLocaleString()} ${unit(row.category_code, TF.num(row.total_on_hand))}</td>
      <td>${TF.num(row.total_reserved).toLocaleString()}</td>
      <td><strong>${TF.num(row.total_available).toLocaleString()}</strong></td>
      <td>${TF.num(row.low_stock_level).toLocaleString()}</td>
      <td>${row.is_low_stock ? '<span class="pill danger">Low Stock</span>' : '<span class="pill ok">Available</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No inventory categories.</td></tr>'}</tbody></table>`;
  }

  async function load() {
    const inventoryResult = await TF.state.supa.from('v_daily_inventory_v14').select('*').order('category_name');
    if (inventoryResult.error) throw inventoryResult.error;
    inventory = inventoryResult.data || [];
    TF.$('invOnHand').textContent = inventory.reduce((sum, row) => sum + TF.num(row.total_on_hand), 0).toLocaleString();
    TF.$('invReserved').textContent = inventory.reduce((sum, row) => sum + TF.num(row.total_reserved), 0).toLocaleString();
    TF.$('invAvailable').textContent = inventory.reduce((sum, row) => sum + TF.num(row.total_available), 0).toLocaleString();
    TF.$('invLow').textContent = inventory.filter((row) => row.is_low_stock).length.toLocaleString();
    render();

    if (TF.can('manage_inventory')) {
      const movementResult = await TF.state.supa.from('inventory_movements').select('*,inventory_categories(name,code)').order('movement_date', { ascending: false }).limit(150);
      if (movementResult.error) throw movementResult.error;
      TF.$('movementTable').innerHTML = `<table><thead><tr><th>Date</th><th>Category</th><th>Change</th><th>Type</th><th>Reason</th></tr></thead><tbody>${(movementResult.data || []).map((movement) => `<tr><td>${TF.formatDateTime(movement.movement_date)}</td><td>${TF.esc(movement.inventory_categories?.name || '')}</td><td><strong>${TF.num(movement.quantity_delta) > 0 ? '+' : ''}${TF.num(movement.quantity_delta)}</strong></td><td>${TF.esc(String(movement.movement_type).replaceAll('_', ' '))}</td><td>${TF.esc(movement.reason || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No stock movements.</td></tr>'}</tbody></table>`;
    }
  }

  async function receive(event) {
    event.preventDefault();
    const button = event.submitter;
    TF.setLoading(button, true, 'Adding…');
    try {
      const result = await TF.state.supa.rpc('receive_finished_stock_v14', {
        p_category_code: TF.$('receiveCategory').value,
        p_quantity: TF.num(TF.$('receiveQty').value),
        p_received_date: TF.$('receiveDate').value,
        p_source: TF.$('receiveSource').value.trim(),
        p_notes: TF.$('receiveNotes').value.trim()
      });
      if (result.error) throw result.error;
      TF.toast('Finished stock added');
      event.target.reset();
      fill();
      await load();
    } catch (error) {
      TF.fail(error, 'Stock not added');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function count(event) {
    event.preventDefault();
    if (!confirm('Save this physical count? The website inventory will be adjusted to match it.')) return;
    const button = event.submitter;
    TF.setLoading(button, true, 'Saving…');
    try {
      const result = await TF.state.supa.rpc('set_total_inventory_count_v14', {
        p_category_code: TF.$('countCategory').value,
        p_physical_count: TF.num(TF.$('physicalCount').value),
        p_count_date: TF.$('countDate').value,
        p_reason: TF.$('countReason').value.trim()
      });
      if (result.error) throw result.error;
      TF.toast('Physical count saved');
      event.target.reset();
      fill();
      await load();
    } catch (error) {
      TF.fail(error, 'Physical count not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  TF.ready.then(async () => {
    fill();
    TF.$('inventorySearch').addEventListener('input', render);
    TF.$('receiveStockForm').addEventListener('submit', receive);
    TF.$('physicalCountForm').addEventListener('submit', count);
    window.addEventListener('twofly:refresh', () => load().catch((error) => TF.fail(error, 'Inventory failed')));
    await load();
  }).catch((error) => TF.fail(error, 'Inventory failed'));
})();
