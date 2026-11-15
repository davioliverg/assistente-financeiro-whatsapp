/* Painel: vai buscar os dados do mês e desenha tudo. Sem bibliotecas externas. */
(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const tip = $('tip');
  let state = { month: null, currentMonth: null, currency: 'EUR' };

  const money = (cents) =>
    new Intl.NumberFormat('pt-PT', { style: 'currency', currency: state.currency }).format(cents / 100);
  const compact = (cents) =>
    new Intl.NumberFormat('pt-PT', { notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
  const monthName = (m, opts) =>
    new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC', ...opts }).format(new Date(`${m}-01T00:00:00Z`));
  const shiftMonth = (m, d) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7);
  };

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showTip(evt, text) {
    tip.textContent = text;
    tip.hidden = false;
    const r = evt.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 110), window.innerWidth - 110);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(r.top, 44)}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  function hover(node, text) {
    node.addEventListener('pointerenter', (e) => showTip(e, text));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', (e) => showTip(e, text));
    node.addEventListener('blur', hideTip);
  }

  // Barra com os cantos de cima arredondados e a base assente no eixo.
  function barPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // Escala "redonda": 3 linhas de grelha entre 0 e o máximo.
  function niceMax(v) {
    if (v <= 0) return 100;
    const pow = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
    return 10 * pow;
  }

  function frame(W, H, pad, max) {
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const plotH = H - pad.top - pad.bottom;
    for (let i = 0; i <= 3; i++) {
      const y = pad.top + plotH - (plotH * i) / 3;
      root.append(svg('line', { class: 'gridline', x1: pad.left, x2: W - pad.right, y1: y, y2: y }));
      root.append(svg('text', { class: 'axis', x: pad.left - 6, y: y + 4, 'text-anchor': 'end' }, compact((max * i) / 3)));
    }
    return { root, plotH };
  }

  function renderTiles(d) {
    const balance = d.totals.income - d.totals.expenses;
    const days = d.month === d.currentMonth ? new Date().getUTCDate() : d.daily.length;
    const tiles = [
      ['Despesas', money(d.totals.expenses), `média ${money(Math.round(d.totals.expenses / Math.max(days, 1)))}/dia`],
      ['Receitas', money(d.totals.income), ''],
      ['Saldo', money(balance), balance < 0 ? 'gastou mais do que recebeu' : ''],
      ['Lançamentos', String(d.totals.count), ''],
    ];
    $('tiles').replaceChildren(
      ...tiles.map(([label, value, sub]) => {
        const t = el('div', { class: 'tile' });
        t.append(el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
        if (sub) t.append(el('div', { class: 'sub' }, sub));
        return t;
      }),
    );
  }

  function renderCategories(d) {
    const box = $('categories');
    if (!d.categories.length) return box.replaceChildren(el('p', { class: 'empty' }, 'Sem despesas neste mês.'));
    const max = d.categories[0].cents;
    box.replaceChildren(
      ...d.categories.map((c) => {
        const row = el('div', { class: 'cat' });
        const track = el('div', { class: 'track' });
        const fill = el('div', { class: 'fill' });
        fill.style.width = `${(c.cents / max) * 100}%`;
        track.append(fill);
        const val = el('div', { class: 'val' }, money(c.cents));
        val.append(el('span', { class: 'pct' }, `${Math.round((c.cents / d.totals.expenses) * 100)}%`));
        row.append(el('div', { class: 'name', title: c.name }, c.name), track, val);
        return row;
      }),
    );
  }

  function renderDaily(d) {
    const box = $('daily');
    if (!d.totals.expenses) return box.replaceChildren(el('p', { class: 'empty' }, 'Sem despesas neste mês.'));
    const W = Math.max(box.clientWidth, 260), H = 200, pad = { top: 10, right: 6, bottom: 22, left: 40 };
    const max = niceMax(Math.max(...d.daily.map((x) => x.cents)));
    const { root, plotH } = frame(W, H, pad, max);
    root.setAttribute('aria-label', 'Despesas por dia do mês');
    const slot = (W - pad.left - pad.right) / d.daily.length;
    const bw = Math.max(slot - 2, 3);
    d.daily.forEach((p, i) => {
      const x = pad.left + i * slot + (slot - bw) / 2;
      const h = (p.cents / max) * plotH;
      const g = svg('g');
      const hit = svg('rect', { class: 'hit', x: pad.left + i * slot, y: pad.top, width: slot, height: plotH, tabindex: p.cents ? 0 : -1 });
      g.append(hit);
      if (p.cents) g.append(svg('path', { class: 'bar1 mark', d: barPath(x, pad.top + plotH - h, bw, h) }));
      hover(hit, `${p.day} de ${monthName(d.month, { month: 'long' })}\n${money(p.cents)}`);
      root.append(g);
      if (p.day === 1 || p.day % 5 === 0) {
        root.append(svg('text', { class: 'axis', x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, String(p.day)));
      }
    });
    box.replaceChildren(root);
  }

  function renderMonths(d) {
    const box = $('months');
    const W = Math.max(box.clientWidth, 260), H = 220, pad = { top: 10, right: 6, bottom: 24, left: 44 };
    const top = Math.max(...d.months.map((m) => Math.max(m.expenses, m.income)));
    if (!top) return box.replaceChildren(el('p', { class: 'empty' }, 'Ainda não há lançamentos.'));
    const max = niceMax(top);
    const { root, plotH } = frame(W, H, pad, max);
    root.setAttribute('aria-label', 'Despesas e receitas dos últimos seis meses');
    const slot = (W - pad.left - pad.right) / d.months.length;
    const bw = Math.max(Math.min(34, (slot - 14) / 2), 6);
    d.months.forEach((m, i) => {
      const cx = pad.left + i * slot + slot / 2;
      const g = svg('g');
      const hit = svg('rect', { class: 'hit', x: pad.left + i * slot, y: pad.top, width: slot, height: plotH, tabindex: 0 });
      g.append(hit);
      [[m.expenses, 'bar1', cx - bw - 1], [m.income, 'bar2', cx + 1]].forEach(([cents, cls, x]) => {
        if (!cents) return;
        const h = Math.max((cents / max) * plotH, 2);
        g.append(svg('path', { class: `${cls} mark`, d: barPath(x, pad.top + plotH - h, bw, h) }));
      });
      hover(hit, `${monthName(m.month, { month: 'long', year: 'numeric' })}\nDespesas: ${money(m.expenses)}\nReceitas: ${money(m.income)}`);
      root.append(g);
      root.append(svg('text', { class: 'axis', x: cx, y: H - 7, 'text-anchor': 'middle' }, monthName(m.month, { month: 'short' }).replace('.', '')));
    });
    box.replaceChildren(root);
  }

  function renderTable(d) {
    const body = document.querySelector('#table tbody');
    if (!d.transactions.length) {
      const td = el('td', { colspan: 4, class: 'empty' }, 'Sem lançamentos neste mês.');
      const tr = el('tr'); tr.append(td);
      return body.replaceChildren(tr);
    }
    body.replaceChildren(
      ...d.transactions.map((t) => {
        const tr = el('tr');
        const [, m, day] = t.date.split('-');
        const amount = el('td', { class: 'num' }, `${t.type === 'receita' ? '+' : '−'} ${money(t.cents)}`);
        const desc = el('td', {}, t.description);
        if (t.type === 'receita') desc.append(el('span', { class: 'tag' }, 'receita'));
        desc.append(el('span', { class: 'under' }, t.category));
        tr.append(el('td', { class: 'date' }, `${day}/${m}`), desc, el('td', { class: 'cat-cell' }, t.category), amount);
        return tr;
      }),
    );
  }

  async function load(month) {
    const res = await fetch(`/painel/dados${month ? `?mes=${month}` : ''}`, { credentials: 'same-origin' });
    if (res.status === 401) return window.location.reload();
    const d = await res.json();
    state = { month: d.month, currentMonth: d.currentMonth, currency: d.currency };
    $('hello').textContent = d.name ? `Olá, ${d.name}` : '';
    const label = monthName(d.month, { month: 'long', year: 'numeric' });
    $('month-label').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    $('next').disabled = d.month >= d.currentMonth;
    last = d;
    renderTiles(d); renderCategories(d); renderDaily(d); renderMonths(d); renderTable(d);
  }

  let last = null;
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return; // em telemóveis, o scroll muda só a altura
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (last) { renderDaily(last); renderMonths(last); } }, 150);
  });

  $('prev').addEventListener('click', () => load(shiftMonth(state.month, -1)));
  $('next').addEventListener('click', () => load(shiftMonth(state.month, 1)));
  window.addEventListener('scroll', hideTip, { passive: true });
  load();
})();
