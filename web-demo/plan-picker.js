/*! PlanPicker — ultra-light modal to choose a plan, then show it with PlanViewer */
(function(){
  const PP = {
    open(plans, opts = {}) {
      if (!Array.isArray(plans) || plans.length === 0) return;
      const overlay = document.createElement('div');
      overlay.id = 'pp-overlay';
      Object.assign(overlay.style, {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9998,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      });
      const modal = document.createElement('div');
      Object.assign(modal.style, {
        width: 'min(720px, 96vw)', maxHeight: '80vh', overflow: 'auto',
        background: 'white', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        padding: '12px 16px'
      });
      const title = document.createElement('div');
      title.style.fontWeight = '600';
      title.style.marginBottom = '8px';
      title.textContent = opts.title || 'Select a plan';
      const list = document.createElement('div');
      plans.forEach(p => {
        const row = document.createElement('div');
        Object.assign(row.style, {
          padding: '8px 6px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer'
        });
        const contract = p.contract || p.contractId || p.contract_id || '';
        const pbp = p.pbp || p.planId || p.plan_id || '';
        const name = p.planName || p.name || '';
        row.textContent = `${contract}${pbp ? '-' + pbp : ''}  ${name}`.trim();
        row.addEventListener('click', () => {
          PlanViewer.show(p, { title: `${contract}${pbp ? ' - ' + pbp : ''}` });
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
      modal.appendChild(title); modal.appendChild(list); modal.appendChild(closeBtn);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    },
    close() {
      document.getElementById('pp-overlay')?.remove();
    }
  };
  window.PlanPicker = PP;
})();