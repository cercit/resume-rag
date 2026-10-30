// Small SVG charts for the Admin Console: vertical bars over days, horizontal bars for breakdowns.
// One series per chart, so no legend: the card title names it. Every chart has a hover tooltip
// and a table view under it. Colors are the dataviz reference palette, dark steps, validated on #13141c.
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = { blue: '#3987e5', orange: '#d95926' };
  const fmt = n => Number(n).toLocaleString('en-IN');

  let tip;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; tip.setAttribute('role', 'status');
    document.body.append(tip);
    return tip;
  }
  function showTip(event, title, value) {
    const t = tooltip();
    t.replaceChildren(); const b = document.createElement('b'); b.textContent = value; t.append(title + '  ', b);
    t.hidden = false;
    const x = Math.min(event.clientX + 14, innerWidth - t.offsetWidth - 8), y = event.clientY - t.offsetHeight - 12;
    t.style.left = x + 'px'; t.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }
  // bar with 4px rounded data end, square at the baseline
  function vbarPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function hbarPath(x, y, w, h) {
    const r = Math.min(4, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  function table(rows, head) {
    const details = document.createElement('details'), summary = document.createElement('summary'), t = document.createElement('table');
    summary.textContent = 'Table'; details.className = 'chart-table';
    const thead = document.createElement('tr');
    head.forEach(h => { const th = document.createElement('th'); th.textContent = h; thead.append(th); });
    t.append(thead);
    rows.forEach(r => { const tr = document.createElement('tr'); r.forEach(c => { const td = document.createElement('td'); td.textContent = c; tr.append(td); }); t.append(tr); });
    details.append(summary, t);
    return details;
  }

  // points: [{ label (axis), title (tooltip), value }]
  function columns(host, points, options) {
    const color = COLORS[options.color] || COLORS.blue;
    const width = Math.max(280, host.clientWidth || 600), height = 190, left = 34, right = 8, top = 10, bottom = 26;
    const max = niceMax(Math.max(0, ...points.map(p => p.value)));
    const plotW = width - left - right, plotH = height - top - bottom, slot = plotW / points.length, gap = 2;
    const barW = Math.max(2, slot - gap);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': options.label });
    [0, 0.5, 1].forEach(f => {
      const y = top + plotH - f * plotH;
      svg.append(el('line', { x1: left, x2: width - right, y1: y, y2: y, class: f === 0 ? 'axis' : 'grid' }));
      const t = el('text', { x: left - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }); t.textContent = fmt(max * f); svg.append(t);
    });
    // about one date label per 70px, so phones get fewer
    const every = Math.ceil(points.length / Math.max(2, Math.min(6, Math.floor(plotW / 70))));
    points.forEach((p, i) => {
      const x = left + i * slot + gap / 2, h = max ? (p.value / max) * plotH : 0;
      if (h > 0) svg.append(el('path', { d: vbarPath(x, top + plotH - h, barW, h), fill: color }));
      const last = i === points.length - 1;
      // first and last labels sit inside the plot; a label too close to the last one is skipped
      if ((i % every === 0 && points.length - 1 - i >= every / 2) || last) {
        const anchor = i === 0 ? 'start' : last ? 'end' : 'middle';
        const tx = i === 0 ? x : last ? x + barW : x + barW / 2;
        const t = el('text', { x: tx, y: height - 8, 'text-anchor': anchor, class: 'tick' }); t.textContent = p.label; svg.append(t);
      }
      // hit target: the full column, wider than the bar
      const hit = el('rect', { x: left + i * slot, y: top, width: slot, height: plotH, fill: 'transparent', class: 'hit' });
      hit.addEventListener('mousemove', e => showTip(e, p.title, fmt(p.value)));
      hit.addEventListener('mouseleave', hideTip);
      svg.append(hit);
    });
    host.replaceChildren(svg, table(points.map(p => [p.title, fmt(p.value)]), ['Day', options.unit]));
  }

  // rows: [{ label, value, note? }]; values printed at the bar end in text color
  function bars(host, rows, options) {
    if (!rows.length) { host.replaceChildren(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: options.empty || 'No data yet.' })); return; }
    const color = COLORS[options.color] || COLORS.blue;
    const width = Math.max(260, host.clientWidth || 400), rowH = 30, barH = 16, labelW = Math.min(150, width * 0.38), valueW = 64;
    const height = rows.length * rowH + 4, plotW = width - labelW - valueW;
    const max = Math.max(1, ...rows.map(r => r.value));
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': options.label });
    rows.forEach((r, i) => {
      const y = i * rowH + (rowH - barH) / 2, w = (r.value / max) * plotW;
      const name = el('text', { x: labelW - 10, y: y + barH - 3, 'text-anchor': 'end', class: 'label' });
      name.textContent = r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label; svg.append(name);
      svg.append(el('rect', { x: labelW, y, width: plotW, height: barH, rx: 4, class: 'track' }));
      if (w > 0) svg.append(el('path', { d: hbarPath(labelW, y, Math.max(w, 3), barH), fill: color }));
      const v = el('text', { x: labelW + Math.max(w, 3) + 8, y: y + barH - 3, class: 'value' });
      v.textContent = fmt(r.value) + (r.note ? '  ' + r.note : ''); svg.append(v);
      const hit = el('rect', { x: 0, y: i * rowH, width, height: rowH, fill: 'transparent', class: 'hit' });
      hit.addEventListener('mousemove', e => showTip(e, r.label, fmt(r.value) + (r.note ? ' (' + r.note + ')' : '')));
      hit.addEventListener('mouseleave', hideTip);
      svg.append(hit);
    });
    host.replaceChildren(svg, table(rows.map(r => [r.label, fmt(r.value) + (r.note ? ' (' + r.note + ')' : '')]), [options.labelHead || 'Item', options.unit || 'Count']));
  }

  global.AdminCharts = { columns, bars, hideTip };
})(window);
