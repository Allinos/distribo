/* ============================================================
   ERP SYSTEM - Frontend JS
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  // ---- Sidebar Toggle ----
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebarToggle');

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebarOverlay';
  document.body.appendChild(overlay);

  function openSidebar() {
    sidebar?.classList.add('open');
    overlay.classList.add('show');
  }

  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay.classList.remove('show');
  }

  toggleBtn?.addEventListener('click', () => {
    sidebar?.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  overlay.addEventListener('click', closeSidebar);

  // ---- Live Date in Header ----
  const dateEl = document.getElementById('currentDate');
  if (dateEl) {
    const updateDate = () => {
      dateEl.textContent = new Date().toLocaleDateString('en-IN', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    };
    updateDate();
    setInterval(updateDate, 60000);
  }

  // ---- Auto-dismiss alerts ----
  const alerts = document.querySelectorAll('.alert.alert-success');
  alerts.forEach(alert => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert);
      bsAlert?.close();
    }, 4000);
  });

  // ---- Confirm forms ----
  document.querySelectorAll('[data-confirm]').forEach(el => {
    el.addEventListener('click', function (e) {
      if (!confirm(this.dataset.confirm)) e.preventDefault();
    });
  });

  // ---- Tables: search highlight ----
  const searchInputs = document.querySelectorAll('input[name="search"]');
  searchInputs.forEach(input => {
    if (input.value) {
      const term = input.value.toLowerCase();
      document.querySelectorAll('.erp-table tbody td').forEach(td => {
        const text = td.textContent;
        if (text.toLowerCase().includes(term)) {
          const regex = new RegExp(`(${term})`, 'gi');
          td.innerHTML = td.innerHTML.replace(regex, '<mark>$1</mark>');
        }
      });
    }
  });

  // ---- Tooltips ----
  document.querySelectorAll('[title]').forEach(el => {
    new bootstrap.Tooltip(el, { placement: 'top', trigger: 'hover' });
  });

  // ---- Format currency inputs ----
  document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('wheel', e => e.preventDefault());
  });

  // ---- Active nav link pulse (badge for low stock) ----
  // Can be extended to show counts in nav

  // ---- Print helper ----
  window.printPage = function () {
    window.print();
  };
});

// ---- Global utility functions ----

/**
 * Format number as Indian currency
 */
window.formatCurrency = function (n, symbol = '₹') {
  return symbol + parseFloat(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

/**
 * Show toast notification
 */
window.showToast = function (message, type = 'success') {
  const container = document.getElementById('toastContainer') || (() => {
    const div = document.createElement('div');
    div.id = 'toastContainer';
    div.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;';
    document.body.appendChild(div);
    return div;
  })();

  const toast = document.createElement('div');
  toast.className = `alert alert-${type} shadow-lg mb-0 d-flex align-items-center`;
  toast.style.cssText = 'min-width:300px;animation:fadeUp 0.25s ease;';
  toast.innerHTML = `
    <i class="bi bi-${type === 'success' ? 'check-circle' : 'exclamation-triangle'}-fill me-2"></i>
    <span>${message}</span>
    <button type="button" class="btn-close ms-auto" onclick="this.closest('.alert').remove()"></button>
  `;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 4000);
};

/**
 * Debounce utility
 */
window.debounce = function (fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
};
