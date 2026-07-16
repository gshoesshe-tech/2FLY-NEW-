(() => {
  'use strict';
  const TF = window.TwoFly;
  const S = { profiles: [], permissions: [], inventory: [] };

  function checked(value) { return value ? 'checked' : ''; }

  function renderAccounts() {
    TF.$('accountsTable').innerHTML = `<table><thead><tr><th>Account</th><th>Type</th><th>Status</th></tr></thead><tbody>${TF.state.accounts.map((account) => `<tr><td><strong>${TF.esc(account.name)}</strong></td><td>${TF.esc(account.account_type || '—')}</td><td>${TF.statusPill(account.active ? 'paid' : 'cancelled')}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No active payment accounts.</td></tr>'}</tbody></table>`;
  }

  function permissionFor(userId) {
    return S.permissions.find((row) => row.user_id === userId) || {
      can_create_orders: true,
      can_edit_orders: true,
      can_confirm_payments: false,
      can_update_tracking: true,
      can_manage_inventory: false,
      can_view_daily_summary: false
    };
  }

  function renderPermissions() {
    const staff = S.profiles.filter((profile) => profile.active && profile.role === 'staff');
    TF.$('permissionsTable').innerHTML = `<table class="permission-table"><thead><tr><th>Team member</th><th>Create orders</th><th>Edit orders</th><th>Confirm payments</th><th>Tracking updates</th><th>Manage inventory</th><th>Daily summary</th><th></th></tr></thead><tbody>${staff.map((profile) => {
      const p = permissionFor(profile.user_id);
      return `<tr data-user-id="${profile.user_id}"><td><strong>${TF.esc(profile.full_name || profile.email)}</strong><br><small>${TF.esc(profile.email)}</small></td><td><input type="checkbox" data-perm="can_create_orders" ${checked(p.can_create_orders)}></td><td><input type="checkbox" data-perm="can_edit_orders" ${checked(p.can_edit_orders)}></td><td><input type="checkbox" data-perm="can_confirm_payments" ${checked(p.can_confirm_payments)}></td><td><input type="checkbox" data-perm="can_update_tracking" ${checked(p.can_update_tracking)}></td><td><input type="checkbox" data-perm="can_manage_inventory" ${checked(p.can_manage_inventory)}></td><td><input type="checkbox" data-perm="can_view_daily_summary" ${checked(p.can_view_daily_summary)}></td><td><button class="btn primary small" data-save-permissions="${profile.user_id}">Save</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">No active staff profiles. Owner accounts always have full access.</td></tr>'}</tbody></table>`;
    TF.$$('[data-save-permissions]').forEach((button) => button.addEventListener('click', () => savePermissions(button)));
  }

  function renderLowStock() {
    TF.$('lowStockTable').innerHTML = `<table><thead><tr><th>Category</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Alert at</th><th></th></tr></thead><tbody>${S.inventory.map((row) => `<tr data-category-id="${row.category_id}"><td><strong>${TF.esc(row.category_name)}</strong><br><small>${TF.esc(row.category_code)}</small></td><td>${row.total_on_hand}</td><td>${row.total_reserved}</td><td><strong>${row.total_available}</strong></td><td><input class="compact-field" data-low-stock-input type="number" min="0" value="${TF.num(row.low_stock_level)}"></td><td><button class="btn small" data-save-low-stock="${row.category_id}">Save</button></td></tr>`).join('')}</tbody></table>`;
    TF.$$('[data-save-low-stock]').forEach((button) => button.addEventListener('click', () => saveLowStock(button)));
  }

  async function saveSettings(event) {
    event.preventDefault();
    const button = event.submitter;
    TF.setLoading(button, true);
    try {
      const result = await TF.state.supa.rpc('save_daily_ops_settings_v14', { p_paid_not_shipped_alert_days: TF.num(TF.$('paidNotShippedDays').value) });
      if (result.error) throw result.error;
      TF.state.dailySettings.paid_not_shipped_alert_days = TF.num(TF.$('paidNotShippedDays').value);
      TF.toast('Alert setting saved');
    } catch (error) {
      TF.fail(error, 'Setting not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function savePermissions(button) {
    const row = button.closest('tr');
    const value = (permission) => row.querySelector(`[data-perm="${permission}"]`).checked;
    TF.setLoading(button, true);
    try {
      const result = await TF.state.supa.rpc('save_daily_ops_permission_v14', {
        p_user_id: button.dataset.savePermissions,
        p_can_create_orders: value('can_create_orders'),
        p_can_edit_orders: value('can_edit_orders'),
        p_can_confirm_payments: value('can_confirm_payments'),
        p_can_update_tracking: value('can_update_tracking'),
        p_can_manage_inventory: value('can_manage_inventory'),
        p_can_view_daily_summary: value('can_view_daily_summary')
      });
      if (result.error) throw result.error;
      TF.toast('Staff permissions saved');
      await load();
    } catch (error) {
      TF.fail(error, 'Permissions not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function saveLowStock(button) {
    const row = button.closest('tr');
    const input = row.querySelector('[data-low-stock-input]');
    TF.setLoading(button, true);
    try {
      const result = await TF.state.supa.rpc('save_low_stock_level_v14', {
        p_category_id: button.dataset.saveLowStock,
        p_low_stock_level: TF.num(input.value)
      });
      if (result.error) throw result.error;
      TF.toast('Low-stock level saved');
      await load();
    } catch (error) {
      TF.fail(error, 'Low-stock level not saved');
    } finally {
      TF.setLoading(button, false);
    }
  }

  async function load() {
    try {
      const [profilesResult, permissionsResult, inventoryResult, settingsResult] = await Promise.all([
        TF.state.supa.from('profiles').select('*').order('full_name'),
        TF.state.supa.from('daily_ops_permissions_v14').select('*'),
        TF.state.supa.from('v_daily_inventory_v14').select('*').order('category_name'),
        TF.state.supa.from('daily_ops_settings_v14').select('*').eq('singleton', true).single()
      ]);
      if (profilesResult.error || permissionsResult.error || inventoryResult.error || settingsResult.error) throw profilesResult.error || permissionsResult.error || inventoryResult.error || settingsResult.error;
      S.profiles = profilesResult.data || [];
      S.permissions = permissionsResult.data || [];
      S.inventory = inventoryResult.data || [];
      TF.state.dailySettings = settingsResult.data;
      TF.$('paidNotShippedDays').value = settingsResult.data.paid_not_shipped_alert_days;
      renderAccounts();
      renderPermissions();
      renderLowStock();
    } catch (error) {
      TF.fail(error, 'Settings failed');
    }
  }

  async function init() {
    await TF.ready;
    TF.$('operationsSettingsForm').addEventListener('submit', saveSettings);
    window.addEventListener('twofly:refresh', load);
    await load();
  }

  init().catch((error) => TF.fail(error, 'Settings failed'));
})();
