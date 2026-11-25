// Shared chrome (header/footer) + API helpers for the static Connect Pharma app.
(function () {
  const COMMON_NAV = [
    ['Search', '/search.html'],
    ['Map', '/map.html']
  ];
  const HOME_NAV = [
    ['How it works', '/index.html#how-it-works'],
    ['About us', '/about.html'],
    ['Contact', '/contact.html'],
    ['Map', '/map.html']
  ];
  const HOME_NAV_PATHS = new Set(['/', '/index.html', '/about.html', '/contact.html', '/map.html']);
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    mapPin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    workflow: '<path d="m3 5 2 2 4-4M3 12l2 2 4-4M3 19l2 2 4-4M13 6h8M13 13h8M13 20h8"/>',
    briefcase: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/>',
    dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
    chart: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-5 5"/><path d="M15 9h4v4"/>',
    creditCard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h3"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3"/>',
    package: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    messages: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
    logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    userPlus: '<path d="M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.8L7.7 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 1.8-.6l3 .5a2 2 0 0 1 2.2 2.5Z"/>',
    store: '<path d="m2 10 2-7h16l2 7M4 10v10h16V10M2 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-5h6v5"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
    scale: '<path d="m16 16 3-8 3 8a5 5 0 0 1-6 0ZM2 16l3-8 3 8a5 5 0 0 1-6 0ZM7 21h10M12 3v18M8 6h8"/>',
    circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m8 12 2.5 2.5L16 9"/>',
    circleAlert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>'
  };
  const NAV_ICONS = {
    Home: 'home',
    Search: 'search',
    Map: 'mapPin',
    'How it works': 'workflow',
    'About us': 'info',
    Contact: 'phone',
    Overview: 'dashboard',
    Accounts: 'users',
    Approvals: 'userCheck',
    'KYC review': 'shieldCheck',
    Revenue: 'chart',
    Plans: 'creditCard',
    'Audit log': 'clipboard',
    Catalogue: 'package',
    Enquiries: 'messages',
    'KYC documents': 'shieldCheck'
  };
  const PAGE_ICONS = {
    '/about.html': 'info',
    '/contact.html': 'phone',
    '/comparison-results.html': 'scale',
    '/dashboard.html': 'dashboard',
    '/search.html': 'search',
    '/map.html': 'mapPin',
    '/supplier-registration.html': 'briefcase',
    '/medical-shop-registration.html': 'store',
    '/subscription-plans.html': 'creditCard',
    '/payment.html': 'creditCard',
    '/kyc.html': 'shieldCheck',
    '/privacy-policy.html': 'shield',
    '/terms.html': 'fileText',
    '/supplier/dashboard.html': 'package',
    '/supplier/catalogue.html': 'package',
    '/supplier/enquiries.html': 'messages',
    '/medical-shop/dashboard.html': 'store',
    '/admin/dashboard.html': 'dashboard',
    '/admin/accounts.html': 'users',
    '/admin/approvals.html': 'userCheck',
    '/admin/kyc.html': 'shieldCheck',
    '/admin/revenue.html': 'chart',
    '/admin/subscriptions.html': 'creditCard',
    '/admin/audit.html': 'clipboard'
  };

  function iconMarkup(name, className) {
    const content = ICONS[name];
    if (!content) return '';
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;
  }

  function renderPageHeadingIcon() {
    const iconName = PAGE_ICONS[location.pathname];
    const heading = document.querySelector('main h1, main h2');
    if (iconName && heading && !heading.querySelector('.page-title-icon')) {
      heading.insertAdjacentHTML('afterbegin', iconMarkup(iconName, 'page-title-icon'));
    }
  }

  window.iconMarkup = iconMarkup;

  const DASHBOARD_BY_ROLE = {
    admin: '/admin/dashboard.html',
    supplier: '/supplier/dashboard.html',
    medical_shop: '/medical-shop/dashboard.html'
  };
  const NAV_BY_ROLE = {
    admin: [
      ['Overview', DASHBOARD_BY_ROLE.admin],
      ['Accounts', '/admin/accounts.html'],
      ['Approvals', '/admin/approvals.html'],
      ['KYC review', '/admin/kyc.html'],
      ['Revenue', '/admin/revenue.html'],
      ['Plans', '/admin/subscriptions.html'],
      ['Audit log', '/admin/audit.html']
    ],
    supplier: [
      ['Overview', DASHBOARD_BY_ROLE.supplier],
      ['Catalogue', '/supplier/catalogue.html'],
      ['Enquiries', '/supplier/enquiries.html'],
      ['KYC documents', '/kyc.html'],
      ['Plans', '/subscription-plans.html']
    ],
    medical_shop: [
      ['Overview', DASHBOARD_BY_ROLE.medical_shop],
      ['KYC documents', '/kyc.html'],
      ['Plans', '/subscription-plans.html']
    ]
  };

  const SESSION_ROLE_KEY = 'connect-pharma-role';

  window.dashboardForRole = (role) => DASHBOARD_BY_ROLE[role] || null;
  window.cacheSessionRole = (role) => {
    if (!Object.prototype.hasOwnProperty.call(DASHBOARD_BY_ROLE, role)) return;
    try {
      sessionStorage.setItem(SESSION_ROLE_KEY, role);
    } catch (error) {
      console.warn('Could not cache the signed-in role for navigation:', error);
    }
  };

  function cachedSessionUser() {
    try {
      const role = sessionStorage.getItem(SESSION_ROLE_KEY);
      return role && Object.prototype.hasOwnProperty.call(DASHBOARD_BY_ROLE, role)
        ? { role }
        : null;
    } catch (error) {
      console.warn('Could not read the cached navigation role:', error);
      return null;
    }
  }

  function clearCachedSessionUser() {
    try {
      sessionStorage.removeItem(SESSION_ROLE_KEY);
    } catch (error) {
      console.warn('Could not clear the cached navigation role:', error);
    }
  }

  function roleForPath(path) {
    if (path.startsWith('/admin/')) return 'admin';
    if (path.startsWith('/supplier/')) return 'supplier';
    if (path.startsWith('/medical-shop/')) return 'medical_shop';
    return null;
  }

  function isActive(href) {
    const path = location.pathname;
    const target = href.replace(/^\//, '');
    return path === '/' + target || path.endsWith(target) || path.endsWith(target.replace(/\.html$/, ''));
  }

  function renderChrome(user = null) {
    const header = document.getElementById('site-header');
    if (header) {
      const role = user && Object.prototype.hasOwnProperty.call(DASHBOARD_BY_ROLE, user.role)
        ? user.role
        : null;
      const roleKey = role || 'anonymous';
      const useHomeNavigation = HOME_NAV_PATHS.has(location.pathname);
      const navKey = `${roleKey}:${useHomeNavigation ? 'home' : 'page'}`;
      header.classList.toggle('home-navigation', useHomeNavigation);
      const existingNav = header.querySelector('#primary-navigation');
      if (existingNav && header.dataset.navRole === navKey) {
        existingNav.querySelectorAll('a').forEach((link) => {
          link.classList.toggle('active', isActive(link.getAttribute('href')));
        });
      } else {
        const authenticated = Boolean(role);
        const navItems = useHomeNavigation
          ? HOME_NAV
          : authenticated
            ? [...(role === 'admin' ? [] : [['Home', '/index.html']]), ...NAV_BY_ROLE[role], ...COMMON_NAV]
            : [...COMMON_NAV, ['About us', '/about.html'], ['Contact', '/contact.html']];
        header.className = 'site-header is-ready';
        header.classList.toggle('home-navigation', useHomeNavigation);
        header.dataset.navRole = navKey;
        header.innerHTML = `
          <div class="container bar">
            <a class="brand" href="/index.html" aria-label="The Connect Pharma home">
              <img src="/assets/logo.png" alt="The Connect Pharma" />
            </a>
            <button class="nav-toggle" type="button" aria-label="Open navigation menu" aria-controls="primary-navigation" aria-expanded="false">
              <svg class="menu-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
              <svg class="close-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"></path></svg>
            </button>
            <nav id="primary-navigation" class="main-nav" aria-label="Main navigation">
              ${navItems.map(([label, href]) =>
                `<a href="${href}" class="${isActive(href) ? 'active' : ''}">${iconMarkup(NAV_ICONS[label], 'nav-icon')}<span>${label}</span></a>`
              ).join('')}
              ${authenticated
                ? `<button class="sign-out" type="button">${iconMarkup('logOut', 'nav-icon')}<span>Sign out</span></button>`
                : `<div class="nav-auth-actions"><a href="/login.html?mode=signup">${iconMarkup('userPlus', 'nav-icon')}<span>Create account</span></a><a href="/login.html">${iconMarkup('logIn', 'nav-icon')}<span>Sign in</span></a></div>`}
            </nav>
          </div>`;
        const nav = header.querySelector('#primary-navigation');
        const navToggle = header.querySelector('.nav-toggle');
        const closeMenu = () => {
          nav.classList.remove('is-open');
          navToggle.setAttribute('aria-expanded', 'false');
          navToggle.setAttribute('aria-label', 'Open navigation menu');
        };
        navToggle.addEventListener('click', () => {
          const isOpen = navToggle.getAttribute('aria-expanded') !== 'true';
          navToggle.setAttribute('aria-expanded', String(isOpen));
          navToggle.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
          nav.classList.toggle('is-open', isOpen);
        });
        navToggle.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && nav.classList.contains('is-open')) closeMenu();
        });
        nav.addEventListener('click', (event) => {
          if (event.target.closest('a')) closeMenu();
        });
        nav.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && nav.classList.contains('is-open')) {
            closeMenu();
            navToggle.focus();
          }
        });
        const signOutButton = header.querySelector('.sign-out');
        if (signOutButton) {
          signOutButton.addEventListener('click', async () => {
            try {
              const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
              if (!response.ok) throw new Error(`Sign out failed (${response.status}).`);
              clearCachedSessionUser();
              location.assign('/login.html');
            } catch (error) {
              console.error('Sign out failed:', error);
              window.alert('Could not sign out. Please try again.');
            }
          });
        }
      }
    }

    const footer = document.getElementById('site-footer');
    if (footer) {
      footer.className = 'site-footer';
      footer.innerHTML = `
        <div class="container inner">
          <div class="footer-grid">
            <div class="footer-brand">
              <a class="brand" href="/index.html" aria-label="The Connect Pharma home"><img src="/assets/logo.png" alt="The Connect Pharma" /></a>
              <p class="footer-brand-name">THE CONNECT PHARMA</p>
              <p class="footer-tagline">Connecting Pharmaceutical Businesses</p>
              <p class="footer-brand-statement">Connecting the entire pharmaceutical business ecosystem through one platform.</p>
              <p class="footer-compliance-note">For B2B pharmaceutical businesses. Email verification does not replace business-credential review or statutory requirements.</p>
            </div>
            <address class="footer-links not-italic">
              <h2>Company</h2>
              <a href="/index.html">Home</a>
              <a href="/about.html">About Us</a>
              <a href="/contact.html">Contact Us</a>
              <a href="mailto:connectpharma@gmail.com">connectpharma@gmail.com</a>
              <p class="mt-2">Madurai, Tamil Nadu, India</p>
            </address>
            <nav aria-label="Business and marketplace links" class="footer-links">
              <h2>Business &amp; marketplace</h2>
              <a href="/supplier-registration.html">Supplier Registration</a>
              <a href="/medical-shop-registration.html">Medical Shop Registration</a>
              <a href="/login.html">Login</a>
              <a href="/search.html">Medicine Search</a>
              <a href="/comparison-results.html">Price Comparison Results</a>
              <a href="/map.html">Supplier Map</a>
            </nav>
            <nav aria-label="Portals and policies" class="footer-links">
              <h2>Portals &amp; policies</h2>
              <a href="/supplier/dashboard.html">Supplier Dashboard</a>
              <a href="/medical-shop/dashboard.html">Medical Shop Dashboard</a>
              <a href="/admin/dashboard.html">Admin Dashboard</a>
              <a href="/subscription-plans.html">Subscription Plans</a>
              <a href="/payment.html">Payment Page</a>
              <a href="/terms.html">Terms &amp; Conditions</a>
              <a href="/privacy-policy.html">Privacy Policy</a>
            </nav>
          </div>
          <div class="footer-bottom mt-6">
            <p>© ${new Date().getFullYear()} THE CONNECT PHARMA. All rights reserved.</p>
            <p>Schedule H, H1, X and other regulated medicines may only be traded with appropriately authorised businesses.</p>
            <p class="footer-credit">Design and developed by <a href="https://codexe.in"><strong>Codexe Technologies</strong></a></p>
          </div>
        </div>`;
    }
  }

  async function protectPage(cachedUser = null) {
    const path = location.pathname;
    const requiredRole = roleForPath(path);
    const isKycPage = path === '/kyc.html';
    const isBillingPage = path === '/subscription-plans.html' || path === '/payment.html';
    const protectedPage = requiredRole || isKycPage || isBillingPage || path === '/dashboard.html';
    if (!protectedPage && !document.getElementById('site-header')) return;

    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (response.status === 401) {
        clearCachedSessionUser();
        renderChrome();
        if (!protectedPage) return;
        const returnTo = encodeURIComponent(path + location.search);
        location.replace(`/login.html?returnTo=${returnTo}`);
        return;
      }
      if (!response.ok) {
        if (!protectedPage) {
          if (!cachedUser) renderChrome();
          return;
        }
        const result = await response.json().catch(() => ({}));
        const configHint = response.status === 503 && result.error === 'Authentication is not configured.'
          ? ' Add SUPABASE_URL and SUPABASE_ANON_KEY to .env.local, then restart the server.'
          : '';
        throw new Error(`${result.error || `Account verification failed (${response.status}).`}${configHint}`);
      }

      const { user } = await response.json();
      const dashboardPath = DASHBOARD_BY_ROLE[user.role];
      if (!dashboardPath) {
        throw new Error('Your account role is not recognized. Contact support.');
      }
      if (user.previewOnly) {
        const main = document.querySelector('main');
        if (main && !main.querySelector('[data-preview-banner]')) {
          const banner = document.createElement('p');
          banner.className = 'notice info mb-6';
          banner.dataset.previewBanner = 'true';
          banner.textContent = 'Local read-only preview. Account changes and write actions are disabled.';
          main.prepend(banner);
        }
      }
      window.cacheSessionRole(user.role);
      window.dispatchEvent(new CustomEvent('connectpharma:role', { detail: { role: user.role } }));
      renderChrome(user);
      if (!protectedPage) return;
      if (path === '/dashboard.html') {
        location.replace(dashboardPath);
        return;
      }
      if ((isKycPage || isBillingPage) && !['supplier', 'medical_shop'].includes(user.role)) {
        document.querySelector('main')?.replaceChildren(
          Object.assign(document.createElement('p'), {
            className: 'notice error',
            textContent: 'This page is available to supplier and medical shop accounts.'
          })
        );
        return;
      }
      if (requiredRole && user.role !== requiredRole) {
        document.querySelector('main')?.replaceChildren(
          Object.assign(document.createElement('p'), {
            className: 'notice error',
            textContent: 'Your account does not have permission to view this page.'
          })
        );
        return;
      }
    } catch (error) {
      console.error('Page access check failed:', error);
      if (!protectedPage) {
        if (!cachedUser) renderChrome();
        return;
      }
      const main = document.querySelector('main');
      if (main) {
        main.replaceChildren(
          Object.assign(document.createElement('p'), {
            className: 'notice error',
            textContent: error instanceof Error
              ? error.message
              : 'Could not verify your account. Refresh the page or try again later.'
          })
        );
      }
    }
  }

  window.api = async function (path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };

  window.esc = function (value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  };

  window.fmtDate = function (value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
  };

  window.fmtDateTime = function (value) {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  };

  function boot() {
    renderPageHeadingIcon();
    const contactForm = document.getElementById('contact-form');
    const contactStatus = document.getElementById('contact-form-status');
    const contactDraft = document.getElementById('contact-email-draft');
    if (contactForm instanceof HTMLFormElement && contactStatus && contactDraft instanceof HTMLAnchorElement) {
      contactForm.addEventListener('submit', (event) => {
        event.preventDefault();
        contactDraft.hidden = true;
        contactStatus.hidden = true;
        if (!contactForm.reportValidity()) return;

        const values = new FormData(contactForm);
        const name = String(values.get('name') || '').trim();
        const email = String(values.get('email') || '').trim();
        const businessType = String(values.get('businessType') || 'Not specified');
        const topic = String(values.get('topic') || '');
        const message = String(values.get('message') || '').trim();
        if (!name || !email || !topic || !message) {
          contactDraft.hidden = true;
          contactStatus.className = 'notice error contact-form-status';
          contactStatus.textContent = 'Please complete the required fields without leaving them blank.';
          contactStatus.hidden = false;
          return;
        }
        const subject = `Connect Pharma enquiry: ${topic}`;
        const body = [
          `Name: ${name}`,
          `Email: ${email}`,
          `Business type: ${businessType}`,
          `Topic: ${topic}`,
          '',
          'Message:',
          message
        ].join('\n');

        contactDraft.href = `mailto:connectpharma@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        contactDraft.hidden = false;
        contactStatus.className = 'notice info contact-form-status';
        contactStatus.textContent = 'Your email draft is ready. Open it below and press Send in your email app to contact us.';
        contactStatus.hidden = false;
      });
    }
    const user = cachedSessionUser();
    // Render chrome immediately (anonymous nav when no cached role) so the
    // header is never blank; protectPage re-renders once the session resolves.
    renderChrome(user);
    protectPage(user);
  }

  // app.js is loaded at the end of <body>, so the chrome elements are already
  // parsed. Boot immediately to avoid a blank-header flash on every page.
  boot();
})();
