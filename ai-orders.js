(() => {
  'use strict';

  const TF = window.TwoFly;
  const Parser = window.TwoFlyAIParser;
  let records = [];
  let savingBatch = false;
  const SAFE_TEST = new URLSearchParams(location.search).get('safe') === '1';

  // GCash identifiers visible on the user's four QR/account screens.
  // We resolve these clues to the live cash_accounts rows by account name,
  // so no Supabase account UUID is hard-coded here.
  const GCASH_ACCOUNT_CLUES = [
    {
      account_name: 'GCash Marian Isabelle Diaz',
      mobile_prefixes: ['0946245'],
      user_id_suffixes: ['9L3P8W'],
      masked_name_patterns: [/MA\W*N\s+IS\W*E\s+D/i]
    },
    {
      account_name: 'GCash Lorna D.',
      mobile_prefixes: ['0912669', '63912669'],
      user_id_suffixes: ['X3Y8UH'],
      masked_name_patterns: [/LO\W*A\s+D/i]
    },
    {
      account_name: 'GCash Monaliza V.',
      mobile_prefixes: ['0960597'],
      user_id_suffixes: ['8E50BK'],
      masked_name_patterns: [/MO\W*A\s+V/i]
    },
    {
      account_name: 'GCash Myra V.',
      mobile_prefixes: ['0994983'],
      user_id_suffixes: ['7WB1IW'],
      masked_name_patterns: [/MY\W*A\s+V/i]
    }
  ];

  function representativeProduct(categoryId, preferredSku) {
    const preferred = TF.state.productByCode.get(String(preferredSku || '').toUpperCase());
    if (preferred && preferred.category_id === categoryId && preferred.active) return preferred;
    return TF.state.products.find((product) => product.category_id === categoryId && product.active) || null;
  }

  function fulfillmentLabel(value) {
    if (value === 'jnt') return 'J&T';
    if (value === 'lalamove') return 'Lalamove';
    if (value === 'walk_in') return 'Walk-in / Pickup';
    return 'Not selected';
  }

  function expectedTotal(record) {
    return TF.num(record.product_total) + (record.fulfillment === 'jnt' ? TF.num(record.shipping_fee) : 0);
  }

  function mapParsedForm(parsed, index) {
    const errors = [];
    const warnings = [...(parsed.warnings || [])];
    const items = [];

    for (const group of parsed.groups || []) {
      const category = TF.state.aliasToCategory.get(TF.normalizeCategoryLabel(group.label));
      if (!category) {
        errors.push('Unknown category: ' + group.label);
        continue;
      }
      if (TF.normalizeCategoryLabel(group.label) === 'BUSINESS BUNDLES' &&
          category.code !== 'BUSINESS_BUNDLES' &&
          !/BUSINESS\s+BUNDLES?/i.test(String(category.name || ''))) {
        errors.push('Business Bundles is mapped to the wrong 2FLY Numbers category (' + category.name + '). Fix the Business Bundles database category before saving.');
        continue;
      }

      const quantity = TF.num(group.quantity);
      const amount = TF.num(group.amount);
      if (group.amount === null || group.amount === undefined) {
        errors.push(category.name + ': Category Amount is missing.');
        continue;
      }
      if (quantity <= 0) {
        errors.push(category.name + ': quantity is missing or zero.');
        continue;
      }

      const preferredSku = (group.items || []).find((sourceItem) => {
        const product = TF.state.productByCode.get(String(sourceItem.sku || '').toUpperCase());
        return product && product.category_id === category.id;
      });
      const product = representativeProduct(category.id, preferredSku && preferredSku.sku);
      if (!product) {
        errors.push(category.name + ': no active product is configured in 2FLY Numbers.');
        continue;
      }

      items.push({
        category_id: category.id,
        category_code: category.code,
        category_name: category.name,
        sku: product.code,
        quantity: quantity,
        amount: amount,
        unit_price: quantity > 0 ? amount / quantity : 0,
        source_items: group.items || []
      });
    }

    const calculated = items.reduce((sum, item) => sum + TF.num(item.amount), 0);
    if (parsed.product_total && Math.abs(TF.num(parsed.product_total) - calculated) > 0.02) {
      errors.push('Product total mismatch: form says ' + TF.money(parsed.product_total) + ', valid categories equal ' + TF.money(calculated) + '.');
    }

    return {
      id: crypto.randomUUID(),
      index: index + 1,
      raw: parsed.raw,
      customer_name: parsed.customer_name || '',
      phone: parsed.phone || '',
      address: parsed.address || '',
      facebook_profile: parsed.facebook_profile || '',
      notes: parsed.notes || '',
      order_date: TF.today(),
      fulfillment: '',
      shipping_fee: '',
      shipping_fee_source: '',
      shipping_review_message: '',
      shipping_warning: '',
      product_total: parsed.product_total || calculated,
      total_quantity: parsed.total_quantity || items.reduce((sum, item) => sum + TF.num(item.quantity), 0),
      items: items,
      warnings: warnings,
      base_errors: errors,
      payment_enabled: true,
      payment_method: 'gcash',
      payment_date: TF.today(),
      payment_amount: parsed.product_total || calculated,
      payment_amount_auto: true,
      payment_account_id: '',
      payment_reference: '',
      payment_proof: null,
      ocr_status: '',
      ocr_message: '',
      ocr_progress: 0,
      ocr_amount: null,
      ocr_reference: '',
      ocr_date: '',
      ocr_account_id: '',
      ocr_account_confidence: '',
      duplicate_payment_refs: [],
      duplicate_payment_checking: false,
      duplicate_matches: [],
      allow_duplicate: false,
      saved: false,
      saved_order_id: '',
      saved_order_number: '',
      save_error: ''
    };
  }

  function issues(record) {
    const list = [...record.base_errors];
    if (!record.customer_name.trim()) list.push('Customer name is required.');
    if (!record.items.length) list.push('No valid categories were detected.');
    if (!record.fulfillment) list.push('Choose fulfillment.');
    if (record.fulfillment === 'jnt' && String(record.shipping_fee).trim() === '') list.push('Enter the J&T shipping fee.');
    if (record.shipping_review_message) list.push(record.shipping_review_message);
    if (record.payment_enabled) {
      if (TF.num(record.payment_amount) <= 0) list.push('Payment amount is required.');
      if (!record.payment_account_id) list.push('Select the receiving account.');
      if (record.payment_method === 'gcash' && !record.payment_reference.trim()) list.push('GCash reference number is required.');
      if (record.payment_method === 'gcash' && !record.payment_proof) list.push('GCash payment proof is required.');
      if (record.ocr_amount !== null && Math.abs(TF.num(record.ocr_amount) - expectedTotal(record)) > 0.02) list.push('Payment screenshot amount ' + TF.money(record.ocr_amount) + ' does not match expected ' + TF.money(expectedTotal(record)) + '.');
      if (record.duplicate_payment_refs.length) list.push('This GCash reference number is already used on another payment.');
    }
    if (record.duplicate_matches.length && !record.allow_duplicate) list.push('Possible duplicate needs confirmation.');
    return list;
  }

  function recordStatus(record) {
    if (record.saved) return { label: 'Saved', tone: 'ok' };
    const problemCount = issues(record).length;
    if (problemCount) return { label: 'Needs review', tone: 'warn' };
    return { label: 'Ready', tone: 'ok' };
  }

  function accountOptions(selected) {
    return '<option value="">Select account</option>' + TF.state.accounts.map((account) =>
      '<option value="' + TF.esc(account.id) + '"' + (account.id === selected ? ' selected' : '') + '>' + TF.esc(account.name) + '</option>'
    ).join('');
  }

  function sourceItemsHtml(item) {
    if (!item.source_items || !item.source_items.length) return '<small class="muted">Category total from order form</small>';
    return '<small class="ai-source-items">' + item.source_items.map((source) => {
      const size = source.size ? ' · ' + TF.esc(source.size) : '';
      return TF.esc(source.sku) + size + ' ×' + TF.num(source.quantity);
    }).join('<br>') + '</small>';
  }

  function cardHtml(record) {
    const status = recordStatus(record);
    const currentIssues = issues(record);
    const shippingDisabled = record.fulfillment !== 'jnt';
    const shippingValue = record.fulfillment === 'jnt' ? record.shipping_fee : '0';
    const expected = expectedTotal(record);
    const paymentAmount = record.payment_amount_auto ? expected : TF.num(record.payment_amount);
    const dynamicWarnings = [...record.warnings];
    if (record.shipping_warning) dynamicWarnings.push(record.shipping_warning);
    const warningHtml = dynamicWarnings.length
      ? '<div class="notice warn ai-card-warning">' + dynamicWarnings.map((x) => '• ' + TF.esc(x)).join('<br>') + '</div>'
      : '';
    const duplicatePaymentHtml = record.duplicate_payment_refs.length
      ? '<div class="notice danger ai-card-warning"><strong>Duplicate GCash reference.</strong><br>' +
          record.duplicate_payment_refs.map((x) => TF.esc((x.order_number ? x.order_number + ' — ' : '') + (x.status || 'payment') + ' — ' + TF.money(x.amount || 0) + ' — ' + (x.payment_date || ''))).join('<br>') +
        '</div>'
      : '';
    const duplicateHtml = record.duplicate_matches.length
      ? '<div class="notice danger ai-card-warning"><strong>Possible duplicate found.</strong><br>' +
          record.duplicate_matches.map((x) => TF.esc((x.order_number || 'Order') + ' — ' + (x.customer_name || '') + ' — ' + TF.money(x.total_due))).join('<br>') +
          '<label class="ai-duplicate-confirm"><input type="checkbox" data-ai-field="allow_duplicate" data-id="' + record.id + '"' + (record.allow_duplicate ? ' checked' : '') + '> I checked this and want to save anyway.</label></div>'
      : '';
    const savedHtml = record.saved
      ? '<div class="notice ok"><strong>' + TF.esc(record.saved_order_number || 'Order saved') + '</strong> is now in 2FLY Numbers.' + (record.saved_order_id ? ' <a class="btn small" href="./orderpage.html?open=' + encodeURIComponent(record.saved_order_id) + '">View order</a>' : '') + '</div>'
      : '';
    const ocrTone = record.ocr_status === 'done' ? 'ok' : record.ocr_status === 'error' ? 'danger' : 'info';
    const ocrHtml = record.ocr_status
      ? '<div class="notice ' + ocrTone + ' ai-ocr-status"><strong>' + (record.ocr_status === 'reading' ? 'Reading payment screenshot…' : record.ocr_status === 'done' ? 'Screenshot read' : 'Screenshot reader needs review') + '</strong><br><span>' + TF.esc(record.ocr_message || '') + '</span></div>'
      : '';

    return '<article class="card ai-order-card" data-card-id="' + record.id + '">' +
      '<div class="card-head ai-order-card-head"><div><span class="eyebrow">ORDER ' + record.index + '</span><h3>' + TF.esc(record.customer_name || 'Unnamed customer') + '</h3><p>' + TF.num(record.total_quantity).toLocaleString() + ' pcs • ' + TF.money(record.product_total) + ' products</p></div>' +
      '<span class="pill ' + status.tone + '" data-card-status>' + status.label + '</span></div>' +
      '<div class="card-body stack">' +
        savedHtml +
        '<div class="ai-order-grid">' +
          '<label>Name<input data-ai-field="customer_name" data-id="' + record.id + '" value="' + TF.esc(record.customer_name) + '"' + (record.saved ? ' disabled' : '') + '></label>' +
          '<label>Phone<input data-ai-field="phone" data-id="' + record.id + '" value="' + TF.esc(record.phone) + '"' + (record.saved ? ' disabled' : '') + '></label>' +
          '<label class="span-2">Address<textarea data-ai-field="address" data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '>' + TF.esc(record.address) + '</textarea></label>' +
          '<label class="span-2">Notes<textarea data-ai-field="notes" data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '>' + TF.esc(record.notes) + '</textarea></label>' +
          '<label>Order date<input type="date" data-ai-field="order_date" data-id="' + record.id + '" value="' + TF.esc(record.order_date) + '"' + (record.saved ? ' disabled' : '') + '></label>' +
          '<label>Fulfillment<select data-ai-field="fulfillment" data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '>' +
            '<option value="">Choose fulfillment</option>' +
            '<option value="jnt"' + (record.fulfillment === 'jnt' ? ' selected' : '') + '>J&T</option>' +
            '<option value="lalamove"' + (record.fulfillment === 'lalamove' ? ' selected' : '') + '>Lalamove</option>' +
            '<option value="walk_in"' + (record.fulfillment === 'walk_in' ? ' selected' : '') + '>Walk-in / Pickup</option>' +
          '</select></label>' +
        '</div>' +

        '<div class="table-wrap"><table class="ai-order-items"><thead><tr><th>Category</th><th>Qty</th><th>Amount</th><th>Source details</th></tr></thead><tbody>' +
          record.items.map((item) => '<tr><td><strong>' + TF.esc(item.category_name) + '</strong></td><td>' + TF.num(item.quantity).toLocaleString() + '</td><td><strong>' + TF.money(item.amount) + '</strong></td><td>' + sourceItemsHtml(item) + '</td></tr>').join('') +
        '</tbody></table></div>' +

        '<div class="ai-money-grid">' +
          '<div><span>Product total</span><strong>' + TF.money(record.product_total) + '</strong></div>' +
          '<label class="' + (record.fulfillment === 'jnt' && String(record.shipping_fee).trim() === '' ? 'field-attention' : '') + '">Customer shipping fee' +
            '<input type="number" min="0" step="0.01" placeholder="' + (record.fulfillment === 'jnt' ? 'Auto from payment proof' : '₱0') + '" data-ai-field="shipping_fee" data-id="' + record.id + '" value="' + TF.esc(shippingValue) + '"' + (shippingDisabled || record.saved ? ' disabled' : '') + '>' +
            '<small>' + (record.fulfillment === 'jnt'
              ? (record.shipping_fee_source === 'payment'
                ? 'Auto-calculated from payment: amount sent − product total.'
                : 'Upload the payment proof to calculate shipping automatically, or enter it manually.')
              : record.fulfillment ? fulfillmentLabel(record.fulfillment) + ': customer shipping charge is ₱0.' : 'Choose fulfillment first.') + '</small>' +
          '</label>' +
          '<div><span>Expected customer total</span><strong data-expected-total>' + TF.money(expected) + '</strong></div>' +
        '</div>' +

        '<section class="ai-payment-box">' +
          '<div class="ai-payment-heading"><div><strong>Payment proof</strong><small>Upload the customer payment screenshot here. Payment stays For Verification.</small></div></div>' +
          '<label class="ai-payment-toggle"><input type="checkbox" data-ai-field="payment_enabled" data-id="' + record.id + '"' + (record.payment_enabled ? ' checked' : '') + (record.saved ? ' disabled' : '') + '> <strong>Submit payment for verification with this order</strong></label>' +
          (record.payment_enabled ? '<div class="ai-order-grid ai-payment-fields">' +
            '<label class="span-2 ai-proof-upload">Upload GCash screenshot / payment proof<input type="file" accept="image/*" data-ai-proof data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '><small>' + (record.payment_proof ? TF.esc(record.payment_proof.name) + ' selected' : 'Upload the customer payment screenshot here. It will still require verification.') + '</small></label>' +
            '<div class="span-2">' + ocrHtml + '</div>' +
            '<label>Amount sent<input type="number" min="0" step="0.01" data-ai-field="payment_amount" data-id="' + record.id + '" value="' + TF.num(paymentAmount).toFixed(2) + '"' + (record.saved ? ' disabled' : '') + '></label>' +
            '<label>Reference number<input data-ai-field="payment_reference" data-id="' + record.id + '" value="' + TF.esc(record.payment_reference) + '" placeholder="GCash reference"' + (record.saved ? ' disabled' : '') + '></label>' +
            '<label>Receiving account<select data-ai-field="payment_account_id" data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '>' + accountOptions(record.payment_account_id) + '</select></label>' +
            '<label>Payment date<input type="date" data-ai-field="payment_date" data-id="' + record.id + '" value="' + TF.esc(record.payment_date) + '"' + (record.saved ? ' disabled' : '') + '></label>' +
            '<label>Method<select data-ai-field="payment_method" data-id="' + record.id + '"' + (record.saved ? ' disabled' : '') + '><option value="gcash"' + (record.payment_method === 'gcash' ? ' selected' : '') + '>GCash</option><option value="cash"' + (record.payment_method === 'cash' ? ' selected' : '') + '>Cash</option><option value="bank"' + (record.payment_method === 'bank' ? ' selected' : '') + '>Bank</option><option value="other"' + (record.payment_method === 'other' ? ' selected' : '') + '>Other</option></select></label>' +
          '</div>' : '<p class="muted">If left off, this order will be saved as Awaiting Payment. You can submit the payment later from Orders.</p>') +
        '</section>' +

        warningHtml + duplicatePaymentHtml + duplicateHtml +
        '<div class="notice danger' + (currentIssues.length ? '' : ' hidden') + '" data-card-issues>' + currentIssues.map((x) => '• ' + TF.esc(x)).join('<br>') + '</div>' +
        (record.save_error ? '<div class="notice danger">' + TF.esc(record.save_error) + '</div>' : '') +
        '<div class="ai-card-actions">' +
          '<button class="btn primary" data-ai-save="' + record.id + '"' + (record.saved || currentIssues.length || SAFE_TEST ? ' disabled' : '') + '>' + (record.saved ? 'Saved' : (SAFE_TEST ? 'Safe Test' : 'Save Order')) + '</button>' +
          '<button class="btn" data-ai-remove="' + record.id + '"' + (record.saved ? ' disabled' : '') + '>Remove from batch</button>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function render() {
    const modeNotice = TF.$('aiModeNotice');
    if (modeNotice) {
      modeNotice.className = 'notice ' + (SAFE_TEST ? 'info' : 'ok');
      modeNotice.innerHTML = SAFE_TEST
        ? '<strong>SAFE TEST MODE.</strong> Parsing, shipping, validation and payment review work normally, but saving is disabled.'
        : '<strong>LIVE AI ORDER INTAKE.</strong> Approved orders are saved directly into the normal 2FLY Numbers workflow and payments remain For Verification.';
    }
    TF.$('aiDetectedCount').textContent = records.length.toLocaleString();
    TF.$('aiSavedCount').textContent = records.filter((record) => record.saved).length.toLocaleString();
    TF.$('aiReadyCount').textContent = records.filter((record) => !record.saved && issues(record).length === 0).length.toLocaleString();
    TF.$('aiReviewCount').textContent = records.filter((record) => !record.saved && issues(record).length > 0).length.toLocaleString();
    TF.$('aiBatchTools').classList.toggle('hidden', records.length === 0);
    TF.$('aiOrdersList').innerHTML = records.length
      ? records.map(cardHtml).join('')
      : '<div class="empty ai-empty-state">Paste your orders above to start.</div>';
  }

  function refreshDerived(record) {
    if (record.fulfillment !== 'jnt') record.shipping_fee = '0';
    const expected = expectedTotal(record);
    if (record.payment_amount_auto) record.payment_amount = expected;
    const card = document.querySelector('[data-card-id="' + record.id + '"]');
    if (card) {
      const total = card.querySelector('[data-expected-total]');
      if (total) total.textContent = TF.money(expected);
      const paymentAmountInput = card.querySelector('[data-ai-field="payment_amount"]');
      if (paymentAmountInput && record.payment_amount_auto) paymentAmountInput.value = expected.toFixed(2);
      const status = recordStatus(record);
      const statusEl = card.querySelector('[data-card-status]');
      if (statusEl) {
        statusEl.className = 'pill ' + status.tone;
        statusEl.textContent = status.label;
      }
      const issueBox = card.querySelector('[data-card-issues]');
      const currentIssues = issues(record);
      if (issueBox) {
        issueBox.classList.toggle('hidden', currentIssues.length === 0);
        issueBox.innerHTML = currentIssues.map((x) => '• ' + TF.esc(x)).join('<br>');
      }
      const saveButton = card.querySelector('[data-ai-save]');
      if (saveButton) saveButton.disabled = record.saved || currentIssues.length > 0;
    }
    TF.$('aiReadyCount').textContent = records.filter((row) => !row.saved && issues(row).length === 0).length.toLocaleString();
    TF.$('aiReviewCount').textContent = records.filter((row) => !row.saved && issues(row).length > 0).length.toLocaleString();
  }

  function analyze() {
    const raw = TF.$('aiBulkPaste').value;
    const forms = Parser.splitForms(raw);
    if (!forms.length) {
      TF.toast('Paste at least one 2FLY order form first', true);
      return;
    }
    records = forms.map((form, index) => mapParsedForm(Parser.parseForm(form), index));
    TF.$('aiBatchNotice').classList.remove('hidden');
    TF.$('aiBatchNotice').innerHTML = '<strong>' + records.length + ' order' + (records.length === 1 ? '' : 's') + ' detected.</strong> Nothing has been saved yet. Review fulfillment, J&T shipping, and optional payment details below.';
    render();
  }

  async function compressProof(file) {
    if (!file || file.type === 'application/pdf' || !String(file.type || '').startsWith('image/')) return file;
    if (file.size <= 450000 || !('createImageBitmap' in window)) return file;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return file;
      let best = null;
      for (const longest of [1800, 1600, 1400, 1200]) {
        const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.84, 0.76, 0.68]) {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (!blob) continue;
          if (!best || blob.size < best.size) best = blob;
          if (blob.size <= 450000) break;
        }
        if (best && best.size <= 450000) break;
      }
      if (!best || best.size >= file.size) return file;
      const base = file.name.replace(/\.[^.]+$/, '') || 'payment-proof';
      return new File([best], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } catch (error) {
      console.warn('AI Intake proof compression skipped:', error);
      return file;
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
    }
  }

  async function uploadProofFile(file) {
    const prepared = await compressProof(file);
    if (prepared.size > 8 * 1024 * 1024) throw new Error('Payment proof is too large. Use a screenshot or file below 8 MB.');
    const safe = prepared.name.replace(/[^a-zA-Z0-9._-]/g, '-');
    const path = TF.state.session.user.id + '/' + TF.today() + '/' + crypto.randomUUID() + '-' + safe;
    const result = await TF.state.supa.storage.from('payment-proofs').upload(path, prepared, {
      contentType: prepared.type || 'application/octet-stream',
      upsert: false
    });
    if (result.error) throw result.error;
    return path;
  }

  async function findDuplicates(record, fingerprint) {
    const result = await TF.state.supa.rpc('check_duplicate_order_v14', {
      p_phone: record.phone.trim(),
      p_customer_name: record.customer_name.trim(),
      p_total_due: expectedTotal(record),
      p_order_date: record.order_date || TF.today(),
      p_form_fingerprint: fingerprint
    });
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function saveRecord(record) {
    if (record.saved) return true;
    record.save_error = '';
    const currentIssues = issues(record);
    if (currentIssues.length) {
      render();
      return false;
    }

    if (record.payment_enabled && record.payment_method === 'gcash' && record.payment_reference.trim()) {
      await checkPaymentReferenceDuplicate(record);
      if (record.duplicate_payment_refs.length) {
        render();
        return false;
      }
    }

    const fingerprint = await TF.sha256(record.raw);
    if (!record.allow_duplicate) {
      const matches = await findDuplicates(record, fingerprint);
      if (matches.length) {
        record.duplicate_matches = matches;
        render();
        return false;
      }
    }

    let proofPath = '';
    if (record.payment_enabled && record.payment_proof) proofPath = await uploadProofFile(record.payment_proof);

    const order = {
      raw_order_form: record.raw,
      form_fingerprint: fingerprint,
      customer_name: record.customer_name.trim(),
      phone: record.phone.trim(),
      facebook_profile: record.facebook_profile.trim(),
      address: record.address.trim(),
      order_type: 'regular',
      fulfillment_method: record.fulfillment,
      order_date: record.order_date || TF.today(),
      expected_release_date: null,
      shipping_fee_due: record.fulfillment === 'jnt' ? TF.num(record.shipping_fee) : 0,
      actual_courier_cost: 0,
      notes: record.notes.trim()
    };

    const orderItems = record.items.map((item) => ({
      sku: String(item.sku).toUpperCase(),
      size: '',
      quantity: TF.num(item.quantity),
      unit_price: TF.num(item.unit_price)
    }));

    const payment = record.payment_enabled ? {
      payment_date: record.payment_date || TF.today(),
      amount: record.payment_amount_auto ? expectedTotal(record) : TF.num(record.payment_amount),
      payment_method: record.payment_method,
      cash_account_id: record.payment_account_id,
      reference_number: record.payment_reference.trim(),
      proof_storage_path: proofPath,
      notes: null
    } : null;

    const result = record.payment_enabled
      ? await TF.state.supa.rpc('create_order_with_payment_submission_v16', { p_order: order, p_items: orderItems, p_payment: payment })
      : await TF.state.supa.rpc('create_daily_order_v14', { p_order: order, p_items: orderItems, p_payment: null, p_confirm_payment: false });

    if (result.error) throw result.error;
    record.saved = true;
    record.saved_order_id = (result.data && result.data.order_id) || '';
    record.saved_order_number = (result.data && result.data.order_number) || '';
    record.save_error = '';
    return true;
  }

  async function saveOne(id, button) {
    if (SAFE_TEST) { TF.toast('Safe Test Mode is on. No real order was created.', true); return; }
    const record = records.find((row) => row.id === id);
    if (!record) return;
    TF.setLoading(button, true, 'Saving…');
    try {
      const saved = await saveRecord(record);
      if (saved) TF.toast((record.saved_order_number || 'Order') + ' saved');
    } catch (error) {
      record.save_error = error.message || String(error);
      TF.fail(error, 'AI Intake order not saved');
    } finally {
      TF.setLoading(button, false);
      render();
    }
  }

  async function saveAllReady() {
    if (SAFE_TEST) { TF.toast('Safe Test Mode is on. No real orders were created.', true); return; }
    if (savingBatch) return;
    const button = TF.$('aiSaveReadyBtn');
    const ready = records.filter((record) => !record.saved && issues(record).length === 0);
    if (!ready.length) {
      TF.toast('No ready orders to save yet', true);
      return;
    }
    savingBatch = true;
    TF.setLoading(button, true, 'Saving batch…');
    let saved = 0;
    let failed = 0;
    try {
      for (const record of ready) {
        try {
          const ok = await saveRecord(record);
          if (ok) saved += 1;
        } catch (error) {
          record.save_error = error.message || String(error);
          failed += 1;
        }
        render();
      }
      if (failed) TF.toast(saved + ' saved; ' + failed + ' failed', true);
      else TF.toast(saved + ' order' + (saved === 1 ? '' : 's') + ' saved');
    } finally {
      savingBatch = false;
      TF.setLoading(button, false);
      render();
    }
  }

  function applyDefaults() {
    const fulfillment = TF.$('aiDefaultFulfillment').value;
    const account = TF.$('aiDefaultAccount').value;
    for (const record of records) {
      if (record.saved) continue;
      if (fulfillment) {
        record.fulfillment = fulfillment;
        if (fulfillment !== 'jnt') record.shipping_fee = '0';
      }
      if (account && !record.payment_account_id) record.payment_account_id = account;
      if (record.payment_amount_auto) record.payment_amount = expectedTotal(record);
    }
    render();
    TF.toast('Batch defaults applied');
  }

  function handleInput(event) {
    const field = event.target.dataset.aiField;
    const id = event.target.dataset.id;
    if (!field || !id) return;
    const record = records.find((row) => row.id === id);
    if (!record || record.saved) return;

    if (field === 'payment_enabled' || field === 'allow_duplicate') {
      record[field] = event.target.checked;
      if (field === 'payment_enabled' && record.payment_enabled && record.payment_amount_auto) record.payment_amount = expectedTotal(record);
      render();
      return;
    }

    record[field] = event.target.value;
    if (field === 'fulfillment') {
      if (record.ocr_amount !== null) applyPaymentAmountToShipping(record, record.ocr_amount);
      else if (record.fulfillment !== 'jnt') {
        record.shipping_fee = '0';
        record.shipping_fee_source = 'fulfillment';
        record.shipping_review_message = '';
      } else if (record.shipping_fee === '0') {
        record.shipping_fee = '';
        record.shipping_fee_source = '';
      }
      if (record.payment_amount_auto) record.payment_amount = expectedTotal(record);
      render();
      return;
    }
    if (field === 'shipping_fee') {
      record.shipping_fee_source = 'manual';
      record.shipping_review_message = '';
      record.shipping_warning = '';
      if (record.payment_amount_auto) record.payment_amount = expectedTotal(record);
      refreshDerived(record);
      return;
    }
    if (field === 'payment_amount') {
      record.payment_amount_auto = false;
      if (record.fulfillment === 'jnt') applyPaymentAmountToShipping(record, record.payment_amount);
      refreshDerived(record);
      return;
    }
    if (field === 'payment_reference') {
      record.duplicate_payment_refs = [];
      refreshDerived(record);
      return;
    }
    refreshDerived(record);
  }

  function normalizeOcr(value) {
    return String(value || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
  }

  function amountCandidates(text) {
    const found = [];
    const seen = new Set();
    const add = (value, source) => {
      const num = Number(String(value || '').replace(/,/g, ''));
      if (!Number.isFinite(num) || num <= 0 || num > 10000000) return;
      const key = num.toFixed(2);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ value: num, source: source || '' });
    };
    const currency = /(?:₱|PHP|PHP\s*₱|P\s*)([\d,]+(?:\.\d{1,2})?)/gi;
    let match;
    while ((match = currency.exec(text))) add(match[1], match[0]);
    for (const line of text.split('\n')) {
      if (!/(?:amount|total|paid|payment|sent)/i.test(line)) continue;
      const nums = line.match(/[\d,]+(?:\.\d{1,2})?/g) || [];
      nums.forEach((value) => add(value, line));
    }
    return found;
  }

  function extractOcrAmount(text, expected) {
    const candidates = amountCandidates(text);
    if (!candidates.length) return null;
    const exact = candidates.find((item) => Math.abs(item.value - expected) <= 0.02);
    if (exact) return exact.value;
    candidates.sort((a, b) => Math.abs(a.value - expected) - Math.abs(b.value - expected));
    return candidates[0].value;
  }

  function extractOcrReference(text) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/(?:ref(?:erence)?(?:\s*(?:no|number|#|id))?|transaction\s*(?:no|number|id))/i.test(lines[i])) continue;
      const joined = lines[i] + ' ' + (lines[i + 1] || '');
      const after = joined.replace(/^.*?(?:ref(?:erence)?(?:\s*(?:no|number|#|id))?|transaction\s*(?:no|number|id))[\s:.\-#]*/i, '');
      const compact = after.replace(/[^A-Z0-9]/gi, '');
      const digitRun = compact.match(/\d{10,20}/);
      if (digitRun) return digitRun[0];
      const mixed = compact.match(/[A-Z0-9]{10,24}/i);
      if (mixed) return mixed[0].toUpperCase();
    }
    return '';
  }

  function dateToIso(year, month, day) {
    const y = Number(year), m = Number(month), d = Number(day);
    if (!y || !m || !d || y < 2020 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function extractOcrDate(text) {
    const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
    let m = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    if (m) return dateToIso(m[3], months[m[1].slice(0,4).toLowerCase()] || months[m[1].slice(0,3).toLowerCase()], m[2]);
    m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
    if (m) {
      const first = Number(m[1]), second = Number(m[2]);
      if (first > 12) return dateToIso(m[3], second, first);
      return dateToIso(m[3], first, second);
    }
    return '';
  }

  function extractOcrAccount(text) {
    return matchGcashAccount(text);
  }


  function normalizeIdentifier(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function resolveCashAccountId(accountName) {
    const wanted = normalizeIdentifier(accountName);
    const match = TF.state.accounts.find((account) => {
      const live = normalizeIdentifier(account.name);
      return live === wanted || live.startsWith(wanted) || wanted.startsWith(live);
    });
    return match ? match.id : '';
  }

  function matchGcashAccount(text) {
    const raw = String(text || '');
    const compact = normalizeIdentifier(raw);
    const digitText = raw.replace(/\D/g, '');
    const scored = GCASH_ACCOUNT_CLUES.map((clue) => {
      let score = 0;
      const matched = [];
      for (const suffix of clue.user_id_suffixes) {
        if (compact.includes(normalizeIdentifier(suffix))) {
          score += 100;
          matched.push('User ID');
          break;
        }
      }
      for (const prefix of clue.mobile_prefixes) {
        if (digitText.includes(String(prefix).replace(/\D/g, ''))) {
          score += 80;
          matched.push('mobile');
          break;
        }
      }
      if (clue.masked_name_patterns.some((pattern) => pattern.test(raw))) {
        score += 30;
        matched.push('masked name');
      }
      return { clue, score, matched };
    }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);

    if (!scored.length) return { id: '', confidence: '', label: '', matched: [] };
    if (scored.length > 1 && scored[0].score === scored[1].score) return { id: '', confidence: '', label: '', matched: [] };

    const winner = scored[0];
    const id = resolveCashAccountId(winner.clue.account_name);
    if (!id) return { id: '', confidence: '', label: winner.clue.account_name, matched: winner.matched };
    return {
      id,
      label: winner.clue.account_name,
      matched: winner.matched,
      confidence: winner.score >= 80 ? 'high' : 'medium'
    };
  }

  function roundMoney(value) {
    return Math.round((TF.num(value) + Number.EPSILON) * 100) / 100;
  }

  function applyPaymentAmountToShipping(record, amount) {
    record.shipping_warning = '';
    record.shipping_review_message = '';

    if (record.fulfillment !== 'jnt') {
      record.shipping_fee = '0';
      record.shipping_fee_source = 'fulfillment';
      return;
    }

    const difference = roundMoney(TF.num(amount) - TF.num(record.product_total));
    if (difference < 0) {
      record.shipping_fee = '';
      record.shipping_fee_source = '';
      record.shipping_review_message = 'Payment is ' + TF.money(Math.abs(difference)) + ' below the product total. Do not calculate a negative shipping fee.';
      return;
    }

    record.shipping_fee = difference.toFixed(2);
    record.shipping_fee_source = 'payment';

    if (difference === 0) {
      record.shipping_review_message = 'J&T shipping calculated as ₱0. Review this order before saving.';
      return;
    }

    const productTotal = Math.max(1, TF.num(record.product_total));
    if (difference >= 1500 || difference / productTotal >= 0.25) {
      record.shipping_warning = 'Calculated J&T shipping is ' + TF.money(difference) + ', which is unusually high. Please review.';
    }
  }

  function normalizePaymentReference(value) {
    return normalizeIdentifier(value);
  }

  async function checkPaymentReferenceDuplicate(record) {
    const reference = normalizePaymentReference(record.payment_reference);
    record.duplicate_payment_refs = [];
    if (!reference || reference.length < 6) return [];

    record.duplicate_payment_checking = true;
    try {
      const result = await TF.state.supa
        .from('payments')
        .select('order_id,reference_number,status,amount,payment_date')
        .not('reference_number', 'is', null)
        .limit(5000);
      if (result.error) throw result.error;
      const matches = (result.data || []).filter((payment) =>
        normalizePaymentReference(payment.reference_number) === reference
      );
      record.duplicate_payment_refs = matches;
      return matches;
    } catch (error) {
      console.warn('Payment reference duplicate check skipped:', error);
      return [];
    } finally {
      record.duplicate_payment_checking = false;
    }
  }

  function updateOcrStatus(record, message, progress) {
    record.ocr_status = 'reading';
    record.ocr_message = message;
    record.ocr_progress = progress || 0;
    const card = document.querySelector('[data-card-id="' + record.id + '"]');
    const box = card && card.querySelector('.ai-ocr-status');
    if (box) {
      box.className = 'notice info ai-ocr-status';
      box.innerHTML = '<strong>Reading payment screenshot…</strong><br><span>' + TF.esc(message) + '</span>';
    }
  }

  async function readPaymentScreenshot(record, file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
      record.ocr_status = 'error';
      record.ocr_message = 'Use an image screenshot (JPG/PNG/WebP) for automatic reading.';
      return;
    }
    if (!window.Tesseract || typeof window.Tesseract.recognize !== 'function') {
      record.ocr_status = 'error';
      record.ocr_message = 'Screenshot reader did not load. Refresh the page and try again.';
      return;
    }

    updateOcrStatus(record, 'Starting reader…', 0);
    const result = await window.Tesseract.recognize(file, 'eng', {
      logger: (info) => {
        if (!info || info.status !== 'recognizing text') return;
        const pct = Math.max(0, Math.min(100, Math.round(TF.num(info.progress) * 100)));
        updateOcrStatus(record, 'Reading text ' + pct + '%', pct);
      }
    });

    const text = normalizeOcr(result && result.data && result.data.text);
    const amount = extractOcrAmount(text, expectedTotal(record));
    const reference = extractOcrReference(text);
    const paymentDate = extractOcrDate(text);
    const accountMatch = extractOcrAccount(text);

    record.ocr_amount = amount;
    record.ocr_reference = reference;
    record.ocr_date = paymentDate;
    record.ocr_account_id = accountMatch.id || '';
    record.ocr_account_confidence = accountMatch.confidence || '';

    const detected = [];
    const missing = [];
    if (amount !== null) {
      record.payment_amount = amount;
      record.payment_amount_auto = false;
      applyPaymentAmountToShipping(record, amount);
      detected.push('amount ' + TF.money(amount));
      if (record.fulfillment === 'jnt' && record.shipping_fee_source === 'payment') detected.push('shipping ' + TF.money(record.shipping_fee));
    } else missing.push('amount');
    if (reference) {
      record.payment_reference = reference;
      detected.push('reference ' + reference);
      await checkPaymentReferenceDuplicate(record);
      if (record.duplicate_payment_refs.length) detected.push('duplicate reference found');
    } else missing.push('reference');
    if (paymentDate) {
      record.payment_date = paymentDate;
      detected.push('date ' + paymentDate);
    }
    if (accountMatch.id) {
      record.payment_account_id = accountMatch.id;
      const account = TF.state.accounts.find((row) => row.id === accountMatch.id);
      detected.push('account ' + (account ? account.name : accountMatch.label) + ' (' + (accountMatch.confidence || 'matched') + ')');
    } else if (accountMatch.label) {
      missing.push('receiving account mapping');
    }

    record.ocr_status = detected.length ? 'done' : 'error';
    record.ocr_message = detected.length
      ? 'Detected ' + detected.join(' · ') + (missing.length ? '. Check manually: ' + missing.join(', ') + '.' : '.')
      : 'Could not confidently read the payment details. Keep the screenshot attached and enter the fields manually.';
  }

  async function handleProof(event) {
    const input = event.target.closest('[data-ai-proof]');
    if (!input) return;
    const record = records.find((row) => row.id === input.dataset.id);
    if (!record || record.saved) return;
    const file = input.files && input.files[0] ? input.files[0] : null;
    record.payment_proof = file;
    record.ocr_status = file ? 'reading' : '';
    record.ocr_message = file ? 'Preparing screenshot…' : '';
    if (!file) {
      render();
      return;
    }
    render();
    try {
      await readPaymentScreenshot(record, file);
    } catch (error) {
      console.error('Payment screenshot OCR failed:', error);
      record.ocr_status = 'error';
      record.ocr_message = 'Automatic reading failed. The screenshot is still attached; enter the payment details manually.';
    }
    render();
  }

  function handleClick(event) {
    const save = event.target.closest('[data-ai-save]');
    if (save) {
      saveOne(save.dataset.aiSave, save);
      return;
    }
    const remove = event.target.closest('[data-ai-remove]');
    if (remove) {
      records = records.filter((row) => row.id !== remove.dataset.aiRemove);
      records.forEach((row, index) => { row.index = index + 1; });
      render();
    }
  }

  TF.ready.then(() => {
    if (!Parser) throw new Error('AI Order Intake parser did not load.');
    TF.$('aiDefaultAccount').innerHTML = '<option value="">No batch default</option>' + TF.state.accounts.map((account) => '<option value="' + TF.esc(account.id) + '">' + TF.esc(account.name) + '</option>').join('');
    TF.$('aiAnalyzeBtn').addEventListener('click', analyze);
    TF.$('aiClearBtn').addEventListener('click', () => {
      records = [];
      TF.$('aiBulkPaste').value = '';
      TF.$('aiBatchNotice').classList.add('hidden');
      render();
    });
    TF.$('aiApplyDefaultsBtn').addEventListener('click', applyDefaults);
    TF.$('aiSaveReadyBtn').addEventListener('click', saveAllReady);
    TF.$('aiOrdersList').addEventListener('input', handleInput);
    TF.$('aiOrdersList').addEventListener('change', async (event) => {
      if (event.target.matches('[data-ai-proof]')) {
        await handleProof(event);
        return;
      }
      handleInput(event);
      if (event.target.dataset.aiField === 'payment_reference') {
        const record = records.find((row) => row.id === event.target.dataset.id);
        if (record && !record.saved) {
          await checkPaymentReferenceDuplicate(record);
          render();
        }
      }
    });
    TF.$('aiOrdersList').addEventListener('click', handleClick);
    render();
  }).catch((error) => TF.fail(error, 'AI Order Intake failed'));
})();