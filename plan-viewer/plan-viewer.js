/*! Plan Viewer (vanilla JS) — drop-in JSON inspector for "plan" objects.
 *  Exposes a single global `PlanViewer` with:
 *    PlanViewer.init()                        // sets up the drawer once
 *    PlanViewer.register(el, src, meta?)      // wire a "plan chip" to a JSON source
 *      - src can be:
 *          a JavaScript object (already-loaded plan data),
 *          a string URL to a JSON file,
 *          or a function () => Promise<object> that resolves to plan data
 *      - meta is optional {title?: string, hint?: string}
 *    PlanViewer.show(data, meta?)             // open the drawer with a plan object
 *    PlanViewer.close()                       // close the drawer
 *
 *  Minimal integration:
 *    1) Include plan-viewer.css & plan-viewer.js on your page.
 *    2) Call PlanViewer.init() once.
 *    3) When rendering a plan chip/link, call PlanViewer.register(chipEl, planObjectOrUrl, { title: 'H2001-001' });
 *
 *  No framework required.
 */
(function() {
  const state = {
    open: false,
    data: null,
    meta: null,
    tabs: ['Summary', 'Raw JSON', 'Flat Table'],
    activeTab: 0,
  };

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function copyToClipboard(text) {
    try {
      navigator.clipboard.writeText(text);
      toast('Copied JSON to clipboard.');
    } catch (e) {
      console.warn('Clipboard copy failed', e);
    }
  }

  function download(filename, text) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function toast(msg) {
    const t = el('div', { class: 'pv-toast' }, msg);
    Object.assign(t.style, {
      position: 'fixed', bottom: '16px', right: '16px', background: '#111827', color: 'white',
      padding: '8px 12px', borderRadius: '8px', fontSize: '12px', zIndex: 10000, opacity: 0.98
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function flatten(obj, prefix = '') {
    const out = {};
    const seen = new WeakSet();
    (function recur(o, pfx) {
      if (o && typeof o === 'object') {
        if (seen.has(o)) { out[pfx || '(root)'] = '[Circular]'; return; }
        seen.add(o);
        if (Array.isArray(o)) {
          o.forEach((v, i) => recur(v, pfx ? `${pfx}[${i}]` : `[${i}]`));
        } else {
          for (const [k, v] of Object.entries(o)) {
            recur(v, pfx ? `${pfx}.${k}` : k);
          }
        }
      } else {
        out[pfx || '(root)'] = o;
      }
    })(obj, prefix);
    return out;
  }

  function renderFlatTable(obj) {
    const flat = flatten(obj);
    const table = el('table', { class: 'pv-table' });
    const thead = el('thead', {}, el('tr', {}, [el('th', {}, 'Key'), el('th', {}, 'Value')]));
    const tbody = el('tbody');
    Object.entries(flat).forEach(([k, v]) => {
      const tr = el('tr', {}, [el('td', {}, k), el('td', {}, String(v))]);
      tbody.appendChild(tr);
    });
    Object.assign(table.style, {
      width: '100%', borderCollapse: 'collapse', fontSize: '12px'
    });
    Object.assign(thead.style, { background: '#f9fafb' });
    ;[...thead.querySelectorAll('th'), ...tbody.querySelectorAll('td')].forEach(cell => {
      Object.assign(cell.style, { textAlign: 'left', border: '1px solid #f3f4f6', padding: '6px 8px' });
    });
    const wrapper = el('div', {}, [table]);
    return wrapper;
  }

  function renderTree(obj, key = null) {
    if (obj === null || typeof obj !== 'object') {
      const valSpan = el('span', { class: 'pv-leaf' }, `${key !== null ? key + ': ' : ''}${JSON.stringify(obj)}`);
      return valSpan;
    }
    const isArray = Array.isArray(obj);
    const label = key !== null ? key + ': ' : '';
    const summary = el('summary', {}, [
      el('span', { class: 'pv-muted' }, label),
      el('strong', {}, isArray ? `Array(${obj.length})` : 'Object')
    ]);
    const details = el('details', {}, [summary]);
    Object.entries(obj).forEach(([k, v]) => {
      const child = renderTree(v, k);
      details.appendChild(child.nodeName === 'DETAILS' ? child : el('div', {}, child));
    });
    return details;
  }

  function summarizePlan(p, meta) {
    // We try to create a helpful header from whatever fields exist.
    // We intentionally probe common field names but won't break if missing.
    const g = (k, d='') => p?.[k] ?? p?.[k.toLowerCase()] ?? d;
    const contract = g('contract') || g('contractId') || g('contract_id') || g('ContractID') || g('contractNumber') || g('ContractNumber');
    const pbp = g('pbp') || g('planId') || g('plan_id') || g('PlanID') || g('pbpNumber') || g('PBP');
    const name = g('planName') || g('name') || g('plan_name');
    const type = g('planType') || g('type') || g('PlanType');
    const year = g('year') || g('planYear') || g('PlanYear');
    const org = g('orgName') || g('organizationName') || g('carrier') || g('ParentOrg');
    const county = g('county') || g('CountyName') || g('serviceArea');
    const premium = g('premium') || g('monthlyPremium') || g('MonthlyPremium');
    const star = g('star') || g('StarRating') || g('starRating');

    const items = [
      ...(meta?.hint ? [['Source', meta.hint]] : []),
      ['Contract', contract],
      ['Plan', pbp],
      ['Name', name],
      ['Type', type],
      ['Year', year],
      ['Org', org],
      ['County/Area', county],
      ['Premium', premium],
      ['Star', star],
    ].filter(([,v]) => v != null && v !== '');

    const grid = el('div', { id: 'pv-meta' });
    items.forEach(([k, v]) => {
      grid.appendChild(el('div', { class: 'pv-kv' }, [
        el('span', { class: 'k' }, k),
        el('div', { class: 'v' }, String(v))
      ]));
    });
    return grid;
  }

  function setActiveTab(i) {
    state.activeTab = i;
    const tabs = document.querySelectorAll('#pv-tabs .pv-tab');
    const panels = document.querySelectorAll('#pv-content .pv-panel');
    tabs.forEach((t, idx) => t.classList.toggle('active', idx === i));
    panels.forEach((p, idx) => p.classList.toggle('active', idx === i));
  }

  function buildDrawer() {
    const drawer = el('div', { id: 'pv-drawer' });
    const header = el('div', { id: 'pv-header' }, [
      el('div', { id: 'pv-title' }, 'Plan Details'),
      el('div', { id: 'pv-actions' }, [
        el('button', { class: 'pv-btn', onClick: () => {
          if (!state.data) return;
          try {
            download((state.meta?.downloadName || 'plan') + '.json', JSON.stringify(state.data, null, 2));
          } catch {}
        }}, 'Download JSON'),
        el('button', { class: 'pv-btn', onClick: () => {
          if (!state.data) return;
          copyToClipboard(JSON.stringify(state.data, null, 2));
        }}, 'Copy JSON'),
        el('button', { class: 'pv-btn', onClick: () => PlanViewer.close() }, 'Close')
      ]),
    ]);
    const body = el('div', { id: 'pv-body' }, [
      el('div', { id: 'pv-tabs' }, state.tabs.map((t, i) =>
        el('div', { class: 'pv-tab' + (i === 0 ? ' active' : ''), onClick: () => setActiveTab(i) }, t)
      )),
      el('div', { id: 'pv-content' }, [
        el('div', { class: 'pv-panel active', id: 'pv-summary' }),
        el('div', { class: 'pv-panel', id: 'pv-raw' }),
        el('div', { class: 'pv-panel', id: 'pv-flat' }),
      ])
    ]);
    drawer.appendChild(header);
    drawer.appendChild(body);
    document.body.appendChild(drawer);
  }

  function render(data, meta) {
    const titleEl = document.getElementById('pv-title');
    const summaryEl = document.getElementById('pv-summary');
    const rawEl = document.getElementById('pv-raw');
    const flatEl = document.getElementById('pv-flat');
    const drawer = document.getElementById('pv-drawer');

    // Reset
    summaryEl.innerHTML = '';
    rawEl.innerHTML = '';
    flatEl.innerHTML = '';

    // Title
    const titleText = meta?.title ||
      [data?.contract || data?.contractId || data?.contract_id, data?.planId || data?.pbp || data?.plan_id]
        .filter(Boolean).join(' - ') || 'Plan Details';
    titleEl.textContent = titleText;

    // Summary (best-effort)
    summaryEl.appendChild(summarizePlan(data, meta));

    // Raw JSON
    const pre = el('pre', { class: 'pv-tree' });
    pre.appendChild(renderTree(data));
    rawEl.appendChild(pre);

    // Flat Table
    flatEl.appendChild(renderFlatTable(data));

    // Open
    drawer.classList.add('open');
    state.open = true;
  }

  const PlanViewer = {
    init() {
      if (document.getElementById('pv-drawer')) return;
      buildDrawer();
    },
    register(el, src, meta = {}) {
      if (!el) return;
      el.addEventListener('click', async (ev) => {
        ev.preventDefault();
        try {
          PlanViewer.init();
          let data;
          if (typeof src === 'function') {
            data = await src();
          } else if (typeof src === 'string') {
            const res = await fetch(src);
            data = await res.json();
          } else {
            data = src;
          }
          state.data = data;
          state.meta = meta;
          render(data, meta);
        } catch (e) {
          console.error('PlanViewer: failed to load plan data', e);
          toast('Failed to load plan details.');
        }
      });
    },
    show(data, meta = {}) {
      PlanViewer.init();
      state.data = data;
      state.meta = meta;
      render(data, meta);
    },
    close() {
      const drawer = document.getElementById('pv-drawer');
      drawer?.classList.remove('open');
      state.open = false;
    }
  };

  window.PlanViewer = PlanViewer;
})();