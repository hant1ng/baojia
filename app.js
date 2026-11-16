/* 报价单生成器 - 核心逻辑（纯前端，数据保存在浏览器本地） */
(function () {
  'use strict';

  var STORAGE_KEY = 'quotation_app_state_v1';
  var DEFAULTS_KEY = 'quotation_app_defaults_v1';
  var DEFAULT_SEAL = (typeof window.DEFAULT_SEAL_DATAURL === 'string' && window.DEFAULT_SEAL_DATAURL)
    ? window.DEFAULT_SEAL_DATAURL : 'assets/seal.png';
  var CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  var CN_UNITS = ['', '拾', '佰', '仟'];
  var CN_GROUPS = ['', '万', '亿', '兆'];
  var ALL_PASTE_FIELDS = ['custNo', 'name', 'model', 'unit', 'qty', 'price', 'delivery', 'remark'];

  var state;
  var zoomLevel = 1;
  var saveTimer = null;
  var toastTimer = null;

  /* ---------- 工具 ---------- */
  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function emptyItem() {
    return { name: '', model: '', custNo: '', unit: '', qty: '', price: '', delivery: '', remark: '' };
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n) || 0;
    return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // 去掉值前后的空白（含半角/全角空格、制表符、换行），避免页脚"地址："后出现多余空格
  function trimVal(v) {
    return String(v == null ? '' : v).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDaysISO(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /* 报价单号：年月日时分秒，如 20261116204430 */
  function stampNo() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }
  function fmtDate(iso) {
    if (!iso) return '____年__月__日';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? m[1] + '年' + m[2] + '月' + m[3] + '日' : iso;
  }
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  function flashSaved() {
    var el = document.getElementById('save-status');
    el.textContent = '✓ 已自动保存';
    el.classList.add('flash');
    setTimeout(function () { el.classList.remove('flash'); }, 1000);
  }

  /* 人民币大写 */
  function intToChinese(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return '';
    var s = String(n), groups = [];
    while (s.length) { groups.unshift(s.slice(-4)); s = s.slice(0, -4); }
    var result = '', zero = false;
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var bu = CN_GROUPS[groups.length - 1 - gi] || '';
      var gs = '';
      for (var i = 0; i < g.length; i++) {
        var d = Number(g[i]);
        var pos = g.length - 1 - i;
        if (d === 0) {
          if (gs !== '' || result !== '') zero = true;
        } else {
          if (zero) { gs += '零'; zero = false; }
          gs += CN_DIGITS[d] + CN_UNITS[pos];
        }
      }
      if (gs !== '') { result += gs + bu; zero = false; }
    }
    return result;
  }
  function toChineseAmount(value) {
    var cents = Math.round((Number(value) || 0) * 100);
    if (cents === 0) return '零元整';
    var neg = cents < 0;
    cents = Math.abs(cents);
    var yuan = Math.floor(cents / 100);
    var jiao = Math.floor((cents % 100) / 10);
    var fen = cents % 10;
    var out = yuan > 0 ? intToChinese(yuan) + '元' : '零元';
    if (jiao > 0) out += CN_DIGITS[jiao] + '角';
    else if (fen > 0 && yuan > 0) out += '零';
    if (fen > 0) out += CN_DIGITS[fen] + '分';
    else out += '整';
    return (neg ? '负' : '') + out;
  }

  /* ---------- 状态与存储 ---------- */
  var DEFAULT_DEFAULTS = {
    company: '', address: '', contact: '', phone: '', bank: '', account: '', tax: '', website: '', email: '',
    remark: '', taxRate: '0', validDays: '1'
  };
  function loadDefaults() {
    var d = Object.assign({}, DEFAULT_DEFAULTS);
    try {
      var raw = localStorage.getItem(DEFAULTS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') Object.keys(d).forEach(function (k) {
          if (p[k] != null) d[k] = p[k];
        });
      }
    } catch (e) { console.warn('读取默认值失败', e); }
    return d;
  }
  function saveDefaults(d) {
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); return true; }
    catch (e) { return false; }
  }
  function emptyState() {
    var def = loadDefaults();
    var days = Number(def.validDays);
    if (!isFinite(days)) days = 1;
    return {
      seller: {
        company: def.company || '', address: def.address || '', contact: def.contact || '',
        phone: def.phone || '', bank: def.bank || '', account: def.account || '',
        tax: def.tax || '', website: def.website || '', email: def.email || ''
      },
      customers: [{ id: uid(), name: '', address: '', contact: '', phone: '' }],
      activeCustomerId: '',
      doc: {
        no: stampNo(),
        date: todayISO(),
        validUntil: addDaysISO(days),
        taxRate: def.taxRate != null && def.taxRate !== '' ? String(def.taxRate) : '0',
        remark: def.remark || ''
      },
      items: [emptyItem()],
      sealData: '',
      logoData: '',
      logoWidth: 40,
      logoHeight: 16,
      logoTrimmed: false,
      showDelivery: false,
      deliveryTouched: false
    };
  }
  function sampleState() {
    var s = emptyState();
    s.seller = {
      company: '示例科技有限公司',
      address: '广东省深圳市南山区科技园南路 88 号',
      contact: '王经理',
      phone: '0755-8888 6666',
      bank: '中国银行深圳科技园支行',
      account: '1234 5678 9012 345',
      tax: '91440300MA5XXXXXX',
      website: 'www.example.com',
      email: 'sales@example.com'
    };
    s.customers = [{
      id: uid(),
      name: '远方贸易集团有限公司',
      address: '上海市浦东新区世纪大道 100 号',
      contact: '李经理',
      phone: '021-6666 8888'
    }];
    s.activeCustomerId = s.customers[0].id;
    s.doc = {
      no: 'BJ' + todayISO().replace(/-/g, '') + '001',
      date: todayISO(),
      validUntil: addDaysISO(30),
      taxRate: '13',
      remark: '1. 本报价单有效期 30 天，逾期价格需重新确认。\n2. 付款方式：合同签订后 30 日内付清全款。\n3. 交货地点：需方指定地点；运费由供方承担。\n4. 本报价单经双方盖章确认后生效。'
    };
    s.items = [
      { name: '工业交换机', model: 'S5720-28P', custNo: 'CUS-1001', unit: '台', qty: '10', price: '2350', delivery: '15天', remark: '含税含运费' },
      { name: '光纤模块', model: 'SFP-GE-LX', custNo: 'CUS-1002', unit: '只', qty: '20', price: '180', delivery: '7天', remark: '' },
      { name: '安装调试服务', model: '现场实施', custNo: 'SVC-007', unit: '项', qty: '1', price: '2800', delivery: '另行约定', remark: '含现场培训' }
    ];
    return s;
  }
  function loadState() {
    var base = emptyState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      var p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        base.seller = Object.assign(base.seller, p.seller || {});
        base.doc = Object.assign(base.doc, p.doc || {});
        if (Array.isArray(p.customers) && p.customers.length) base.customers = p.customers;
        if (Array.isArray(p.items) && p.items.length) {
          base.items = p.items.map(function (r) {
            var item = emptyItem();
            Object.keys(item).forEach(function (k) { item[k] = r[k] == null ? '' : r[k]; });
            return item;
          });
        }
        base.sealData = typeof p.sealData === 'string' ? p.sealData : '';
        base.logoData = typeof p.logoData === 'string' ? p.logoData : '';
        base.logoWidth = Number(p.logoWidth) || 40;
        base.logoHeight = Number(p.logoHeight) || 16;
        base.logoTrimmed = !!p.logoTrimmed;
        // 老数据没有 deliveryTouched：说明用户从未主动设置过交期开关，一律套用新默认（不勾选）
        base.deliveryTouched = p.deliveryTouched === true;
        base.showDelivery = base.deliveryTouched ? (p.showDelivery === true) : false;
        if (!base.customers.some(function (c) { return c.id === p.activeCustomerId; })) {
          base.activeCustomerId = base.customers[0].id;
        } else {
          base.activeCustomerId = p.activeCustomerId;
        }
      }
    } catch (e) {
      console.warn('读取本地数据失败', e);
    }
    return base;
  }
  function saveState(silent) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (!silent) flashSaved();
    } catch (e) {
      if (!silent) {
        var el = document.getElementById('save-status');
        el.textContent = '本地存储不可用';
        toast('当前浏览器不允许本地存储，数据仅保留在本次会话');
      }
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveState(true); }, 250);
  }
  function ensureCustomer() {
    var c = state.customers.find(function (x) { return x.id === state.activeCustomerId; });
    if (!c) {
      c = { id: uid(), name: '', address: '', contact: '', phone: '' };
      state.customers.push(c);
      state.activeCustomerId = c.id;
    }
    return c;
  }
  function pasteFields() {
    return state.showDelivery
      ? ALL_PASTE_FIELDS.slice()
      : ALL_PASTE_FIELDS.filter(function (f) { return f !== 'delivery'; });
  }
  function getBound(path) {
    var parts = path.split('.');
    var root = parts[0];
    var obj = root === 'seller' ? state.seller : root === 'doc' ? state.doc : root === 'cust' ? ensureCustomer() : state;
    return obj[parts[1]];
  }
  function setBound(path, value) {
    var parts = path.split('.');
    var root = parts[0];
    var obj = root === 'seller' ? state.seller : root === 'doc' ? state.doc : root === 'cust' ? ensureCustomer() : state;
    obj[parts[1]] = value;
    if (path === 'cust.name') {
      var opt = document.querySelector('#customer-select option[value="' + state.activeCustomerId + '"]');
      if (opt) opt.textContent = value || '（未命名客户）';
    }
  }

  /* ---------- 计算 ---------- */
  function computeTotals() {
    var subtotal = 0;
    state.items.forEach(function (r) {
      subtotal += (Number(r.qty) || 0) * (Number(r.price) || 0);
    });
    var rate = Number(state.doc.taxRate) || 0;
    var tax = subtotal * rate / 100;
    return { subtotal: subtotal, tax: tax, total: subtotal + tax, rate: rate };
  }
  function updateTotalsUI(t) {
    document.getElementById('t-subtotal').textContent = money(t.subtotal);
    document.getElementById('t-tax').textContent = money(t.tax);
    document.getElementById('t-total').textContent = money(t.total);
    document.getElementById('t-upper').textContent = toChineseAmount(t.total);
  }

  /* ---------- 明细表 ---------- */
  function renderItems() {
    var body = document.getElementById('items-body');
    var editor = document.querySelector('.items-editor');
    if (editor) editor.classList.toggle('hide-delivery', !state.showDelivery);
    var hint = document.getElementById('paste-hint');
    if (hint) {
      var order = state.showDelivery
        ? '客户料号 → 品名 → 型号规格 → 单位 → 数量 → 单价 → <b>交期</b> → 备注'
        : '客户料号 → 品名 → 型号规格 → 单位 → 数量 → 单价 → 备注';
      hint.innerHTML = '支持从 Excel 整块粘贴：按 <b>' + order + '</b> 的顺序复制多行，点第 1 行第 1 格后按 Ctrl+V，即可一次填入多行（金额自动计算，不必复制）。';
    }
    body.innerHTML = state.items.map(function (r, i) {
      return '<tr data-i="' + i + '">' +
        '<td class="row-idx">' + (i + 1) + '</td>' +
        '<td><input type="text" data-f="custNo" value="' + esc(r.custNo) + '" placeholder="客户料号"></td>' +
        '<td><input type="text" data-f="name" value="' + esc(r.name) + '" placeholder="品名"></td>' +
        '<td><input type="text" data-f="model" value="' + esc(r.model) + '" placeholder="型号"></td>' +
        '<td><input type="text" data-f="unit" value="' + esc(r.unit) + '" placeholder="个"></td>' +
        '<td><input type="number" data-f="qty" value="' + esc(r.qty) + '" min="0" step="any" placeholder="0"></td>' +
        '<td><input type="number" data-f="price" value="' + esc(r.price) + '" min="0" step="any" placeholder="0.00"></td>' +
        '<td class="amt-cell">' + money((Number(r.qty) || 0) * (Number(r.price) || 0)) + '</td>' +
        '<td class="delivery-col"><input type="text" data-f="delivery" value="' + esc(r.delivery) + '" placeholder="交期"></td>' +
        '<td><input type="text" data-f="remark" value="' + esc(r.remark) + '" placeholder="备注"></td>' +
        '<td><button type="button" class="row-del" title="删除此行">×</button></td>' +
        '</tr>';
    }).join('');
  }
  function bindItems() {
    var body = document.getElementById('items-body');
    body.addEventListener('input', function (e) {
      var input = e.target.closest('input[data-f]');
      if (!input) return;
      var tr = input.closest('tr');
      var i = Number(tr.getAttribute('data-i'));
      var f = input.getAttribute('data-f');
      var v = input.value;
      state.items[i][f] = (f === 'qty' || f === 'price') ? (v === '' ? '' : v) : v;
      if (f === 'qty' || f === 'price') {
        tr.querySelector('.amt-cell').textContent = money((Number(state.items[i].qty) || 0) * (Number(state.items[i].price) || 0));
      }
      var t = computeTotals();
      updateTotalsUI(t);
      renderPreview();
      scheduleSave();
    });

    /* 整块粘贴：支持从 Excel 复制 N 列 × N 行，按字段顺序填入 */
    body.addEventListener('paste', function (e) {
      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;
      var text = cb.getData('text') || cb.getData('text/plain') || '';
      if (!text || !/[\t\r\n]/.test(text)) return; // 单值粘贴交给浏览器默认处理
      e.preventDefault();

      var fields = pasteFields();
      var lines = text.replace(/\r\n?/g, '\n').split('\n');
      var rowsData = lines.map(function (line) { return line.split('\t'); });
      while (rowsData.length && rowsData[rowsData.length - 1].every(function (c) { return !String(c).trim(); })) rowsData.pop();
      if (!rowsData.length) return;

      var input = e.target.closest('input[data-f]');
      var startRow = 0, startCol = 0;
      if (input) {
        var tr = input.closest('tr');
        startRow = Number(tr.getAttribute('data-i'));
        startCol = Math.max(0, fields.indexOf(input.getAttribute('data-f')));
      }

      rowsData.forEach(function (cols, r) {
        var idx = startRow + r;
        while (state.items.length <= idx) state.items.push(emptyItem());
        cols.forEach(function (raw, c) {
          var field = fields[startCol + c];
          if (!field) return;
          var v = String(raw).replace(/\u00a0/g, ' ').trim();
          if (field === 'qty' || field === 'price') v = v.replace(/[,¥￥\s]/g, '');
          state.items[idx][field] = v;
        });
      });

      renderItems();
      renderPreview();
      updateTotalsUI(computeTotals());
      saveState();
      toast('已粘贴 ' + rowsData.length + ' 行明细');

      var rows = body.querySelectorAll('tr');
      var first = rows[startRow];
      var focusField = fields[startCol] || 'name';
      var target = first && first.querySelector('input[data-f="' + focusField + '"]');
      if (target) target.focus();
    });

    body.addEventListener('click', function (e) {
      var btn = e.target.closest('.row-del');
      if (!btn) return;
      var tr = btn.closest('tr');
      var i = Number(tr.getAttribute('data-i'));
      state.items.splice(i, 1);
      if (!state.items.length) state.items.push(emptyItem());
      renderItems();
      renderPreview();
      saveState();
    });
    document.getElementById('btn-add-row').addEventListener('click', function () {
      state.items.push(emptyItem());
      renderItems();
      var rows = document.querySelectorAll('#items-body tr');
      var last = rows[rows.length - 1];
      if (last) last.querySelector('input[data-f="name"]').focus();
    });
  }

  /* ---------- 默认值设置 ---------- */
  function syncDefaultsUI() {
    var d = loadDefaults();
    document.querySelectorAll('[data-def]').forEach(function (el) {
      el.value = d[el.getAttribute('data-def')] != null ? d[el.getAttribute('data-def')] : '';
    });
  }
  function bindDefaults() {
    document.getElementById('btn-save-defaults').addEventListener('click', function () {
      var d = Object.assign({}, DEFAULT_DEFAULTS);
      document.querySelectorAll('[data-def]').forEach(function (el) {
        d[el.getAttribute('data-def')] = el.value;
      });
      var ok = saveDefaults(d);
      toast(ok ? '默认值已保存，点“清空”即可套用' : '保存失败：当前浏览器不允许本地存储');
    });
    document.getElementById('btn-clear-defaults').addEventListener('click', function () {
      if (!confirm('确定清除所有默认值？')) return;
      saveDefaults(Object.assign({}, DEFAULT_DEFAULTS));
      syncDefaultsUI();
      toast('默认值已清除');
    });
  }

  /* ---------- 交期列开关 ---------- */
  function bindDeliveryToggle() {
    var chk = document.getElementById('chk-delivery');
    if (!chk) return;
    chk.checked = state.showDelivery !== false;
    chk.addEventListener('change', function () {
      state.showDelivery = chk.checked;
      state.deliveryTouched = true;
      renderItems();
      renderPreview();
      saveState();
      toast(chk.checked ? '交期列已显示' : '交期列已隐藏（数据仍保留）');
    });
  }

  /* ---------- 客户 ---------- */
  function renderCustomerOptions() {
    var sel = document.getElementById('customer-select');
    sel.innerHTML = state.customers.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name || '（未命名客户）') + '</option>';
    }).join('');
    sel.value = state.activeCustomerId;
  }
  function renderCustomerFields() {
    document.querySelectorAll('[data-bind^="cust."]').forEach(function (el) {
      el.value = getBound(el.getAttribute('data-bind')) || '';
    });
  }
  function bindCustomers() {
    var sel = document.getElementById('customer-select');
    sel.addEventListener('change', function () {
      state.activeCustomerId = sel.value;
      renderCustomerFields();
      renderPreview();
      saveState();
    });
    document.getElementById('btn-customer-new').addEventListener('click', function () {
      var c = { id: uid(), name: '', address: '', contact: '', phone: '' };
      state.customers.push(c);
      state.activeCustomerId = c.id;
      renderCustomerOptions();
      renderCustomerFields();
      renderPreview();
      saveState();
      var f = document.querySelector('[data-bind="cust.name"]');
      if (f) f.focus();
    });
    document.getElementById('btn-customer-save').addEventListener('click', function () {
      saveState();
      toast('客户信息已保存到本地');
    });
    document.getElementById('btn-customer-delete').addEventListener('click', function () {
      var c = ensureCustomer();
      if (!confirm('确定删除客户「' + (c.name || '未命名客户') + '」？')) return;
      state.customers = state.customers.filter(function (x) { return x.id !== c.id; });
      if (!state.customers.length) state.customers.push({ id: uid(), name: '', address: '', contact: '', phone: '' });
      state.activeCustomerId = state.customers[0].id;
      renderCustomerOptions();
      renderCustomerFields();
      renderPreview();
      saveState();
      toast('客户已删除');
    });
  }

  /* ---------- 预览 ---------- */
  function renderPreview() {
    var page = document.getElementById('quote-page');
    var s = state.seller, d = state.doc, c = ensureCustomer();
    var t = computeTotals();
    var sealSrc = state.sealData || DEFAULT_SEAL;

    var displayItems = state.items.filter(function (r) {
      return String(r.name || '').trim() || String(r.model || '').trim() || String(r.custNo || '').trim() ||
        String(r.delivery || '').trim() || String(r.remark || '').trim() || Number(r.qty) > 0 || Number(r.price) > 0;
    });
    if (!displayItems.length) displayItems = [{}];

    var rows = displayItems.map(function (r, i) {
      var amt = (Number(r.qty) || 0) * (Number(r.price) || 0);
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(r.custNo) + '</td>' +
        '<td class="left">' + esc(r.name) + '</td>' +
        '<td class="left">' + esc(r.model) + '</td>' +
        '<td>' + esc(r.unit) + '</td>' +
        '<td>' + esc(r.qty) + '</td>' +
        '<td class="right">' + esc(r.price === '' || r.price == null ? '' : money(r.price).slice(1)) + '</td>' +
        '<td class="right">' + money(amt).slice(1) + '</td>' +
        (state.showDelivery ? '<td>' + esc(r.delivery) + '</td>' : '') +
        '<td class="left">' + esc(r.remark) + '</td>' +
        '</tr>';
    }).join('');

    var taxText = t.rate ? t.rate + '%' : '—';

    page.innerHTML =
      '<div class="quote-header">' +
        '<div class="quote-brand">' +
          (state.logoData ? '<img class="quote-logo" src="' + state.logoData + '" alt="Logo" style="width:' + state.logoWidth + 'mm;max-height:' + state.logoHeight + 'mm;">' : '') +
          '<div class="quote-brand-text"><div class="quote-company">' + esc(s.company || '公司名称') + '</div>' +
          '<div class="quote-company-sub">' + esc(s.address || '') + '</div></div>' +
        '</div>' +
        '<div class="quote-doc-title"><div class="cn">报价单</div><div class="en">QUOTATION</div></div>' +
      '</div>' +

      '<div class="quote-meta">' +
        '<span>单号：<b>' + esc(d.no || '—') + '</b></span>' +
        '<span>报价日期：<b>' + fmtDate(d.date) + '</b></span>' +
        '<span>有效期至：<b>' + fmtDate(d.validUntil) + '</b></span>' +
        '<span>税率：<b>' + esc(taxText) + '</b></span>' +
      '</div>' +

      '<div class="section-title">客户信息</div>' +
      '<table class="info-table"><tbody>' +
        '<tr><td class="lbl">客户名称</td><td class="val">' + esc(c.name) + '</td>' +
            '<td class="lbl2">联系人</td><td class="val2">' + esc(c.contact) + '</td></tr>' +
        '<tr><td class="lbl">客户地址</td><td class="val" colspan="3">' + esc(c.address) + '</td></tr>' +
        '<tr><td class="lbl">联系电话</td><td class="val">' + esc(c.phone) + '</td>' +
            '<td class="lbl2">报价单号</td><td class="val2">' + esc(d.no || '—') + '</td></tr>' +
      '</tbody></table>' +

      '<div class="section-title">产品报价明细</div>' +
      '<table class="quote-table"><colgroup>' +
        '<col class="c-idx"><col class="c-custno"><col class="c-name"><col class="c-model">' +
        '<col class="c-unit"><col class="c-qty"><col class="c-price"><col class="c-amt">' +
        (state.showDelivery ? '<col class="c-delivery">' : '') + '<col class="c-remark">' +
      '</colgroup>' +
      '<thead><tr><th>序号</th><th>客户料号</th><th>品名</th><th>型号规格</th><th>单位</th><th>数量</th><th>单价(¥)</th><th>金额(¥)</th>' +
        (state.showDelivery ? '<th>交期</th>' : '') + '<th>备注</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +

      '<table class="summary-table"><tbody>' +
        '<tr><td class="slbl">不含税金额</td><td class="sval">' + money(t.subtotal).slice(1) + '</td>' +
            '<td class="slbl">税额</td><td class="sval">' + money(t.tax).slice(1) + '</td></tr>' +
        '<tr><td class="slbl grand-label">含税合计</td>' +
            '<td class="sval grand-value" colspan="3">' + money(t.total) + '</td></tr>' +
        '<tr class="upper-row"><td class="slbl">大写金额</td>' +
            '<td class="sval" colspan="3">' + toChineseAmount(t.total) + '</td></tr>' +
      '</tbody></table>' +

      '<div class="remark-box"><div class="remark-title">备注与条款</div>' +
      '<div class="remark-body">' + esc(d.remark || '') + '</div></div>' +

      '<div class="sig-row">' +
        '<div class="sig-cell">' +
          '<div class="sig-line">报价单位（盖章）：</div>' +
          '<div class="sig-sub">单位名称：' + esc(s.company) + '<br>联系人：' + esc(s.contact) + '<br>日　期：' + fmtDate(d.date) + '</div>' +
          '<img class="seal-stamp" src="' + sealSrc + '" alt="公章">' +
        '</div>' +
        '<div class="sig-cell">' +
          '<div class="sig-line">客户确认（盖章）：</div>' +
          '<div class="sig-sub">客户名称：' + esc(c.name) + '<br>联系人：' + esc(c.contact) + '<br>日　期：____年__月__日</div>' +
        '</div>' +
      '</div>' +

      '<div class="page-footer">' +
        '<div>地址：' + esc(trimVal(s.address)) +
          (trimVal(s.website) ? '　网址：' + esc(trimVal(s.website)) : '') + '<br>电话：' + esc(trimVal(s.phone)) +
          (trimVal(s.email) ? '　邮箱：' + esc(trimVal(s.email)) : '') + '</div>' +
        '<div>开户行：' + esc(trimVal(s.bank)) +
          (trimVal(s.tax) ? '　税号：' + esc(trimVal(s.tax)) : '') + '<br>账号：' + esc(trimVal(s.account)) + '</div>' +
      '</div>';

    updateTotalsUI(t);
  }

  /* ---------- 缩放 ---------- */
  function applyZoom() {
    document.getElementById('quote-page').style.zoom = zoomLevel;
    document.getElementById('zoom-label').textContent = Math.round(zoomLevel * 100) + '%';
  }
  function fitZoom() {
    var stage = document.getElementById('preview-stage');
    var a4px = 297 * 96 / 25.4;
    var avail = stage.clientWidth - 56;
    zoomLevel = Math.max(0.3, Math.min(1, avail / a4px));
    applyZoom();
  }

  /* ---------- 公章 ---------- */
  function bindSeal() {
    var fileInput = document.getElementById('seal-file');
    var thumb = document.getElementById('seal-thumb');
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { toast('请选择 PNG 图片文件'); return; }
      var reader = new FileReader();
      reader.onload = function (ev) {
        state.sealData = ev.target.result;
        thumb.src = state.sealData;
        renderPreview();
        saveState();
        toast('公章已更新（已保存到本地）');
      };
      reader.readAsDataURL(f);
    });
    document.getElementById('btn-seal-reset').addEventListener('click', function () {
      state.sealData = '';
      thumb.src = DEFAULT_SEAL;
      fileInput.value = '';
      renderPreview();
      saveState();
      toast('已恢复默认公章');
    });
  }

  /* ---------- 公司 Logo ---------- */
  function updateLogoUI() {
    var thumb = document.getElementById('logo-thumb');
    var placeholder = document.getElementById('logo-placeholder');
    if (!thumb || !placeholder) return;
    if (state.logoData) {
      thumb.src = state.logoData;
      thumb.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      thumb.removeAttribute('src');
      thumb.style.display = 'none';
      placeholder.style.display = 'flex';
    }
    var w = document.getElementById('logo-width');
    var h = document.getElementById('logo-height');
    if (w) { w.value = state.logoWidth; document.getElementById('logo-width-val').textContent = state.logoWidth + 'mm'; }
    if (h) { h.value = state.logoHeight; document.getElementById('logo-height-val').textContent = state.logoHeight + 'mm'; }
  }
  function readImage(file, cb) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    var reader = new FileReader();
    reader.onload = function (ev) { cb(ev.target.result); };
    reader.readAsDataURL(file);
  }
  /* 自动裁掉图片四周的纯白/透明边，避免 logo 被大片留白“缩小” */
  function trimLogo(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, c.width, c.height).data;
        var minX = c.width, minY = c.height, maxX = -1, maxY = -1;
        for (var y = 0; y < c.height; y++) {
          for (var x = 0; x < c.width; x++) {
            var i = (y * c.width + x) * 4;
            var a = data[i + 3], r = data[i], g = data[i + 1], b = data[i + 2];
            var blank = a < 24 || (r > 246 && g > 246 && b > 246);
            if (!blank) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) { cb(dataUrl); return; }
        var pad = 2;
        minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
        maxX = Math.min(c.width - 1, maxX + pad); maxY = Math.min(c.height - 1, maxY + pad);
        var tw = maxX - minX + 1, th = maxY - minY + 1;
        var out = document.createElement('canvas');
        out.width = tw; out.height = th;
        out.getContext('2d').drawImage(c, minX, minY, tw, th, 0, 0, tw, th);
        cb(out.toDataURL('image/png'));
      } catch (e) {
        console.warn('裁剪 Logo 失败', e);
        cb(dataUrl);
      }
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }
  function bindLogo() {
    var fileInput = document.getElementById('logo-file');
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      readImage(f, function (dataUrl) {
        trimLogo(dataUrl, function (cropped) {
          state.logoData = cropped;
          state.logoTrimmed = true;
          updateLogoUI();
          renderPreview();
          saveState();
          toast('Logo 已更新，四周白边已自动去除');
        });
      });
    });
    document.getElementById('btn-logo-trim').addEventListener('click', function () {
      if (!state.logoData) { toast('请先上传 Logo'); return; }
      trimLogo(state.logoData, function (cropped) {
        state.logoData = cropped;
        state.logoTrimmed = true;
        updateLogoUI();
        renderPreview();
        saveState();
        toast('已去除 Logo 白边');
      });
    });
    document.getElementById('logo-width').addEventListener('input', function () {
      state.logoWidth = Number(this.value);
      document.getElementById('logo-width-val').textContent = state.logoWidth + 'mm';
      renderPreview();
      scheduleSave();
    });
    document.getElementById('logo-height').addEventListener('input', function () {
      state.logoHeight = Number(this.value);
      document.getElementById('logo-height-val').textContent = state.logoHeight + 'mm';
      renderPreview();
      scheduleSave();
    });
    document.getElementById('btn-logo-reset').addEventListener('click', function () {
      state.logoData = '';
      fileInput.value = '';
      updateLogoUI();
      renderPreview();
      saveState();
      toast('已移除 Logo，报价单将不显示');
    });
  }

  /* ---------- PDF 导出 ---------- */
  function safeFileName(name) {
    return String(name || '报价单').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
  }
  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  }
  function printQuotation() {
    window.print();
  }
  async function downloadPdf() {
    var btn = document.getElementById('btn-pdf');
    var hasLib = (typeof window.html2canvas === 'function') && window.jspdf && window.jspdf.jsPDF;
    if (!hasLib) {
      toast('PDF 组件未加载，已打开打印窗口（可另存为 PDF）');
      window.print();
      return;
    }
    var page = document.getElementById('quote-page');
    var stage = document.getElementById('preview-stage');
    var oldZoom = page.style.zoom;
    var oldOverflow = stage.style.overflow;
    var oldMaxHeight = stage.style.maxHeight;
    var originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在生成…';
    page.style.zoom = 1;
    stage.style.overflow = 'visible';
    stage.style.maxHeight = 'none';
    await nextFrame();
    try {
      var canvas = await window.html2canvas(page, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        imageTimeout: 15000
      });
      var imgData = canvas.toDataURL('image/jpeg', 0.95);
      var pdf = new window.jspdf.jsPDF({ orientation: 'l', unit: 'mm', format: 'a4', compress: true });
      var pdfW = 297, pdfH = 210;
      var renderW = pdfW;
      var renderH = canvas.height * renderW / canvas.width;
      var y = 0, pageNo = 0;
      while (y < renderH - 0.5 && pageNo < 60) {
        if (pageNo > 0) pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, -y, renderW, renderH, undefined, 'FAST');
        y += pdfH;
        pageNo++;
      }
      var cust = ensureCustomer();
      var name = '报价单_' + (cust.name || '客户') + '_' + (state.doc.no || todayISO());
      pdf.save(safeFileName(name) + '.pdf');
      toast('PDF 已生成并下载');
    } catch (err) {
      console.error('PDF 生成失败', err);
      toast('生成失败，已打开打印窗口（可另存为 PDF）');
      window.print();
    } finally {
      page.style.zoom = oldZoom;
      stage.style.overflow = oldOverflow;
      stage.style.maxHeight = oldMaxHeight;
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  /* ---------- 初始化 ---------- */
  function bindAll() {
    document.querySelectorAll('[data-bind]').forEach(function (el) {
      var path = el.getAttribute('data-bind');
      el.value = getBound(path) || '';
      el.addEventListener('input', function () {
        setBound(path, el.value);
        renderPreview();
        scheduleSave();
      });
    });
    bindItems();
    bindCustomers();
    bindSeal();
    bindLogo();
    bindDefaults();
    bindDeliveryToggle();

    document.getElementById('btn-print').addEventListener('click', printQuotation);
    document.getElementById('btn-pdf').addEventListener('click', downloadPdf);
    document.getElementById('btn-sample').addEventListener('click', function () {
      if (!confirm('载入示例数据将覆盖当前内容，确定继续？')) return;
      state = sampleState();
      syncAll();
      saveState();
      toast('示例数据已载入');
    });
    document.getElementById('btn-clear').addEventListener('click', function () {
      if (!confirm('确定清空全部数据？此操作不可恢复。')) return;
      state = emptyState();
      syncAll();
      saveState();
      toast('已清空');
    });

    document.getElementById('zoom-in').addEventListener('click', function () {
      zoomLevel = Math.min(1.6, zoomLevel + 0.1); applyZoom();
    });
    document.getElementById('zoom-out').addEventListener('click', function () {
      zoomLevel = Math.max(0.3, zoomLevel - 0.1); applyZoom();
    });
    document.getElementById('zoom-fit').addEventListener('click', fitZoom);
    window.addEventListener('resize', fitZoom);
  }
  function syncAll() {
    document.querySelectorAll('[data-bind]').forEach(function (el) {
      el.value = getBound(el.getAttribute('data-bind')) || '';
    });
    document.getElementById('seal-thumb').src = state.sealData || DEFAULT_SEAL;
    updateLogoUI();
    syncDefaultsUI();
    var chk = document.getElementById('chk-delivery');
    if (chk) chk.checked = state.showDelivery !== false;
    renderCustomerOptions();
    renderCustomerFields();
    renderItems();
    renderPreview();
  }

  document.addEventListener('DOMContentLoaded', function () {
    state = loadState();
    bindAll();
    syncAll();
    applyZoom();
    fitZoom();
    // 旧数据里未处理过白边的 Logo，打开时自动裁一次
    if (state.logoData && !state.logoTrimmed) {
      trimLogo(state.logoData, function (cropped) {
        state.logoData = cropped;
        state.logoTrimmed = true;
        updateLogoUI();
        renderPreview();
        saveState(true);
      });
    }
  });
})();
