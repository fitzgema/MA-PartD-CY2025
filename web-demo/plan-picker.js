/*! PlanPicker — modal chooser that prefers full plan JSON before opening PlanViewer */
(function () {
  const PP = {
    open(plans, opts = {}) {
      if (!Array.isArray(plans) || plans.length === 0) return;

      const overlay = document.createElement('div');
      overlay.id = 'pp-overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });

      const modal = document.createElement('div');
      Object.assign(modal.style, {
        width: 'min(720px, 96vw)',
        maxHeight: '80vh',
        overflow: 'auto',
        background: 'white',
        borderRadius: '12px',
        boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        padding: '12px 16px',
      });

      const title = document.createElement('div');
      title.style.fontWeight = '600';
      title.style.marginBottom = '8px';
      title.textContent = opts.title || 'Select a plan';

      const list = document.createElement('div');

      plans.forEach((p) => {
        const contract = p.contract || p.contractId || p.contract_id || '';
        const pbp = p.pbp || p.planId || p.plan_id || '';
        const name = p.planName || p.name || '';
        const premium = p.premium ?? p.monthly_premium ?? p.premiumMonthly ?? p.premium_total ?? null;

        const row = document.createElement('button');
        row.type = 'button';
        Object.assign(row.style, {
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          margin: '6px 0',
          border: '1px solid #e5e7eb',
          borderRadius: '10px',
          background: '#fafafa',
          cursor: 'pointer',
        });
        row.onmouseenter = () => (row.style.background = '#f3f4f6');
        row.onmouseleave = () => (row.style.background = '#fafafa');
        row.textContent = `${contract}${pbp ? '-' + pbp : ''}  ${name}${
          premium != null ? ` — $${Number(premium).toFixed(2)}/mo` : ''
        }`;

        row.addEventListener('click', async () => {
          try {
            const yr = document.getElementById('year')?.value || '2025';
            const loader = window.__loadPlanJSON;
            if (typeof loader === 'function' && contract && pbp) {
              const { json, url } = await loader(contract, pbp, yr);
              PlanViewer.show({ __provenance: url, ...json }, {
                title: `${contract}${pbp ? ' - ' + pbp : ''}`,
                hint: `source: ${url}`,
              });
            } else {
              // Fallback to minimal county-embedded object
              PlanViewer.show(p, {
                title: `${contract}${pbp ? ' - ' + pbp : ''}`,
                hint: 'source: carrier → PlanPicker (county JSON fallback)',
              });
            }
          } catch (e) {
            console.warn('PlanPicker full-load failed; falling back to county object', e);
            PlanViewer.show(p, {
              title: `${contract}${pbp ? ' - ' + pbp : ''}`,
              hint: 'source: carrier → PlanPicker (county JSON fallback)',
            });
          }
          PP.close();
        });

        list.appendChild(row);
      });

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      closeBtn.style.marginTop = '8px';
      closeBtn.style.padding = '6px 10px';
      closeBtn.style.border = '1px solid #e5e7eb';
      closeBtn.style.borderRadius = '8px';
      closeBtn.addEventListener('click', () => PP.close());

      modal.appendChild(title);
      modal.appendChild(list);
      modal.appendChild(closeBtn);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    },

    close() {
      document.getElementById('pp-overlay')?.remove();
    },
  };

  window.PlanPicker = PP;
})();
