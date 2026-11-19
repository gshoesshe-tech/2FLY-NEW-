(() => {
  'use strict';

  function normalizeText(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\\s*\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function splitForms(value) {
    const text = normalizeText(value);
    if (!text) return [];
    const lines = text.split('\n');
    const chunks = [];
    let current = [];
    let sawHeader = false;
    const isHeader = (line) => {
      const clean = String(line || '').replace(/[🛒]/g, '').trim().toUpperCase();
      return clean.includes('ORDER FORM') && clean.includes('2FLY.GALLERIA');
    };
    for (const line of lines) {
      if (isHeader(line)) {
        if (sawHeader && current.some((x) => String(x).trim())) chunks.push(current.join('\n').trim());
        current = [line];
        sawHeader = true;
        continue;
      }
      if (sawHeader) current.push(line);
    }
    if (sawHeader && current.some((x) => String(x).trim())) chunks.push(current.join('\n').trim());
    return sawHeader ? chunks.filter(Boolean) : [text];
  }

  function moneyNumber(value) {
    const match = String(value || '').match(/-?\s*₱?\s*([\d,]+(?:\.\d+)?)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function field(lines, name) {
    const esc = String(name).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const re = new RegExp('^' + esc + '\\s*:\\s*(.*)$', 'i');
    const hit = lines.find((line) => re.test(line));
    return hit ? String(hit.match(re)[1] || '').trim() : '';
  }

  function parseItemLine(line) {
    const m = String(line || '').match(/^[•*]\s*(.+?)\s+[–—-]\s*x\s*(\d+)\s*$/i);
    if (!m) return null;
    const label = m[1].trim();
    const sizeMatch = label.match(/\(\s*Size\s*:\s*([^)]+)\)/i);
    return {
      raw_label: label,
      sku: label.replace(/\(\s*Size\s*:[^)]+\)/i, '').trim().toUpperCase(),
      size: sizeMatch ? sizeMatch[1].trim().toUpperCase() : '',
      quantity: Number(m[2])
    };
  }

  function parseForm(raw) {
    const text = normalizeText(raw);
    const lines = text.split('\n').map((x) => x.trim()).filter((x) => x !== '');
    const groups = [];
    const warnings = [];
    let current = null;

    for (const line of lines) {
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        current = {
          label: header[1].trim().toUpperCase().replace(/\s+/g, ' '),
          items: [],
          quantity: null,
          amount: null
        };
        groups.push(current);
        continue;
      }
      if (!current) continue;
      const item = parseItemLine(line);
      if (item) {
        current.items.push(item);
        continue;
      }
      const qty = line.match(/^Category Qty\s*:\s*(\d+)/i);
      if (qty) current.quantity = Number(qty[1]);
      const amount = line.match(/^Category Amount\s*:\s*(.+)$/i);
      if (amount) current.amount = moneyNumber(amount[1]);
    }

    for (const group of groups) {
      const detailQty = group.items.reduce((sum, item) => sum + item.quantity, 0);
      if (group.quantity === null && detailQty > 0) group.quantity = detailQty;
      if (group.quantity !== null && detailQty > 0 && group.quantity !== detailQty) {
        warnings.push(group.label + ': design lines total ' + detailQty + ', Category Qty says ' + group.quantity + '.');
      }
      if (group.amount === null) warnings.push(group.label + ': Category Amount is missing.');
    }

    const totalAmountLine = lines.find((line) => /^Total Amount\s*:/i.test(line));
    const totalQtyLine = lines.find((line) => /^Total Quantity\s*:/i.test(line));
    const totalItemsLine = lines.find((line) => /^Total Items \(Grand\)\s*:/i.test(line));
    const shownTotal = totalAmountLine ? moneyNumber(totalAmountLine.split(':').slice(1).join(':')) : null;
    const shownQty = totalQtyLine ? Number((totalQtyLine.match(/(\d+)/) || [])[1] || 0) : null;
    const shownItems = totalItemsLine ? Number((totalItemsLine.match(/(\d+)/) || [])[1] || 0) : null;
    const categoryTotal = groups.reduce((sum, group) => sum + Number(group.amount || 0), 0);
    const categoryQty = groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0);

    if (shownTotal !== null && Math.abs(shownTotal - categoryTotal) > 0.02) {
      warnings.push('Product total mismatch: form says ₱' + shownTotal.toLocaleString('en-PH') + ', categories equal ₱' + categoryTotal.toLocaleString('en-PH') + '.');
    }
    if (shownQty !== null && shownQty !== categoryQty) {
      warnings.push('Quantity mismatch: form says ' + shownQty + ', categories equal ' + categoryQty + '.');
    }

    return {
      raw: text,
      customer_name: field(lines, 'Name'),
      phone: field(lines, 'Phone'),
      address: field(lines, 'Address'),
      facebook_profile: [
        'Facebook Link / Profile', 'Facebook Link', 'Facebook Profile',
        'FB Link / Profile', 'FB Link', 'FB Profile', 'Messenger Link', 'Facebook'
      ].map((name) => field(lines, name)).find(Boolean) || '',
      groups,
      product_total: shownTotal !== null ? shownTotal : categoryTotal,
      total_quantity: shownQty !== null ? shownQty : categoryQty,
      total_items: shownItems !== null ? shownItems : categoryQty,
      warnings
    };
  }

  window.TwoFlyAIParser = { normalizeText, splitForms, parseForm, moneyNumber };
})();