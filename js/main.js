(() => {
  // ---- DOM refs ----
  const home = document.getElementById('home');
  const header = document.getElementById('header');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = lightbox.querySelector('.lightbox-img');
  const panels = document.querySelectorAll('.panel');
  const headerLinks = document.querySelectorAll('.header-link');
  const sections = document.querySelectorAll('.section');

  let activeSection = null;

  // ---- Helpers ----

  // Safely set text content (no innerHTML for user-supplied strings)
  function text(el, str) { el.textContent = str; }

  function escapeAttr(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ---- Data fetching ----

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.json();
  }

  // ---- Render: Homepage backgrounds ----

  async function renderHomepage() {
    try {
      const data = await fetchJSON('content/homepage.json');
      const map = {
        art: data.art_background,
        jewelry: data.jewelry_background,
        consulting: data.consulting_background
      };
      for (const [key, url] of Object.entries(map)) {
        if (url) {
          document.getElementById('panel-bg-' + key).style.backgroundImage = `url('${escapeAttr(url)}')`;
        }
      }
    } catch (e) {
      // Homepage backgrounds are optional; fall back to solid color
    }
  }

  // ---- Render: Art ----

  async function renderArt() {
    try {
      const data = await fetchJSON('content/art.json');
      const nav = document.getElementById('art-nav');
      const content = document.getElementById('art-content');

      data.pieces.forEach(piece => {
        // Sidebar nav link
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#' + piece.id;
        a.className = 'art-nav-link';
        text(a, piece.title);
        li.appendChild(a);
        nav.appendChild(li);

        // Content article
        const article = document.createElement('article');
        article.id = piece.id;
        article.className = 'art-piece';

        piece.images.forEach(img => {
          const wrap = document.createElement('div');
          wrap.className = 'art-image-wrap';
          const imgEl = document.createElement('img');
          imgEl.src = img.src;
          imgEl.alt = img.alt;
          imgEl.className = 'art-image';
          imgEl.loading = 'lazy';
          wrap.appendChild(imgEl);
          article.appendChild(wrap);

          // Lightbox click
          wrap.addEventListener('click', () => openLightbox(img.src, img.alt));
        });

        const desc = document.createElement('p');
        desc.className = 'art-description';
        text(desc, piece.description);
        article.appendChild(desc);

        content.appendChild(article);
      });

      setupScrollTracking(document.getElementById('section-art'));
    } catch (e) {
      console.error('Failed to load art content:', e);
    }
  }

  // ---- Render: Jewelry ----

  async function renderJewelry() {
    try {
      const data = await fetchJSON('content/jewelry.json');
      const nav = document.getElementById('jewelry-nav');
      const content = document.getElementById('jewelry-content');

      data.pieces.forEach(piece => {
        // Sidebar nav link
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#' + piece.id;
        a.className = 'art-nav-link';
        text(a, piece.title);
        li.appendChild(a);
        nav.appendChild(li);

        // Content article
        const article = document.createElement('article');
        article.id = piece.id;
        article.className = 'art-piece';

        piece.images.forEach(img => {
          const wrap = document.createElement('div');
          wrap.className = 'art-image-wrap';
          const imgEl = document.createElement('img');
          imgEl.src = img.src;
          imgEl.alt = img.alt;
          imgEl.className = 'art-image';
          imgEl.loading = 'lazy';
          wrap.appendChild(imgEl);
          article.appendChild(wrap);

          wrap.addEventListener('click', () => openLightbox(img.src, img.alt));
        });

        // Description + price
        const desc = document.createElement('p');
        desc.className = 'art-description';
        text(desc, piece.description);
        article.appendChild(desc);

        // Price + buy button row
        const buyRow = document.createElement('div');
        buyRow.className = 'buy-row';

        const price = document.createElement('span');
        price.className = 'buy-price';
        text(price, piece.price_display);
        buyRow.appendChild(price);

        if (piece.stripe_price_id) {
          const btn = document.createElement('button');
          btn.className = 'buy-btn';
          text(btn, 'Purchase');
          btn.addEventListener('click', () => stripeCheckout(piece.stripe_price_id));
          buyRow.appendChild(btn);
        }

        article.appendChild(buyRow);
        content.appendChild(article);
      });

      setupScrollTracking(document.getElementById('section-jewelry'));
    } catch (e) {
      console.error('Failed to load jewelry content:', e);
    }
  }

  // ---- Render: Consulting ----

  async function renderConsulting() {
    try {
      const data = await fetchJSON('content/consulting.json');
      const textEl = document.getElementById('consulting-text');
      const bgEl = document.getElementById('consulting-bg');

      const h2 = document.createElement('h2');
      text(h2, data.heading);
      textEl.appendChild(h2);

      const p = document.createElement('p');
      text(p, data.message);
      textEl.appendChild(p);

      if (data.background_image) {
        bgEl.style.backgroundImage = `url('${escapeAttr(data.background_image)}')`;
      }
    } catch (e) {
      console.error('Failed to load consulting content:', e);
    }
  }

  // ---- Stripe Checkout ----

  function stripeCheckout(priceId) {
    // Stripe Checkout requires a server-side session or a Stripe Payment Link.
    // For now, we redirect to Stripe Checkout using a Vercel serverless function.
    // Update this URL once your API endpoint is deployed.
    const checkoutUrl = `/api/checkout?price_id=${encodeURIComponent(priceId)}`;
    window.location.href = checkoutUrl;
  }

  // ---- Navigation ----

  function openSection(name) {
    home.classList.add('hidden');
    setTimeout(() => { home.style.display = 'none'; }, 500);
    header.classList.add('visible');

    sections.forEach(s => s.classList.remove('active'));
    const target = document.getElementById('section-' + name);
    if (target) target.classList.add('active');

    headerLinks.forEach(link => {
      link.classList.toggle('active', link.dataset.section === name);
    });

    activeSection = name;
    window.scrollTo(0, 0);
  }

  function goHome() {
    home.style.display = 'flex';
    requestAnimationFrame(() => { home.classList.remove('hidden'); });
    header.classList.remove('visible');
    sections.forEach(s => s.classList.remove('active'));
    headerLinks.forEach(l => l.classList.remove('active'));
    activeSection = null;
  }

  panels.forEach(panel => {
    panel.addEventListener('click', () => openSection(panel.dataset.section));
  });

  headerLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const name = link.dataset.section;
      if (name === activeSection) {
        goHome();
      } else {
        sections.forEach(s => s.classList.remove('active'));
        const target = document.getElementById('section-' + name);
        if (target) target.classList.add('active');
        headerLinks.forEach(l => l.classList.toggle('active', l.dataset.section === name));
        activeSection = name;
        window.scrollTo(0, 0);
      }
    });
  });

  // ---- Sidebar scroll tracking ----

  function setupScrollTracking(sectionEl) {
    const pieces = sectionEl.querySelectorAll('.art-piece');
    const navLinks = sectionEl.querySelectorAll('.art-nav-link');
    if (!pieces.length || !navLinks.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          navLinks.forEach(link => {
            link.classList.toggle('active', link.getAttribute('href') === '#' + id);
          });
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });

    pieces.forEach(piece => observer.observe(piece));
  }

  // ---- Lightbox ----

  function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
  }

  lightbox.querySelector('.lightbox-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  lightbox.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
  });

  // ---- Init ----

  renderHomepage();
  renderArt();
  renderJewelry();
  renderConsulting();
})();
