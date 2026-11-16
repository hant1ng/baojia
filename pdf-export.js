/* 真实文本 PDF 导出：pdfmake 0.3.x。无需服务器，生成后可复制和搜索中文文字。 */
(function () {
  'use strict';
  var fontRegistered = false;
  var FONT_URL = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';

  function str(v) { return v == null ? '' : String(v); }
  function cell(v, alignment) {
    return { text: str(v), alignment: alignment || 'left', margin: [2, 3, 2, 3], noWrap: false };
  }
  function money(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = 0;
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function validImageData(s) { return typeof s === 'string' && /^data:image\/(?:png|jpeg|jpg);base64,/i.test(s); }
  function toDataUrl(url) {
    if (validImageData(url)) return Promise.resolve(url);
    if (!url) return Promise.resolve(null);
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('图片读取失败：' + response.status);
      return response.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    });
  }
  function imageOrNull(url) {
    return toDataUrl(url).catch(function (err) {
      console.warn('PDF 图片读取失败，已省略对应图片', err);
      return null;
    });
  }
  function amountUpper(n) {
    var digits = '零壹贰叁肆伍陆柒捌玖';
    var units = ['', '拾', '佰', '仟'];
    var groups = ['', '万', '亿', '兆'];
    var cents = Math.round((Number(n) || 0) * 100);
    if (cents === 0) return '零元整';
    var neg = cents < 0;
    cents = Math.abs(cents);
    var yuan = Math.floor(cents / 100);
    var jiao = Math.floor(cents % 100 / 10);
    var fen = cents % 10;
    function integerChinese(value) {
      if (!value) return '零';
      var sections = [];
      while (value) { sections.unshift(value % 10000); value = Math.floor(value / 10000); }
      var out = '', needZero = false;
      sections.forEach(function (section, index) {
        if (!section) { needZero = out.length > 0; return; }
        if (out && (needZero || section < 1000)) out += '零';
        var temp = '', innerZero = false;
        for (var i = 3; i >= 0; i--) {
          var digit = Math.floor(section / Math.pow(10, i)) % 10;
          if (digit === 0) { if (temp) innerZero = true; }
          else {
            if (innerZero) temp += '零';
            temp += digits[digit] + units[i];
            innerZero = false;
          }
        }
        out += temp + (groups[sections.length - index - 1] || '');
        needZero = false;
      });
      return out;
    }
    var result = yuan ? integerChinese(yuan) + '元' : '零元';
    if (jiao) result += digits[jiao] + '角';
    else if (fen && yuan) result += '零';
    if (fen) result += digits[fen] + '分';
    else result += '整';
    return (neg ? '负' : '') + result;
  }
  function dateCN(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    return m ? m[1] + '年' + m[2] + '月' + m[3] + '日' : str(s);
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function safeName(s) { return str(s || '报价单').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60); }
  function infoRow(a, b, c, d) {
    return [cell(a), cell(b), cell(c), cell(d)];
  }
  function line(label, value) {
    return { text: [{ text: label, bold: true }, str(value)], margin: [0, 0, 0, 3] };
  }
  function registerFont() {
    if (fontRegistered) return;
    var font = { normal: FONT_URL, bold: FONT_URL, italics: FONT_URL, bolditalics: FONT_URL };
    window.pdfMake.addFonts({ NotoSansSC: font });
    fontRegistered = true;
  }
  function makeDefinition(data, logo, seal) {
    var seller = data.seller || {}, doc = data.doc || {}, customer = data.customer || {};
    var items = Array.isArray(data.items) ? data.items : [];
    var showDelivery = data.showDelivery === true;
    var subtotal = 0;
    var displayed = items.filter(function (r) {
      return ['custNo','name','model','unit','qty','price','delivery','remark'].some(function (k) { return str(r[k]).trim(); });
    });
    var heads = ['序号','客户料号','品名','型号规格','单位','数量','单价(¥)','金额(¥)'];
    var widths = [24,62,66,94,30,40,63,72];
    if (showDelivery) { heads.push('交期'); widths.push(57); }
    heads.push('备注'); widths.push('*');
    var body = [heads.map(function (v) {
      return { text: v, bold: true, alignment: 'center', fillColor: '#f0f0f0', margin: [1, 4, 1, 4] };
    })];
    displayed.forEach(function (r, index) {
      var sum = num(r.qty) * num(r.price);
      subtotal += sum;
      var row = [index + 1, r.custNo, r.name, r.model, r.unit, r.qty, r.price === '' ? '' : money(r.price), money(sum)];
      if (showDelivery) row.push(r.delivery);
      row.push(r.remark);
      body.push(row.map(function (v, i) {
        var alignment = i === 5 || i === 6 || i === 7 ? 'right' : (i === 0 || i === 4 ? 'center' : 'left');
        return cell(v, alignment);
      }));
    });
    if (body.length === 1) {
      var empty = heads.map(function () { return cell(' '); });
      body.push(empty);
    }
    var rate = num(doc.taxRate);
    var tax = subtotal * rate / 100;
    var total = subtotal + tax;
    var headerColumns = [];
    if (logo) headerColumns.push({ image: logo, width: Math.min(150, Math.max(35, num(data.logoWidth || 40) * 2.83)), fit: [150, Math.max(22, num(data.logoHeight || 16) * 2.83)] });
    headerColumns.push({ text: [ { text: str(seller.company || '公司名称') + '\n', fontSize: 16, bold: true }, { text: str(seller.address), fontSize: 8, color: '#555555' } ], width: '*' });
    headerColumns.push({ text: [{ text: '报价单\n', bold: true, fontSize: 22, color: '#b91c1c' }, { text: 'QUOTATION', fontSize: 9, color: '#666666' }], alignment: 'right', width: 115 });
    var content = [
      { columns: headerColumns, columnGap: 10, margin: [0, 0, 0, 7] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 760, y2: 0, lineWidth: 1.4, lineColor: '#b91c1c' }], margin: [0, 0, 0, 8] },
      { columns: [
        { text: '单号：' + str(doc.no), width: '*' },
        { text: '报价日期：' + dateCN(doc.date), width: 'auto' },
        { text: '有效期至：' + dateCN(doc.validUntil), width: 'auto' },
        { text: '税率：' + rate + '%', width: 'auto' }
      ], columnGap: 12, fontSize: 9, margin: [0, 0, 0, 8] },
      { text: '客户信息', style: 'section' },
      { table: { widths: [65,'*',65,'*'], body: [
        infoRow('客户名称',customer.name,'联系人',customer.contact),
        [{ text: '客户地址', margin: [2,3,2,3] }, { text: str(customer.address), colSpan: 3, margin: [2,3,2,3] }, {}, {}],
        infoRow('联系电话',customer.phone,'报价单号',doc.no)
      ] }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 9] },
      { text: '产品报价明细', style: 'section' },
      { table: { headerRows: 1, dontBreakRows: true, widths: widths, body: body }, layout: {
        hLineWidth: function () { return 0.5; },
        vLineWidth: function () { return 0.5; },
        hLineColor: function () { return '#444444'; },
        vLineColor: function () { return '#444444'; },
        paddingLeft: function () { return 1; },
        paddingRight: function () { return 1; }
      }, fontSize: 8, margin: [0, 0, 0, 9] },
      { table: { widths: ['*','*','*','*'], body: [
        [cell('不含税金额'),cell('¥' + money(subtotal),'right'),cell('税额'),cell('¥' + money(tax),'right')],
        [{ text: '含税合计', bold: true, color: '#b91c1c', margin: 3 }, { text: '¥' + money(total), colSpan: 3, bold: true, alignment: 'right', color: '#b91c1c', margin: 3 }, {}, {}],
        [{ text: '大写金额', margin: 3 }, { text: amountUpper(total), colSpan: 3, margin: 3 }, {}, {}]
      ] }, layout: 'lightHorizontalLines', unbreakable: true, margin: [0, 0, 0, 8] },
      { stack: [{ text: '备注与条款', bold: true, margin: [0,0,0,4] }, { text: str(doc.remark) || ' ', lineHeight: 1.4 }], unbreakable: true, margin: [0,0,0,10] },
      { columns: [
        { stack: [
          { text: '报价单位（盖章）：', bold: true, margin: [0,0,0,5] },
          line('单位名称：',seller.company),
          line('联系人：',seller.contact),
          line('日期：',dateCN(doc.date)),
          ...(seal ? [{ image: seal, width: 80, absolutePosition: undefined, margin: [35,-42,0,0] }] : [])
        ], width: '*' },
        { stack: [
          { text: '客户确认（盖章）：', bold: true, margin: [0,0,0,5] },
          line('客户名称：',customer.name),
          line('联系人：',customer.contact),
          line('日期：','____年__月__日')
        ], width: '*' }
      ], columnGap: 40, unbreakable: true }
    ];
    return {
      pageSize: 'A4', pageOrientation: 'landscape',
      pageMargins: [35, 35, 35, 48],
      content: content,
      defaultStyle: { font: 'NotoSansSC', fontSize: 9, color: '#171717' },
      styles: { section: { fontSize: 11, bold: true, margin: [0, 5, 0, 5], color: '#222222' } },
      footer: function (pageNo, pageCount) {
        return { columns: [
          { text: '地址：' + str(seller.address) + '   电话：' + str(seller.phone) + '\n邮箱：' + str(seller.email), width: '*' },
          { text: '开户行：' + str(seller.bank) + '\n账号：' + str(seller.account), width: '*' },
          { text: pageNo + ' / ' + pageCount, width: 40, alignment: 'right' }
        ], columnGap: 10, fontSize: 7, color: '#666666', margin: [35, 8, 35, 0] };
      }
    };
  }
  async function download(data) {
    if (!window.pdfMake || typeof window.pdfMake.createPdf !== 'function') {
      throw new Error('PDF 排版组件未加载，请检查网络连接');
    }
    registerFont();
    var logo = await imageOrNull(data.logoData);
    var seal = await imageOrNull(data.sealData || data.defaultSeal);
    var definition = makeDefinition(data, logo, seal);
    var filename = safeName('报价单_' + str((data.customer || {}).name || '客户') + '_' + str((data.doc || {}).no || '未编号')) + '.pdf';
    await window.pdfMake.createPdf(definition).download(filename);
  }
  window.QuotePdf = { download: download };
})();
