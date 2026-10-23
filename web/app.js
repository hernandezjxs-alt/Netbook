"use strict";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
const MAX_MB = 50;
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (sel) => document.querySelector(sel);

if (!SUPABASE_URL || SUPABASE_URL.includes("TU-PROYECTO") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("TU-ANON")) {
  document.body.innerHTML =
    '<p style="padding:2rem;font-family:sans-serif;color:#fff">Falta configurar <code>config.js</code> con la URL y la anon key de tu proyecto Supabase.</p>';
  throw new Error("Configuración de Supabase pendiente");
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

const state = {
  user: null,
  profile: null,       // { username, role }
  books: [],
  progress: new Map(), // book_id -> { last_page, updated_at }
  covers: new Map(),   // book_id -> signed url
  query: "",
  activeTags: new Set(), // etiquetas activas en el filtro (coincide con cualquiera)
  selecting: false,      // modo selección múltiple
  selected: new Set(),   // ids seleccionados
};

const DEFAULT_CATEGORIES = [
  "General", "Técnico", "Programación", "Datos y BI", "Tecnología", "Novelas", "Cuentos", "Poesía", "Teatro", "Ciencia ficción",
  "Fantasía", "Terror", "Misterio y policial", "Romance", "Aventura", "Clásicos", "Literatura infantil", "Juvenil", "Cómics y manga",
  "Historia", "Biografías", "Política", "Derecho", "Economía", "Finanzas", "Negocios", "Marketing", "Emprendimiento", "Liderazgo",
  "Desarrollo personal", "Psicología", "Filosofía", "Religión y espiritualidad", "Educación", "Idiomas", "Ciencia", "Matemática",
  "Física y química", "Biología y naturaleza", "Medicina", "Salud y bienestar", "Deportes", "Cocina", "Arte y diseño", "Música",
  "Fotografía", "Arquitectura", "Ingeniería", "Viajes", "Manuales", "Revistas", "Apuntes y estudio", "Documentos",
];
const categoryOptions = () => [...new Set([...DEFAULT_CATEGORIES, ...state.books.map((b) => b.category).filter(Boolean)])];

// Botones para elegir categoría con un toque (el desplegable nativo solo mostraba la opción escrita).
function renderCategoryChips(container, input) {
  const used = new Map();
  for (const b of state.books) if (b.category) used.set(b.category, (used.get(b.category) || 0) + 1);
  const names = [...used.keys()].sort((a, b) => used.get(b) - used.get(a));
  const rest = DEFAULT_CATEGORIES.filter((c) => !used.has(c));
  const mk = (c, mine) =>
    el("button", {
      type: "button",
      class: "chip small" + (input.value.trim().toLowerCase() === c.toLowerCase() ? " active" : ""),
      onclick: () => {
        input.value = c;
        renderCategoryChips(container, input);
        container.closest("details")?.removeAttribute("open");
      },
    }, mine ? `${c} (${used.get(c)})` : c);
  container.replaceChildren(...names.map((c) => mk(c, true)), ...rest.map((c) => mk(c, false)));
}

const NONE_TAG = "__none__";
const FAV_TAG = "__fav__"; // filtro especial: favoritos

// Preferencias de interfaz guardadas en el navegador (con tolerancia a fallos).
const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } };
state.sort = pref("nb_sort", "recent");
state.view = pref("nb_view", "grid");
state.loading = true;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#f6f6f9" : "#0b0b10");
}
applyTheme(pref("nb_theme", "dark")); // filtro especial: libros sin etiquetas

/* ---------- Utilidades ---------- */

// Crea elementos sin innerHTML (evita XSS con títulos de libros).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(msg, ms = 4500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// Confirmación propia: devuelve Promise<boolean>. (confirm() del navegador no funciona bien en algunos móviles.)
function askConfirm(title, nodes, okLabel = "Aceptar") {
  return new Promise((resolve) => {
    $("#cf-title").textContent = title;
    $("#cf-body").replaceChildren(...nodes);
    $("#cf-ok").textContent = okLabel;
    $("#confirm-modal").hidden = false;
    const finish = (v) => {
      $("#confirm-modal").hidden = true;
      $("#cf-ok").onclick = null;
      $("#cf-cancel").onclick = null;
      resolve(v);
    };
    $("#cf-ok").onclick = () => finish(true);
    $("#cf-cancel").onclick = () => finish(false);
  });
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB`;

/* ---------- Autenticación ---------- */

/* RUT chileno */

const cleanRut = (r) => String(r || "").replace(/[^0-9kK]/g, "").toUpperCase();

function validRut(r) {
  const c = cleanRut(r);
  if (c.length < 8 || c.length > 9) return false;
  const body = c.slice(0, -1);
  if (!/^\d+$/.test(body)) return false;
  let sum = 0, mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const calc = 11 - (sum % 11);
  return c.slice(-1) === (calc === 11 ? "0" : calc === 10 ? "K" : String(calc));
}

function formatRut(r) {
  const c = cleanRut(r);
  if (c.length < 2) return c;
  return `${c.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${c.slice(-1)}`;
}

const maskRut = (r) => (r ? `${formatRut(r).slice(0, -5)}***-${r.slice(-1)}` : "—");

// Da formato mientras se escribe.
function bindRutInput(input) {
  input.addEventListener("input", () => {
    input.value = formatRut(input.value);
  });
}
bindRutInput($("#rut"));
bindRutInput($("#pf-rut"));

/* Textos legales (plantilla; conviene revisarlos con un abogado) */

const LEGAL = {
  terms: {
    title: "Términos de uso",
    paras: [
      "Netbook es una biblioteca privada de archivos PDF administrada por JH. Al crear una cuenta aceptas estas condiciones.",
      "Eres responsable de los archivos que subes: solo sube material del que seas autor o tengas permiso para guardar y compartir. Podemos eliminar contenido que infrinja derechos de autor u otras leyes.",
      "Los enlaces para compartir un PDF son temporales (7 días) y cualquiera que los tenga puede abrir ese archivo mientras estén vigentes. Compártelos con cuidado.",
      "El servicio se ofrece tal cual, sin garantía de disponibilidad. Conserva copia de tus archivos importantes.",
      "Podemos suspender cuentas que hagan un uso abusivo del servicio.",
    ],
  },
  privacy: {
    title: "Política de privacidad",
    paras: [
      "Responsable: JH (contacto desde el botón ✉ de esta página).",
      "Datos que guardamos: nombre completo, RUT, correo, nombre de usuario, los libros que subes y tu progreso de lectura. Si usas el formulario de contacto, guardamos lo que escribas en él.",
      "Para qué: identificar a las personas que suben libros, administrar tu cuenta y responder tus mensajes. No vendemos ni compartimos tus datos con terceros.",
      "Dónde: en Supabase (base de datos y almacenamiento privado, con acceso restringido por cuenta). Solo el administrador puede ver los datos de perfil; tus libros solo los ves tú.",
      "Tus derechos: puedes pedir acceso, corrección o eliminación de tus datos escribiendo desde el botón de contacto.",
      "Conservamos los datos mientras tengas cuenta y los eliminamos cuando lo solicites.",
    ],
  },
};

function openLegal(kind) {
  const d = LEGAL[kind];
  $("#lg-title").textContent = d.title;
  $("#lg-body").replaceChildren(...d.paras.map((t) => el("p", {}, t)), el("p", { class: "muted" }, "Última actualización: octubre 2026."));
  $("#legal-modal").hidden = false;
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-legal]");
  if (t) openLegal(t.dataset.legal);
});
$("#lg-close").addEventListener("click", () => ($("#legal-modal").hidden = true));

/* ---------- Autenticación ---------- */

let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("#signup-fields").hidden = !signup;
  $("#consent-row").hidden = !signup;
  $("#btn-submit").textContent = signup ? "Crear cuenta" : "Entrar";
  $("#btn-mode").textContent = signup ? "Ya tengo cuenta" : "Crear cuenta";
  $("#btn-forgot").hidden = signup;
  $("#auth-sub").textContent = signup ? "Crea tu cuenta" : "Biblioteca digital abierta para leer, compartir y descargar libros";
  $("#password").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-msg").textContent = "";
}

async function doAuth(mode) {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const msg = $("#auth-msg");
  msg.textContent = "";
  if (!email || password.length < 6) {
    msg.textContent = "Ingresa un correo y una contraseña de al menos 6 caracteres.";
    return;
  }
  if (mode === "signup") {
    const fullName = $("#full-name").value.trim();
    if (fullName.length < 2) { msg.textContent = "Escribe tu nombre completo."; return; }
    if (!validRut($("#rut").value)) { msg.textContent = "El RUT no es válido. Revisa el número y el dígito verificador."; return; }
    if (!$("#consent").checked) { msg.textContent = "Debes aceptar los Términos y la Política de privacidad."; return; }
  }
  $("#btn-submit").disabled = true;
  try {
    const { data, error } =
      mode === "signup"
        ? await sb.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: location.origin + location.pathname,
              data: {
                username: $("#username").value.trim(),
                full_name: $("#full-name").value.trim(),
                rut: formatRut($("#rut").value),
                consent: "true",
              },
            },
          })
        : await sb.auth.signInWithPassword({ email, password });
    if (error) {
      msg.textContent = /duplicate key|profiles_rut/i.test(error.message)
        ? "Ese RUT ya está registrado."
        : /database error/i.test(error.message)
        ? "No se pudo crear la cuenta: revisa que el RUT no esté ya registrado."
        : error.message;
      return;
    }
    if (mode === "signup" && !data.session) {
      msg.textContent = "Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.";
    }
  } finally {
    $("#btn-submit").disabled = false;
  }
}

$("#btn-mode").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
$("#btn-forgot").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const msg = $("#auth-msg");
  if (!email) { msg.textContent = "Escribe tu correo arriba y vuelve a pulsar «¿Olvidaste tu contraseña?»."; return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  msg.textContent = error ? error.message : "Si el correo existe, te enviamos un enlace para crear una nueva contraseña.";
});

$("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $("#rs-pass").value });
  if (error) { $("#rs-status").textContent = error.message; return; }
  $("#reset-modal").hidden = true;
  toast("Contraseña actualizada");
});

function setSession(session) {
  const prevId = state.user?.id;
  state.user = session?.user ?? null;
  $("#auth").hidden = !!state.user;
  $("#app").hidden = !state.user;
  if (state.user && state.user.id !== prevId) {
    refresh();
  } else if (!state.user) {
    state.profile = null;
    askedProfile = false;
    state.activeTags.clear();
    state.selected.clear();
    state.selecting = false;
    document.body.classList.remove("selecting");
    renderBadge();
    state.books = [];
    state.progress.clear();
    state.covers.clear();
    render();
  }
}

$("#auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doAuth(authMode);
});
$("#btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
});

/* ---------- Datos ---------- */

function renderBadge() {
  const badge = $("#user-badge");
  if (!state.profile) {
    badge.hidden = true;
    return;
  }
  const { username, role } = state.profile;
  badge.textContent = `${username || state.user?.email} · ${role === "admin" ? "Admin" : "Usuario"}`;
  badge.classList.toggle("admin", role === "admin");
  badge.hidden = false;
}

async function loadProfile() {
  // Si aún no se ejecutó profiles.sql, la tabla no existe: la app sigue funcionando sin rol.
  const { data, error } = await sb.from("profiles").select("username,role,full_name,rut,consent_at").eq("id", state.user.id).maybeSingle();
  state.profile = error ? null : data;
  renderBadge();
  $("#btn-inbox").hidden = state.profile?.role !== "admin";
  $("#btn-users").hidden = state.profile?.role !== "admin";
  loadInbox();
  maybeAskProfile();
}

async function refresh() {
  loadProfile();
  const [booksRes, progRes, favRes] = await Promise.all([
    sb.from("books").select("*").order("created_at", { ascending: false }),
    sb.from("reading_progress").select("book_id,last_page,updated_at"),
    sb.from("favorites").select("book_id"),
  ]);
  const err = booksRes.error || progRes.error;
  if (err) {
    state.loading = false;
    render();
    toast(`No se pudo cargar la biblioteca: ${err.message}`);
    return;
  }
  const favs = new Set((favRes.data || []).map((f) => f.book_id)); // (si falla, solo no se ven los favoritos)
  state.books = booksRes.data.map((b) => ({ ...b, favorite: favs.has(b.id) }));
  state.loading = false;
  state.progress = new Map(progRes.data.map((p) => [p.book_id, p]));
  await loadCovers();
  render();
}

async function loadCovers() {
  state.covers.clear();
  const paths = state.books.map((b) => b.cover_path).filter(Boolean);
  if (!paths.length) return;
  const { data, error } = await sb.storage.from("covers").createSignedUrls(paths, 3600);
  if (error || !data) return;
  const byPath = new Map(data.map((d) => [d.path, d.signedUrl]));
  for (const b of state.books) {
    const url = b.cover_path && byPath.get(b.cover_path);
    if (url) state.covers.set(b.id, url);
  }
}

/* ---------- Render: filas estilo Netflix ---------- */

function cardEl(b, rank = null, stat = null) {
  const cover = state.covers.get(b.id);
  const p = state.progress.get(b.id);
  const pct = p && b.pages ? clamp(Math.round((p.last_page / b.pages) * 100), 0, 100) : 0;
  return el(
    "button",
    {
      class: "card" + (state.selected.has(b.id) ? " selected" : ""),
      type: "button",
      title: b.title,
      onclick: (ev) => (state.selecting ? toggleSelect(b.id, ev.currentTarget) : openDetail(b)),
    },
    cover ? el("img", { src: cover, alt: "", loading: "lazy" }) : el("div", { class: "ph" }, b.title),
    el("div", { class: "card-info" }, el("strong", {}, b.title), el("span", {}, b.author || b.category)),
    el("span", { class: "check-badge", "aria-hidden": "true" }, "✓"),
    state.selecting || !canEdit(b) ? null : el("span", {
      class: "card-edit", role: "button", tabindex: "0", title: "Editar", "aria-label": `Editar ${b.title}`,
      onclick: (ev) => { ev.stopPropagation(); openEdit(b); },
      onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); openEdit(b); } },
    }, "✎"),
    b.favorite && !rank ? el("span", { class: "fav-badge", "aria-label": "Favorito" }, "♥") : null,
    rank ? el("span", { class: "rank" + (rank <= 3 ? " top" : "") }, `#${rank}`) : null,
    stat ? el("span", { class: "stat" }, stat) : null,
    pct > 0 ? el("div", { class: "bar" }, el("i", { style: `width:${pct}%` })) : null
  );
}

function rowEl(title, books, grid = false, decorate = null) {
  const section = el("section", { class: "row" }, el("h2", {}, title));
  if (grid && !books.length) {
    section.append(el("p", { class: "muted" }, "Sin resultados."));
    return section;
  }
  const strip = el("div", { class: grid ? "strip grid" : "strip" }, books.map((b, i) => (decorate ? cardEl(b, ...decorate(b, i)) : cardEl(b))));
  if (grid) {
    section.append(strip);
    return section;
  }
  const scroll = (dir) => strip.scrollBy({ left: dir * strip.clientWidth * 0.85, behavior: "smooth" });
  section.append(
    el(
      "div",
      { class: "row-wrap" },
      el("button", { class: "arrow left", type: "button", "aria-label": "Anterior", onclick: () => scroll(-1) }, "‹"),
      strip,
      el("button", { class: "arrow right", type: "button", "aria-label": "Siguiente", onclick: () => scroll(1) }, "›")
    )
  );
  return section;
}

function continueReading() {
  return state.books
    .filter((b) => {
      const p = state.progress.get(b.id);
      return p && p.last_page > 1 && (!b.pages || p.last_page < b.pages);
    })
    .sort((a, b) => new Date(state.progress.get(b.id).updated_at) - new Date(state.progress.get(a.id).updated_at));
}

function renderHero(resuming) {
  const hero = $("#hero");
  const book = resuming[0] || state.books[0];
  if (!book || isFiltering() || customView()) {
    hero.hidden = true;
    return;
  }
  hero.hidden = false;
  const cover = state.covers.get(book.id);
  const img = $("#hero-img");
  if (cover) img.src = cover;
  else img.removeAttribute("src");
  img.hidden = !cover;
  const poster = $("#hero-cover");
  if (cover) poster.src = cover;
  else poster.removeAttribute("src");
  poster.hidden = !cover;
  $("#hero-kicker").textContent = resuming[0] ? "Continuar leyendo" : "Agregado recientemente";
  $("#hero-title").textContent = book.title;
  $("#hero-author").textContent = book.author || book.category;
  $("#hero-btn").textContent = resuming[0] ? "▶ Continuar" : "▶ Leer";
  $("#hero-btn").onclick = () => openReader(book);
}

/* ---------- Etiquetas y filtros ---------- */

const tagsOf = (b) => b.tags || [];
// Solo el dueño del libro (o el admin) puede editarlo, etiquetarlo o eliminarlo.
const canEdit = (b) => !!state.user && (b.user_id === state.user.id || state.profile?.role === "admin");

// [[etiqueta, cantidad], ...] ordenadas por cantidad y luego alfabéticamente.
function allTags() {
  const counts = new Map();
  for (const b of state.books) for (const t of tagsOf(b)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"));
}

// Convierte "it, analista bi" en ["IT", "Analista BI"] respetando la escritura de etiquetas ya existentes.
function normTags(text) {
  const canon = new Map();
  for (const t of NetbookMeta.DEFAULT_TAGS) canon.set(t.toLowerCase(), t);
  for (const [t] of allTags()) canon.set(t.toLowerCase(), t);
  const out = [];
  for (const raw of String(text || "").split(",")) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, 30);
    if (!t) continue;
    const name = canon.get(t.toLowerCase()) || t;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.slice(0, 10);
}

function unionTags(current, added) {
  const out = [...current];
  for (const t of added) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out.slice(0, 10);
}

// Botones "+ Etiqueta" para agregar rápido al campo de texto.
function renderSuggestions(container, input) {
  const names = [...new Set([...allTags().map(([t]) => t), ...NetbookMeta.DEFAULT_TAGS])];
  container.replaceChildren(
    ...names.map((t) =>
      el(
        "button",
        {
          type: "button",
          class: "chip small",
          onclick: () => {
            input.value = unionTags(normTags(input.value), [t]).join(", ");
          },
        },
        `+ ${t}`
      )
    )
  );
}

function matchesFilters(b) {
  const q = state.query.trim().toLowerCase();
  if (q && ![b.title, b.author, b.category, ...tagsOf(b)].some((v) => (v || "").toLowerCase().includes(q))) {
    return false;
  }
  if (state.activeTags.size) {
    const tags = tagsOf(b);
    const untagged = state.activeTags.has(NONE_TAG) && tags.length === 0;
    const fav = state.activeTags.has(FAV_TAG) && !!b.favorite;
    if (!untagged && !fav && !tags.some((t) => state.activeTags.has(t))) return false;
  }
  return true;
}

const isFiltering = () => state.query.trim() !== "" || state.activeTags.size > 0;
const customView = () => state.sort !== "recent" || state.view === "list";

const SORTS = {
  recent: (a, b) => new Date(b.created_at) - new Date(a.created_at),
  title: (a, b) => a.title.localeCompare(b.title, "es"),
  author: (a, b) => (a.author || "\uffff").localeCompare(b.author || "\uffff", "es") || a.title.localeCompare(b.title, "es"),
  read: (a, b) => (b.opens || 0) - (a.opens || 0) || a.title.localeCompare(b.title, "es"),
  pages: (a, b) => (b.pages || 0) - (a.pages || 0),
};
const sortedBooks = (list) => [...list].sort(SORTS[state.sort] || SORTS.recent);

// Vista de lista: miniatura + datos en una línea.
function listItemEl(b) {
  const cover = state.covers.get(b.id);
  const p = state.progress.get(b.id);
  const pct = p && b.pages ? clamp(Math.round((p.last_page / b.pages) * 100), 0, 100) : 0;
  return el(
    "div",
    {
      class: "list-item" + (state.selected.has(b.id) ? " selected" : ""),
      role: "button", tabindex: "0",
      onclick: (ev) => (state.selecting ? toggleSelect(b.id, ev.currentTarget) : openDetail(b)),
      onkeydown: (ev) => { if (ev.key === "Enter") ev.currentTarget.click(); },
    },
    cover ? el("img", { src: cover, alt: "", loading: "lazy" }) : el("div", { class: "ph" }, "📕"),
    el(
      "div",
      { class: "li-body" },
      el("strong", {}, (b.favorite ? "♥ " : "") + b.title),
      el("span", { class: "muted" }, [b.author, b.category, b.pages ? `${b.pages} pág.` : null].filter(Boolean).join(" · ")),
      tagsOf(b).length ? el("span", { class: "li-tags" }, tagsOf(b).join(" · ")) : null,
      pct > 0 ? el("div", { class: "bar inline" }, el("i", { style: `width:${pct}%` })) : null
    ),
    state.selecting || !canEdit(b) ? null : el("button", { class: "icon", type: "button", title: "Editar", "aria-label": "Editar", onclick: (ev) => { ev.stopPropagation(); openEdit(b); } }, "✎")
  );
}

function skeletonRows() {
  const row = el("section", { class: "row" }, el("div", { class: "skel-title" }), el("div", { class: "strip" }, Array.from({ length: 8 }, () => el("div", { class: "card skel" }))));
  return [row, row.cloneNode(true)];
}
const visibleBooks = () => state.books.filter(matchesFilters);

function toggleTag(key) {
  if (key === null) state.activeTags.clear();
  else if (state.activeTags.has(key)) state.activeTags.delete(key);
  else state.activeTags.add(key);
  render();
}

function renderFilters() {
  const nav = $("#filters");
  nav.hidden = !state.books.length;
  if (!state.books.length) return;
  const untagged = state.books.filter((b) => !tagsOf(b).length && canEdit(b)).length;
  const favs = state.books.filter((b) => b.favorite).length;
  $("#sort").value = state.sort;
  $("#btn-view").textContent = state.view === "list" ? "▦" : "☰";
  const chip = (label, key, count, active) =>
    el("button", { type: "button", class: "chip" + (active ? " active" : ""), onclick: () => toggleTag(key) }, `${label} (${count})`);
  $("#chips").replaceChildren(
    ...[
      chip("Todos", null, state.books.length, state.activeTags.size === 0),
      favs ? chip("♥ Favoritos", FAV_TAG, favs, state.activeTags.has(FAV_TAG)) : null,
      ...allTags().map(([t, n]) => chip(t, t, n, state.activeTags.has(t))),
      untagged ? chip("Sin etiqueta", NONE_TAG, untagged, state.activeTags.has(NONE_TAG)) : null,
    ].filter(Boolean)
  );
  $("#btn-autotag").hidden = !untagged;
  $("#btn-select").textContent = state.selecting ? "✕" : "☑";
  $("#btn-select").title = state.selecting ? "Salir de la selección" : "Seleccionar varios";
}

function ago(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "hoy";
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${d} días`;
  return new Date(iso).toLocaleDateString("es-CL");
}

function renderPulse() {
  const box = $("#pulse");
  const books = state.books;
  box.hidden = !books.length || !state.user;
  if (box.hidden) return;
  const week = Date.now() - 7 * 86400000;
  const fresh = books.filter((b) => new Date(b.created_at).getTime() > week).length;
  const people = new Set(books.map((b) => b.user_id)).size;
  const last = books[0];
  const card = (icon, value, label) =>
    el("div", { class: "pulse-card" }, el("span", { class: "pulse-ico" }, icon), el("strong", {}, String(value)), el("span", { class: "pulse-lbl" }, label));
  box.replaceChildren(
    card("📚", books.length, "libros en la biblioteca"),
    card("🆕", fresh, "nuevos esta semana"),
    card("👥", people, people === 1 ? "colaborador" : "colaboradores"),
    el("div", { class: "pulse-card wide" }, el("span", { class: "pulse-ico" }, "✨"), el("span", { class: "pulse-lbl" }, "Último agregado"), el("strong", { class: "pulse-last" }, last.title), el("span", { class: "pulse-lbl" }, ago(last.created_at)))
  );
}

function render() {
  const rows = $("#rows");
  rows.replaceChildren();
  const hasBooks = state.books.length > 0;
  $("#empty").hidden = hasBooks || !state.user || state.loading;
  if (state.loading && state.user && !hasBooks) {
    $("#hero").hidden = true;
    rows.append(...skeletonRows());
    return;
  }
  renderFilters();
  renderPulse();
  updateSelbar();
  if (!hasBooks) {
    $("#hero").hidden = true;
    return;
  }

  const resuming = continueReading();
  renderHero(resuming);

  if (isFiltering() || customView()) {
    const hits = sortedBooks(visibleBooks());
    const parts = [];
    if (state.query.trim()) parts.push(`"${state.query.trim()}"`);
    if (state.activeTags.size) {
      parts.push([...state.activeTags].map((t) => (t === NONE_TAG ? "Sin etiqueta" : t === FAV_TAG ? "Favoritos" : t)).join(" o "));
    }
    const heading = parts.length ? `Resultados: ${parts.join(" · ")} (${hits.length})` : `Biblioteca (${hits.length})`;
    if (state.view === "list") {
      const sec = el("section", { class: "row" }, el("h2", {}, heading));
      sec.append(hits.length ? el("div", { class: "list" }, hits.map(listItemEl)) : el("p", { class: "muted" }, "Sin resultados."));
      rows.append(sec);
    } else {
      rows.append(rowEl(heading, hits, true));
    }
    return;
  }

  if (resuming.length) rows.append(rowEl("Continuar leyendo", resuming));
  const mostRead = state.books.filter((b) => (b.opens || 0) > 0).sort((a, b) => b.opens - a.opens).slice(0, 10);
  if (mostRead.length) rows.append(rowEl("🔥 Más leídos", mostRead, false, (b, i) => [i + 1, `${b.opens} 👁`]));
  const mostDl = state.books.filter((b) => (b.downloads || 0) > 0).sort((a, b) => b.downloads - a.downloads).slice(0, 10);
  if (mostDl.length) rows.append(rowEl("⬇ Más descargados", mostDl, false, (b, i) => [i + 1, `${b.downloads} ⬇`]));
  const favBooks = state.books.filter((b) => b.favorite);
  if (favBooks.length) rows.append(rowEl("♥ Mis favoritos", favBooks.slice(0, 20)));
  rows.append(rowEl("Agregados recientemente", state.books.slice(0, 15)));

  const groups = new Map();
  for (const b of state.books) {
    const key = b.category || "General";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  [...groups.keys()]
    .sort((a, b) => a.localeCompare(b, "es"))
    .forEach((cat) => rows.append(rowEl(cat, groups.get(cat))));
}

/* ---------- Modo selección y etiquetado masivo ---------- */

function updateSelbar() {
  $("#selbar").hidden = !state.selecting;
  $("#sel-count").textContent = `${state.selected.size} seleccionado(s)`;
  $("#sel-tag").disabled = state.selected.size === 0;
}

function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  document.body.classList.toggle("selecting", on);
  render();
}

function toggleSelect(id, node) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  node.classList.toggle("selected", state.selected.has(id));
  updateSelbar();
}

// Aplica etiquetas agrupando libros con el mismo resultado para hacer pocas peticiones.
// Devuelve null si todo salió bien o el mensaje de error.
async function applyTagUpdates(updates) {
  const groups = new Map();
  for (const u of updates) {
    const key = u.tags.join("\u0001");
    if (!groups.has(key)) groups.set(key, { tags: u.tags, books: [] });
    groups.get(key).books.push(u.book);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.books.length; i += 100) {
      const chunk = g.books.slice(i, i + 100);
      const { error } = await sb.from("books").update({ tags: g.tags }).in("id", chunk.map((b) => b.id));
      if (error) return error.message;
      chunk.forEach((b) => (b.tags = g.tags));
    }
  }
  return null;
}

$("#btn-select").addEventListener("click", () => setSelecting(!state.selecting));
$("#sel-cancel").addEventListener("click", () => setSelecting(false));
$("#sel-all").addEventListener("click", () => {
  state.selected = new Set(visibleBooks().map((b) => b.id));
  render();
});

$("#sel-tag").addEventListener("click", () => {
  $("#tg-count").textContent = `${state.selected.size} libro(s)`;
  $("#tg-tags").value = "";
  $("#tg-status").textContent = "";
  renderSuggestions($("#tg-sugs"), $("#tg-tags"));
  $("#tag-modal").hidden = false;
});
$("#tg-cancel").addEventListener("click", () => ($("#tag-modal").hidden = true));

$("#tag-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const added = normTags($("#tg-tags").value);
  if (!added.length) {
    $("#tg-status").textContent = "Escribe al menos una etiqueta.";
    return;
  }
  const updates = state.books
    .filter((b) => state.selected.has(b.id) && canEdit(b))
    .map((book) => ({ book, tags: unionTags(tagsOf(book), added) }));
  const err = await applyTagUpdates(updates);
  if (err) {
    $("#tg-status").textContent = `No se pudo guardar: ${err}`;
    render();
    return;
  }
  $("#tag-modal").hidden = true;
  toast(`Etiquetas agregadas a ${updates.length} libro(s)`);
  setSelecting(false);
});

$("#btn-autotag").addEventListener("click", async () => {
  try {
    const untagged = state.books.filter((b) => !tagsOf(b).length && canEdit(b));
    const updates = untagged
      .map((book) => ({ book, tags: NetbookMeta.suggestTags(book.title) }))
      .filter((u) => u.tags.length);
    if (!updates.length) {
      toast("Ningún título sin etiqueta coincide con las reglas. Etiquétalos con «Seleccionar».", 7000);
      return;
    }
    const counts = new Map();
    for (const u of updates) for (const t of u.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const ok = await askConfirm(
      "Etiquetar automático",
      [
        el("p", {}, `Se etiquetarán ${updates.length} de ${untagged.length} libros sin etiqueta, según palabras de su título:`),
        el("ul", { class: "cf-list" }, [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([t, n]) => el("li", {}, `${t}: ${n}`))),
        el("p", { class: "muted" }, "Un libro puede recibir varias. Podrás corregirlas después."),
      ],
      "Etiquetar"
    );
    if (!ok) return;
    toast("Guardando etiquetas…", 30000);
    const err = await applyTagUpdates(updates);
    render();
    toast(
      err
        ? `Se interrumpió: ${err}`
        : `${updates.length} libro(s) etiquetados. Quedan ${untagged.length - updates.length} sin etiqueta.`,
      7000
    );
  } catch (err) {
    toast(`No se pudo etiquetar: ${err?.message || err}`, 9000);
  }
});

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

/* ---------- Subida ---------- */

let lastReport = []; // [{ name, status, detail }]

function openUpload() {
  $("#upload-form").reset();
  $("#up-category").value = "General";
  upStatus("");
  clearReport();
  $("#up-submit").hidden = false;
  $("#up-submit").disabled = false;
  $("#up-cancel").disabled = false;
  setUploadDone(false);
  $("#single-fields").hidden = false;
  $("#up-title").required = true;
  lastAutoTags = "";
  renderSuggestions($("#up-tag-sugs"), $("#up-tags"));
  renderCategoryChips($("#up-cat-sugs"), $("#up-category"));
  $("#upload-modal").hidden = false;
}

// Vista final del modal: solo el informe y un botón «Finalizar».
function setUploadDone(done) {
  $("#upload-form").classList.toggle("done", done);
  $("#up-title-h").textContent = done ? "Subida finalizada" : "Subir PDF";
  $("#up-cancel").textContent = done ? "Finalizar" : "Cancelar";
  $("#up-cancel").className = done ? "btn primary" : "btn ghost";
}

function closeUpload() {
  const wasDone = $("#upload-form").classList.contains("done");
  $("#upload-modal").hidden = true;
  if (wasDone) {
    $("#search").value = "";
    state.query = "";
    state.activeTags.clear();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" }); // vuelve a la página principal
  }
}

$("#up-category").addEventListener("input", () => renderCategoryChips($("#up-cat-sugs"), $("#up-category")));
$("#ed-category").addEventListener("input", () => renderCategoryChips($("#ed-cat-sugs"), $("#ed-category")));
$("#btn-upload").addEventListener("click", openUpload);
$("#btn-upload-empty").addEventListener("click", openUpload);
$("#up-cancel").addEventListener("click", closeUpload);

function upStatus(text, info = true) {
  const s = $("#up-status");
  s.textContent = text;
  s.classList.toggle("info", info);
}

/* Informe por archivo */

const ICONS = { ok: "✓", dup: "↺", big: "✕", notpdf: "✕", error: "✕" };
const LABELS = { ok: "subido(s)", dup: "repetido(s)", big: "demasiado pesado(s)", notpdf: "no es PDF", error: "con error" };

function clearReport() {
  lastReport = [];
  $("#up-summary").hidden = true;
  $("#up-report").hidden = true;
  $("#up-report").replaceChildren();
  $("#up-copy").hidden = true;
}

function renderReport(items, { final = false } = {}) {
  lastReport = items;
  const counts = {};
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  const parts = Object.keys(LABELS).filter((k) => counts[k]).map((k) => `${counts[k]} ${LABELS[k]}`);
  const sum = $("#up-summary");
  sum.hidden = !items.length;
  sum.textContent = `${final ? "Resultado" : "Revisión"} (${items.length} archivo${items.length === 1 ? "" : "s"}): ${parts.join(" · ")}`;
  const list = $("#up-report");
  list.hidden = !items.length;
  list.replaceChildren(
    ...items.map((it) =>
      el(
        "li",
        { class: it.status === "ok" ? "ok" : it.status === "dup" ? "dup" : "bad" },
        el("span", { class: "ico", "aria-hidden": "true" }, ICONS[it.status] || "•"),
        el("span", { class: "name" }, it.name, it.detail ? el("span", { class: "why" }, it.detail) : null)
      )
    )
  );
  $("#up-copy").hidden = !final;
}

$("#up-copy").addEventListener("click", async () => {
  const text = lastReport
    .map((it) => `${ICONS[it.status] || "•"} ${it.name}${it.detail ? " — " + it.detail : ""}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Informe copiado");
  } catch {
    toast("No se pudo copiar; haz captura de pantalla del informe");
  }
});

// Mensajes entendibles para errores técnicos.
function friendlyError(err) {
  const msg = String(err?.message || err || "");
  const code = String(err?.statusCode || err?.status || "");
  if (/exceeded the maximum allowed size|payload too large|too large/i.test(msg) || code === "413")
    return `pesa más de lo que permite el servidor (${MAX_MB} MB)`;
  if (/quota|storage limit|402|exceed_.*limit|not enough space/i.test(msg) || code === "402")
    return "se llenó el almacenamiento (1 GB del plan gratuito); elimina libros o amplía el plan";
  if (/already exists|duplicate/i.test(msg) || code === "409") return "ya existe un archivo igual";
  if (/jwt|expired|not authenticated|invalid token/i.test(msg) || code === "401")
    return "la sesión caducó; sal y vuelve a entrar";
  if (/row-level security|violates|permission|not allowed/i.test(msg) || code === "403")
    return "sin permiso para guardarlo (revisa tu sesión y las políticas de Supabase)";
  if (/failed to fetch|networkerror|network request failed|load failed|timeout/i.test(msg))
    return "se cortó la conexión; vuelve a intentarlo con mejor señal";
  if (/password/i.test(msg)) return "el PDF tiene contraseña";
  if (/invalid pdf|missing pdf|invalidpdf|unexpected server response|formaterror/i.test(msg))
    return "el PDF está dañado o no se puede leer";
  return msg || "error desconocido";
}

// Problemas detectables antes de subir: tamaño y tipo.
function precheck(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return { status: "notpdf", name: file.name, detail: "no es un archivo PDF" };
  if (file.size > MAX_MB * 1024 * 1024)
    return { status: "big", name: file.name, detail: `pesa ${fmtMB(file.size)} y el límite es ${MAX_MB} MB` };
  if (file.size === 0) return { status: "error", name: file.name, detail: "el archivo está vacío" };
  return null;
}

let guessToken = 0;
let lastAutoTags = ""; // última sugerencia puesta automáticamente en el campo de etiquetas

async function guessFromFile(file) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    return await NetbookMeta.guessMeta(pdf, file.name);
  } finally {
    pdf.destroy();
  }
}

$("#up-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  const multi = files.length > 1;
  const token = ++guessToken;
  $("#single-fields").hidden = multi;
  $("#up-title").required = !multi;
  $("#up-title").value = "";
  $("#up-author").value = "";
  $("#up-submit").hidden = false;
  setUploadDone(false);
  upStatus("");
  clearReport();

  const problems = files.map(precheck).filter(Boolean);
  const valid = files.length - problems.length;
  $("#up-submit").disabled = files.length > 0 && valid === 0;
  if (problems.length) renderReport(problems);

  if (multi) {
    upStatus(
      `${files.length} archivos seleccionados` +
        (problems.length ? `: ${valid} se pueden subir y ${problems.length} se omitirán (ver abajo). ` : ". ") +
        "El título y el autor se detectan solos leyendo cada portada. Las etiquetas que escribas se aplican a todos.",
      !problems.length
    );
    return;
  }
  const file = files[0];
  if (!file) return;
  if (problems.length) {
    upStatus(problems[0].detail.charAt(0).toUpperCase() + problems[0].detail.slice(1) + ".", false);
    return;
  }
  upStatus("Leyendo portada…");
  try {
    const g = await guessFromFile(file);
    if (token !== guessToken) return;
    $("#up-title").value = g.title;
    $("#up-author").value = g.author || "";
    const cur = $("#up-tags").value.trim();
    if ($("#up-autotags").checked && (cur === "" || cur === lastAutoTags)) {
      lastAutoTags = NetbookMeta.suggestTags(g.title).join(", ");
      $("#up-tags").value = lastAutoTags;
    }
    upStatus(
      g.source === "filename"
        ? "No se encontró el título dentro del PDF, se usó el nombre del archivo. Revísalo."
        : "Título y autor detectados. Revísalos antes de subir."
    );
  } catch (err) {
    if (token !== guessToken) return;
    $("#up-title").value = NetbookMeta.cleanFilename(file.name);
    upStatus(`No se pudo leer el PDF (${friendlyError(err)}). Aun así puedes intentar subirlo.`, false);
  }
});

async function renderCover(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 400 / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
}

// Sube un PDF: detecta datos, genera portada, guarda archivo y fila.
// Devuelve { status: "ok"|"dup"|"big"|"notpdf"|"error", title, detail, source }.
async function uploadOne(file, meta) {
  const pre = precheck(file);
  if (pre) return { status: pre.status, detail: pre.detail };

  const id = crypto.randomUUID();
  const uid = state.user.id;
  const pdfPath = `${uid}/${id}.pdf`;
  const coverPath = `${uid}/${id}.jpg`;
  let pdf = null;
  let pdfUploaded = false;
  let coverUploaded = false;
  let step = "leer el PDF";

  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = pdf.numPages;
    let { title, author } = meta;
    let source = "manual";
    let key = null;
    let tags = meta.tags || [];

    if (meta.auto) {
      const g = await NetbookMeta.guessMeta(pdf, file.name);
      title = g.title;
      author = g.author;
      source = g.source;
      key = `${title.toLowerCase()}|${pages}`;
      if (meta.known.has(key))
        return { status: "dup", title, detail: `repetido: ya tienes «${title}» con ${pages} páginas` };
      tags = unionTags(meta.userTags, meta.autoTags ? NetbookMeta.suggestTags(title) : []);
    } else {
      key = `${title.toLowerCase()}|${pages}`;
      if (meta.known.has(key))
        return { status: "dup", title, detail: `repetido: ya tienes «${title}» con ${pages} páginas` };
    }

    step = "generar la portada";
    const coverBlob = await renderCover(pdf);

    step = "subir el PDF";
    const up1 = await sb.storage.from("pdfs").upload(pdfPath, file, { contentType: "application/pdf" });
    if (up1.error) throw up1.error;
    pdfUploaded = true;

    step = "subir la portada";
    const up2 = await sb.storage.from("covers").upload(coverPath, coverBlob, { contentType: "image/jpeg" });
    if (up2.error) throw up2.error;
    coverUploaded = true;

    step = "guardar el registro";
    const { error } = await sb.from("books").insert({
      id,
      title,
      author: author || null,
      category: meta.category,
      tags,
      pages,
      size_bytes: file.size,
      is_public: meta.isPublic !== false,
      pdf_path: pdfPath,
      cover_path: coverPath,
    });
    if (error) throw error;

    if (key) meta.known.add(key);
    return { status: "ok", title, source, detail: source === "filename" ? "título tomado del nombre del archivo; corrígelo con ✎ en el lector" : "" };
  } catch (err) {
    // Limpia archivos huérfanos si algo falló a medio camino.
    try {
      if (pdfUploaded) await sb.storage.from("pdfs").remove([pdfPath]);
      if (coverUploaded) await sb.storage.from("covers").remove([coverPath]);
    } catch { /* sin conexión: queda para limpiar luego */ }
    return { status: "error", detail: `falló al ${step}: ${friendlyError(err)}` };
  } finally {
    if (pdf) pdf.destroy();
  }
}

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = [...$("#up-file").files];
  if (!files.length) return;
  const submit = $("#up-submit");
  const cancel = $("#up-cancel");
  const multi = files.length > 1;
  const category = $("#up-category").value.trim() || "General";
  const userTags = normTags($("#up-tags").value);
  const autoTags = $("#up-autotags").checked;

  submit.disabled = true;
  cancel.disabled = true;
  clearReport();

  // Evita duplicar libros ya subidos (mismo título detectado y mismas páginas).
  const known = new Set(state.books.map((b) => `${b.title.toLowerCase()}|${b.pages}`));
  const report = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      upStatus(`Subiendo ${i + 1} de ${files.length}: ${f.name}`);
      let meta;
      if (multi) {
        meta = { auto: true, known, category, userTags, autoTags, isPublic: $("#up-public").checked };
      } else {
        const title = $("#up-title").value.trim() || NetbookMeta.cleanFilename(f.name);
        meta = {
          auto: false,
          known,
          isPublic: $("#up-public").checked,
          title,
          author: $("#up-author").value.trim() || null,
          category,
          tags: userTags.length || !autoTags ? userTags : NetbookMeta.suggestTags(title),
        };
      }
      let res;
      try {
        res = await uploadOne(f, meta);
      } catch (err) {
        res = { status: "error", detail: friendlyError(err) };
      }
      report.push({ name: res.title && res.title !== f.name ? `${res.title}  (${f.name})` : f.name, status: res.status, detail: res.detail });
    }
  } finally {
    try { await refresh(); } catch { /* el informe se muestra igual */ }
    cancel.disabled = false;
  }

  const okCount = report.filter((r) => r.status === "ok").length;
  if (okCount && state.profile?.role !== "admin") notifyUpload(okCount, report.filter((r) => r.status === "ok").map((r) => r.name.split("  (")[0]));
  const noteCount = report.filter((r) => r.status === "ok" && r.detail).length;
  // Primero lo que requiere atención, al final lo que salió bien.
  const order = { error: 0, big: 1, notpdf: 2, dup: 3, ok: 4 };
  report.sort((x, y) => order[x.status] - order[y.status]);

  if (okCount === report.length && !noteCount) {
    closeUpload();
    toast(`${okCount} libro(s) agregado(s)`, 6000);
    return;
  }
  upStatus(
    okCount === report.length
      ? `Se subieron los ${okCount} libros. Algunos títulos conviene revisarlos.`
      : `Se subieron ${okCount} de ${report.length}. Los demás no se subieron por los motivos de abajo.`,
    okCount === report.length
  );
  renderReport(report, { final: true });
  submit.hidden = true;
  setUploadDone(true);
  $("#upload-modal").querySelector(".modal-card").scrollTop = 0;
});

/* ---------- Lector ---------- */

const reader = {
  book: null,
  pdf: null,
  page: 1,
  zoom: 1,
  tasks: [],
  limit: 0,        // última página accesible (en vista previa es menor que el total)
  preview: false,  // vista previa: solo unas pocas páginas, sin guardar progreso
  spread: false,   // dos páginas a la vez
  token: 0, // invalida cargas obsoletas al cerrar/abrir
  seq: 0,   // invalida renders obsoletos al cambiar de página
  ready: false,
  saveTimer: null,
};

async function openReader(book, opts = {}) {
  const token = ++reader.token;
  reader.book = book;
  reader.pdf = null;
  reader.zoom = 1;
  reader.page = 1;
  reader.ready = false;
  reader.preview = !!opts.preview;
  reader.spread = pref("nb_spread", "0") === "1";
  reader.limit = book.pages || 1;
  $("#rd-banner").hidden = true;

  $("#reader").hidden = false;
  document.body.classList.add("noscroll");
  $("#rd-title").textContent = book.title;
  $("#rd-status").textContent = "Cargando…";
  $("#page-canvas").hidden = true;
  updateReaderUI();

  const { data, error } = await sb.storage.from("pdfs").createSignedUrl(book.pdf_path, 3600);
  if (token !== reader.token) return;
  if (error) {
    toast(`No se pudo abrir el PDF: ${error.message}`);
    closeReader({ skipSave: true });
    return;
  }

  try {
    const pdf = await pdfjsLib.getDocument({ url: data.signedUrl }).promise;
    if (token !== reader.token) {
      pdf.destroy();
      return;
    }
    reader.pdf = pdf;
  } catch (err) {
    if (token !== reader.token) return;
    toast(`No se pudo leer el PDF: ${err.message || err}`);
    closeReader({ skipSave: true });
    return;
  }

  const total = reader.pdf.numPages;
  if (reader.preview) {
    // muestra pequeña: ~10 % del libro, entre 3 y 10 páginas
    reader.limit = Math.min(total, clamp(Math.ceil(total * 0.1), 3, 10));
    reader.page = 1;
    $("#rd-banner-text").textContent = `Vista previa: páginas 1 a ${reader.limit} de ${total}`;
    $("#rd-banner").hidden = false;
  } else {
    reader.limit = total;
    bumpCounter(book, "opens");
    const saved = state.progress.get(book.id)?.last_page ?? 1;
    reader.page = clamp(saved, 1, total);
  }
  $("#rd-status").textContent = "";
  $("#page-canvas").hidden = false;
  await renderPage();
}

// Suma 1 a "opens" o "downloads" (falla en silencio: no debe estorbar la lectura).
async function bumpCounter(book, field) {
  try {
    const { error } = await sb.rpc("bump_book_counter", { p_book: book.id, p_field: field });
    if (!error) {
      book[field] = (book[field] || 0) + 1;
      if (field === "opens") book.last_opened_at = new Date().toISOString();
    }
  } catch { /* sin conexión */ }
}

async function renderPage() {
  const { pdf, token } = reader;
  if (!pdf) return;
  const seq = ++reader.seq;
  if (reader.spread && reader.page % 2 === 0) reader.page -= 1; // parejas (1,2), (3,4)…

  if (reader.tasks.length) {
    reader.tasks.forEach((t) => t.cancel());
    await Promise.allSettled(reader.tasks.map((t) => t.promise));
    reader.tasks = [];
  }
  const nums = [reader.page];
  if (reader.spread && reader.page + 1 <= reader.limit) nums.push(reader.page + 1);
  const pages = await Promise.all(nums.map((n) => pdf.getPage(n)));
  if (token !== reader.token || seq !== reader.seq) return;

  const stage = $("#stage");
  const gap = 8;
  const base = pages[0].getViewport({ scale: 1 });
  const byWidth = (stage.clientWidth - 24 - (nums.length > 1 ? gap : 0)) / (base.width * nums.length);
  const byHeight = (stage.clientHeight - 24) / base.height;
  // En dos páginas o pantalla completa se ajusta también al alto para ver la página entera.
  const fitFull = reader.spread || !!document.fullscreenElement || $("#reader").classList.contains("fs");
  const fit = Math.min(fitFull ? Math.min(byWidth, byHeight) : byWidth, 2.5);
  const scale = fit * reader.zoom;
  const dpr = window.devicePixelRatio || 1;
  const canvases = [$("#page-canvas"), $("#page-canvas-2")];
  canvases[1].hidden = nums.length < 2;

  const tasks = pages.map((pg, i) => {
    const viewport = pg.getViewport({ scale: scale * dpr });
    const c = canvases[i];
    c.width = Math.floor(viewport.width);
    c.height = Math.floor(viewport.height);
    c.style.width = `${viewport.width / dpr}px`;
    c.style.height = `${viewport.height / dpr}px`;
    return pg.render({ canvasContext: c.getContext("2d"), viewport });
  });
  reader.tasks = tasks;
  try {
    await Promise.all(tasks.map((t) => t.promise));
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
    return;
  }
  if (token !== reader.token || seq !== reader.seq) return;

  reader.ready = true;
  updateReaderUI();
  scheduleSave();
}

function updateReaderUI() {
  const total = reader.pdf ? reader.limit : 1;
  const stepN = reader.spread ? 2 : 1;
  $("#rd-page").value = reader.page;
  $("#rd-page").max = total;
  $("#rd-total").textContent = `/ ${total}`;
  $("#rd-prev").disabled = reader.page <= 1;
  $("#rd-next").disabled = reader.page + stepN > total;
  $("#rd-spread").classList.toggle("on", reader.spread);
  $("#rd-full").classList.toggle("on", !!document.fullscreenElement || $("#reader").classList.contains("fs"));
  if (reader.preview && reader.page + stepN > total) $("#rd-banner-text").textContent = `Fin de la vista previa (${total} páginas). Para seguir leyendo abre el libro completo.`;
  $("#rd-zoom").textContent = `${Math.round(reader.zoom * 100)}%`;
}

function go(n) {
  if (!reader.pdf) return;
  const target = clamp(Math.round(Number(n)) || 1, 1, reader.limit);
  if (target === reader.page) {
    updateReaderUI();
    return;
  }
  const dir = target > reader.page ? "next" : "prev";
  reader.page = target;
  $("#stage").scrollTop = 0;
  updateReaderUI();
  const cv = $("#pages");
  cv.classList.remove("flip-next", "flip-prev");
  void cv.offsetWidth;
  cv.classList.add(`flip-${dir}`);
  renderPage();
}

function setZoom(z) {
  reader.zoom = clamp(Math.round(z * 100) / 100, 0.5, 3);
  updateReaderUI();
  renderPage();
}

function scheduleSave() {
  if (!reader.book || reader.preview) return;
  clearTimeout(reader.saveTimer);
  const id = reader.book.id;
  const page = reader.page;
  reader.saveTimer = setTimeout(() => saveProgress(id, page), 800);
}

async function saveProgress(bookId, page) {
  if (!state.user) return;
  const row = {
    user_id: state.user.id,
    book_id: bookId,
    last_page: page,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("reading_progress").upsert(row, { onConflict: "user_id,book_id" });
  if (!error) state.progress.set(bookId, row);
}

async function closeReader({ skipSave = false } = {}) {
  if (!reader.book) return;
  clearTimeout(reader.saveTimer);
  const { book, page, ready, preview } = reader;
  reader.token++;
  reader.seq++;
  reader.tasks.forEach((t) => t.cancel());
  reader.pdf?.destroy();
  reader.book = null;
  reader.pdf = null;
  reader.tasks = [];
  reader.ready = false;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  $("#reader").classList.remove("fs");
  $("#rd-banner").hidden = true;

  $("#reader").hidden = true;
  document.body.classList.remove("noscroll");
  if (!skipSave && ready && !preview) await saveProgress(book.id, page);
  render();
}

async function deleteBook(book) {
  const b = book && book.id ? book : reader.book;
  if (!b) return;
  const yes = await askConfirm("Eliminar libro", [el("p", {}, `¿Eliminar «${b.title}»? Esta acción no se puede deshacer.`)], "Eliminar");
  if (!yes) return;
  const { error } = await sb.from("books").delete().eq("id", b.id);
  if (error) {
    toast(`No se pudo eliminar: ${error.message}`);
    return;
  }
  await sb.storage.from("pdfs").remove([b.pdf_path]);
  if (b.cover_path) await sb.storage.from("covers").remove([b.cover_path]);
  if (reader.book?.id === b.id) await closeReader({ skipSave: true });
  $("#detail-modal").hidden = true;
  await refresh();
  toast("Libro eliminado");
}

$("#rd-close").addEventListener("click", () => closeReader());
const stepBy = (dir) => go(reader.page + dir * (reader.spread ? 2 : 1));
$("#rd-prev").addEventListener("click", () => stepBy(-1));
$("#rd-next").addEventListener("click", () => stepBy(1));
$("#rd-page").addEventListener("change", (e) => go(e.target.value));
$("#rd-zoom-in").addEventListener("click", () => setZoom(reader.zoom + 0.25));
$("#rd-zoom-out").addEventListener("click", () => setZoom(reader.zoom - 0.25));
$("#rd-delete").addEventListener("click", () => deleteBook());

const safeName = (t) => t.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "libro";

async function shareBook(b) {
  if (!b) return;
  try {
    const { data, error } = await sb.storage.from("pdfs").createSignedUrl(b.pdf_path, 7 * 24 * 3600);
    if (error) throw error;
    const url = data.signedUrl;
    if (navigator.share) {
      try {
        await navigator.share({ title: b.title, text: `${b.title}${b.author ? " — " + b.author : ""} (enlace válido 7 días)`, url });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(url);
    toast("Enlace copiado. Quien lo tenga puede abrir el PDF durante 7 días.", 7000);
  } catch (err) {
    toast(`No se pudo compartir: ${err?.message || err}`, 7000);
  }
}

async function downloadBook(b) {
  if (!b) return;
  try {
    const { data, error } = await sb.storage.from("pdfs").createSignedUrl(b.pdf_path, 3600, { download: `${safeName(b.title)}.pdf` });
    if (error) throw error;
    const a = el("a", { href: data.signedUrl, download: `${safeName(b.title)}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    bumpCounter(b, "downloads");
    toast("Descargando…");
  } catch (err) {
    toast(`No se pudo descargar: ${err?.message || err}`, 7000);
  }
}

$("#rd-share").addEventListener("click", () => shareBook(reader.book));
$("#rd-download").addEventListener("click", () => downloadBook(reader.book));

/* ---------- Editar libro ---------- */

let editing = null; // libro que se está editando

function openEdit(book) {
  const b = book && book.id ? book : reader.book;
  if (!b) return;
  editing = b;
  $("#ed-public").checked = b.is_public !== false;
  $("#ed-title").value = b.title;
  $("#ed-author").value = b.author || "";
  $("#ed-category").value = b.category || "General";
  $("#ed-tags").value = tagsOf(b).join(", ");
  renderSuggestions($("#ed-tag-sugs"), $("#ed-tags"));
  $("#ed-status").textContent = "";
  renderCategoryChips($("#ed-cat-sugs"), $("#ed-category"));
  $("#edit-modal").hidden = false;
}

function closeEdit() {
  editing = null;
  $("#edit-modal").hidden = true;
}

$("#rd-edit").addEventListener("click", () => openEdit());
$("#ed-cancel").addEventListener("click", closeEdit);
$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = editing;
  if (!b) return;
  const patch = {
    title: $("#ed-title").value.trim(),
    author: $("#ed-author").value.trim() || null,
    category: $("#ed-category").value.trim() || "General",
    is_public: $("#ed-public").checked,
    tags: normTags($("#ed-tags").value),
  };
  const { error } = await sb.from("books").update(patch).eq("id", b.id);
  if (error) {
    $("#ed-status").textContent = `No se pudo guardar: ${error.message}`;
    return;
  }
  Object.assign(b, patch);
  if (reader.book && reader.book.id === b.id) $("#rd-title").textContent = b.title;
  closeEdit();
  render();
  toast("Cambios guardados");
});

document.addEventListener("keydown", (e) => {
  if (!$("#confirm-modal").hidden) {
    if (e.key === "Escape") $("#cf-cancel").click();
    return;
  }
  if (!$("#bm-modal").hidden || !$("#stats-modal").hidden || !$("#detail-modal").hidden) {
    if (e.key === "Escape") { $("#bm-modal").hidden = true; $("#stats-modal").hidden = true; closeDetail(); }
    return;
  }
  if (!$("#legal-modal").hidden) {
    if (e.key === "Escape") $("#legal-modal").hidden = true;
    return;
  }
  if (!$("#contact-modal").hidden || !$("#inbox-modal").hidden || !$("#users-modal").hidden) {
    if (e.key === "Escape") { $("#contact-modal").hidden = true; $("#inbox-modal").hidden = true; $("#users-modal").hidden = true; }
    return;
  }
  if (!$("#confirm-modal").hidden) {
    if (e.key === "Escape") $("#cf-cancel").click();
    return;
  }
  if (!$("#tag-modal").hidden) {
    if (e.key === "Escape") $("#tag-modal").hidden = true;
    return;
  }
  if (!$("#edit-modal").hidden) {
    if (e.key === "Escape") closeEdit();
    return;
  }
  if ($("#reader").hidden) {
    if (e.key === "Escape" && !$("#upload-modal").hidden) closeUpload();
    return;
  }
  if (e.target.tagName === "INPUT") return;
  if (e.key === "Escape") closeReader();
  else if (e.key === "ArrowRight" || e.key === "PageDown") stepBy(1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") stepBy(-1);
});

// Deslizar para cambiar de página (solo con zoom 100%).
let touchX = null;
$("#stage").addEventListener("touchstart", (e) => {
  touchX = e.touches.length === 1 ? e.touches[0].clientX : null;
}, { passive: true });
$("#stage").addEventListener("touchend", (e) => {
  if (touchX === null || reader.zoom > 1) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 70) stepBy(dx < 0 ? 1 : -1);
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => reader.pdf && renderPage(), 250);
});

// Guarda el progreso si se cierra la pestaña.
window.addEventListener("pagehide", () => {
  if (reader.book && reader.ready && !reader.preview) saveProgress(reader.book.id, reader.page);
});

/* ---------- Contacto ---------- */

function openContact() {
  $("#contact-form").reset();
  $("#ct-status").textContent = "";
  $("#ct-send").disabled = false;
  if (state.user && !$("#ct-email").value) $("#ct-email").value = state.user.email || "";
  $("#contact-modal").hidden = false;
}
document.querySelectorAll("#btn-contact, .contact-open").forEach((b) => b.addEventListener("click", openContact));
$("#ct-close").addEventListener("click", () => ($("#contact-modal").hidden = true));

let lastContactAt = 0;
$("#contact-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("#ct-status");
  if ($("#ct-website").value) { // trampa para bots: fingimos éxito
    $("#contact-modal").hidden = true;
    return;
  }
  if (Date.now() - lastContactAt < 30000) {
    st.textContent = "Espera unos segundos antes de enviar otro mensaje.";
    return;
  }
  const row = {
    name: $("#ct-name").value.trim(),
    email: $("#ct-email").value.trim(),
    phone: $("#ct-phone").value.trim() || null,
    message: $("#ct-message").value.trim(),
  };
  $("#ct-send").disabled = true;
  st.classList.add("info");
  st.textContent = "Enviando…";
  const { error } = await sb.from("contact_messages").insert(row);
  if (error) {
    st.classList.remove("info");
    st.textContent = `No se pudo enviar: ${error.message}`;
    $("#ct-send").disabled = false;
    return;
  }
  lastContactAt = Date.now();
  $("#contact-modal").hidden = true;
  toast("¡Mensaje enviado! Gracias por escribirme.", 6000);
});

/* Aviso al admin cuando otra persona sube libros */
async function notifyUpload(count, titles) {
  try {
    const { data, error } = await sb
      .from("notifications")
      .insert({ username: state.profile?.username || state.user?.email || null, count, titles: titles.slice(0, 30) })
      .select("id")
      .single();
    if (error || !data) return;
    sb.functions?.invoke("notify-upload", { body: { notification_id: data.id } }).catch(() => {}); // correo (si está configurado)
  } catch { /* el aviso es opcional */ }
}

/* Bandeja (solo admin) */

let inbox = [];
async function loadInbox() {
  if (state.profile?.role !== "admin") return;
  const [msgs, notes] = await Promise.all([
    sb.from("contact_messages").select("*").order("created_at", { ascending: false }),
    sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  if (msgs.error) return;
  inbox = [
    ...msgs.data.map((m) => ({ ...m, _t: "contact_messages" })),
    ...((notes.data || []).filter((n) => n.user_id !== state.user?.id).map((n) => ({ ...n, _t: "notifications" }))),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const unread = inbox.filter((m) => !m.read).length;
  $("#inbox-count").textContent = unread;
  $("#inbox-count").hidden = !unread;
}

function renderInbox() {
  const list = $("#inbox-list");
  if (!inbox.length) {
    list.replaceChildren(el("p", { class: "muted" }, "Aún no hay mensajes."));
    return;
  }
  list.replaceChildren(
    ...inbox.map((m) => {
      const note = m._t === "notifications";
      return el(
        "div",
        { class: "msg-item" + (m.read ? "" : " unread") },
        el("strong", {}, note ? `📚 ${m.username || "Alguien"} subió ${m.count} libro(s)` : m.name),
        el("span", { class: "meta" }, `${note ? "Novedad" : m.email + (m.phone ? " · " + m.phone : "")} · ${new Date(m.created_at).toLocaleString("es-CL")}`),
        el("p", {}, note ? m.titles.slice(0, 8).join(" · ") + (m.count > 8 ? ` … y ${m.count - 8} más` : "") : m.message),
        el(
          "div",
          { class: "row-actions" },
          note ? null : el("a", { class: "btn ghost small", href: `mailto:${m.email}?subject=${encodeURIComponent("Re: tu mensaje en Netbook")}` }, "Responder"),
          el("button", { class: "btn ghost small", type: "button", onclick: async () => {
            await sb.from(m._t).update({ read: !m.read }).eq("id", m.id);
            await loadInbox();
            renderInbox();
          } }, m.read ? "Marcar sin leer" : "Marcar leído"),
          el("button", { class: "btn ghost small", type: "button", onclick: async () => {
            if (!(await askConfirm("Eliminar mensaje", [el("p", {}, `¿Eliminar este aviso${m.name ? " de " + m.name : ""}?`)], "Eliminar"))) return;
            await sb.from(m._t).delete().eq("id", m.id);
            await loadInbox();
            renderInbox();
          } }, "Eliminar")
        )
      );
    })
  );
}

let lastUnread = null;
async function pollInbox() {
  if (state.profile?.role !== "admin") return;
  await loadInbox();
  const unread = inbox.filter((m) => !m.read).length;
  if (lastUnread !== null && unread > lastUnread) toast(`📨 Tienes ${unread - lastUnread} aviso(s) nuevo(s)`, 7000);
  else if (lastUnread === null && unread) toast(`📨 Tienes ${unread} aviso(s) sin leer`, 7000);
  lastUnread = unread;
}
setInterval(pollInbox, 120000);
setTimeout(pollInbox, 2500);

$("#btn-inbox").addEventListener("click", async () => {
  await loadInbox();
  renderInbox();
  $("#inbox-modal").hidden = false;
});
$("#inbox-close").addEventListener("click", () => ($("#inbox-modal").hidden = true));

/* ---------- Perfil y usuarios ---------- */

let askedProfile = false;
function maybeAskProfile() {
  const p = state.profile;
  if (!p || askedProfile || (p.full_name && p.rut && p.consent_at)) return;
  askedProfile = true;
  $("#pf-name").value = p.full_name || "";
  $("#pf-rut").value = p.rut ? formatRut(p.rut) : "";
  $("#pf-consent").checked = false;
  $("#pf-status").textContent = "";
  $("#profile-modal").hidden = false;
}
$("#pf-later").addEventListener("click", () => ($("#profile-modal").hidden = true));
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("#pf-status");
  if (!validRut($("#pf-rut").value)) { st.textContent = "El RUT no es válido."; return; }
  const patch = { full_name: $("#pf-name").value.trim(), rut: formatRut($("#pf-rut").value), consent_at: new Date().toISOString() };
  const { error } = await sb.from("profiles").update(patch).eq("id", state.user.id);
  if (error) { st.textContent = /duplicate|unique/i.test(error.message) ? "Ese RUT ya está registrado." : `No se pudo guardar: ${error.message}`; return; }
  Object.assign(state.profile, patch);
  $("#profile-modal").hidden = true;
  toast("Perfil actualizado");
});

$("#btn-users").addEventListener("click", async () => {
  const { data, error } = await sb.rpc("admin_users");
  const list = $("#users-list");
  if (error) {
    list.replaceChildren(el("p", { class: "msg" }, error.message));
  } else {
    list.replaceChildren(
      ...data.map((u) => {
        const rutSpan = el("span", {}, maskRut(u.rut));
        return el(
          "div",
          { class: "msg-item" },
          el("strong", {}, `${u.full_name || u.username || u.email}${u.role === "admin" ? " · Admin" : ""}`),
          el("span", { class: "meta" }, `${u.email} · ${u.books} libro(s) · desde ${new Date(u.created_at).toLocaleDateString("es-CL")}`),
          el("span", { class: "meta" }, "RUT: ", rutSpan, " ",
            u.rut ? el("button", { class: "linklike", type: "button", onclick: (ev) => {
              const shown = rutSpan.dataset.shown === "1";
              rutSpan.textContent = shown ? maskRut(u.rut) : formatRut(u.rut);
              rutSpan.dataset.shown = shown ? "0" : "1";
              ev.currentTarget.textContent = shown ? "ver" : "ocultar";
            } }, "ver") : null),
          el("span", { class: "meta" }, u.consent_at ? `Aceptó términos el ${new Date(u.consent_at).toLocaleDateString("es-CL")}` : "Sin aceptación de términos")
        );
      })
    );
  }
  $("#users-modal").hidden = false;
});
$("#users-close").addEventListener("click", () => ($("#users-modal").hidden = true));

/* ---------- Tema, orden y vista ---------- */

$("#btn-theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  setPref("nb_theme", next);
});
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  setPref("nb_sort", state.sort);
  render();
});
$("#btn-view").addEventListener("click", () => {
  state.view = state.view === "list" ? "grid" : "list";
  setPref("nb_view", state.view);
  render();
});

/* ---------- Detalle del libro y favoritos ---------- */

let detailBook = null;

function renderDetail() {
  const b = detailBook;
  if (!b) return;
  const cover = state.covers.get(b.id);
  const img = $("#dt-cover");
  if (cover) img.src = cover;
  else img.removeAttribute("src");
  img.hidden = !cover;
  $("#dt-title").textContent = b.title;
  $("#dt-author").textContent = b.author || "Autor sin indicar";
  const bits = [b.category, b.pages ? `${b.pages} páginas` : null, b.size_bytes ? fmtMB(b.size_bytes) : null,
    (b.opens || 0) ? `${b.opens} lectura(s)` : null, (b.downloads || 0) ? `${b.downloads} descarga(s)` : null].filter(Boolean);
  $("#dt-meta").textContent = bits.join(" · ");
  $("#dt-tags").replaceChildren(...tagsOf(b).map((t) => el("span", { class: "chip small" }, t)));
  const p = state.progress.get(b.id);
  const pct = p && b.pages ? clamp(Math.round((p.last_page / b.pages) * 100), 0, 100) : 0;
  $("#dt-progress").hidden = pct === 0;
  $("#dt-progress i").style.width = `${pct}%`;
  $("#dt-progress-text").textContent = pct ? `Vas en la página ${p.last_page} de ${b.pages} (${pct}%)` : "Aún no lo empiezas.";
  $("#dt-read").textContent = pct > 0 && pct < 100 ? "▶ Continuar" : "▶ Leer";
  $("#dt-fav").textContent = b.favorite ? "♥ En favoritos" : "♡ Favorito";
  $("#dt-fav").classList.toggle("on", !!b.favorite);
  $("#dt-edit").hidden = !canEdit(b);
  $("#dt-delete").hidden = !canEdit(b);
  if (b.user_id === state.user?.id) $("#dt-meta").textContent += ` · ${b.is_public === false ? "🔒 Privado" : "🌐 Compartido"}`;
}

function openDetail(b) {
  detailBook = b;
  renderDetail();
  $("#detail-modal").hidden = false;
}
function closeDetail() {
  $("#detail-modal").hidden = true;
  detailBook = null;
}

async function toggleFavorite(b) {
  const next = !b.favorite;
  const { error } = next
    ? await sb.from("favorites").insert({ book_id: b.id })
    : await sb.from("favorites").delete().eq("book_id", b.id);
  if (error) {
    toast(`No se pudo guardar el favorito: ${error.message}`);
    return;
  }
  b.favorite = next;
  renderDetail();
  render();
}

$("#dt-close").addEventListener("click", closeDetail);
$("#dt-read").addEventListener("click", () => {
  const b = detailBook;
  closeDetail();
  if (b) openReader(b);
});
$("#dt-fav").addEventListener("click", () => detailBook && toggleFavorite(detailBook));
$("#dt-share").addEventListener("click", () => shareBook(detailBook));
$("#dt-download").addEventListener("click", () => downloadBook(detailBook));
$("#dt-edit").addEventListener("click", () => {
  const b = detailBook;
  closeDetail();
  if (b) openEdit(b);
});
$("#dt-delete").addEventListener("click", () => detailBook && deleteBook(detailBook));

/* ---------- Lector: modos, marcadores y gestos ---------- */

const MODES = ["normal", "sepia", "night"];
const MODE_NAMES = { normal: "Normal", sepia: "Sepia", night: "Noche" };
function applyReaderMode(m) {
  const box = $("#reader");
  MODES.forEach((x) => box.classList.toggle(`mode-${x}`, x === m));
  box.dataset.mode = m;
}
applyReaderMode(pref("nb_rmode", "normal"));
$("#rd-mode").addEventListener("click", () => {
  const next = MODES[(MODES.indexOf($("#reader").dataset.mode) + 1) % MODES.length];
  applyReaderMode(next);
  setPref("nb_rmode", next);
  toast(`Modo ${MODE_NAMES[next]}`, 1500);
});

// Un toque sobre la página oculta o muestra la barra (lectura sin distracciones).
$("#pages").addEventListener("click", () => $("#reader").classList.toggle("immersive"));

let bookmarks = [];
async function loadBookmarks() {
  const b = reader.book;
  if (!b) return;
  const { data, error } = await sb.from("bookmarks").select("*").eq("book_id", b.id).order("page");
  bookmarks = error ? [] : data;
}
function renderBookmarks() {
  $("#bm-page").textContent = `(pág. ${reader.page})`;
  const list = $("#bm-list");
  if (!bookmarks.length) {
    list.replaceChildren(el("p", { class: "muted" }, "Aún no hay marcadores en este libro."));
    return;
  }
  list.replaceChildren(
    ...bookmarks.map((m) =>
      el(
        "div",
        { class: "msg-item" },
        el("strong", {}, `Página ${m.page}`),
        m.note ? el("p", {}, m.note) : null,
        el(
          "div",
          { class: "row-actions" },
          el("button", { class: "btn ghost small", type: "button", onclick: () => { $("#bm-modal").hidden = true; go(m.page); } }, "Ir a la página"),
          el("button", { class: "btn ghost small", type: "button", onclick: async () => {
            await sb.from("bookmarks").delete().eq("id", m.id);
            await loadBookmarks();
            renderBookmarks();
          } }, "Eliminar")
        )
      )
    )
  );
}
$("#rd-bm").addEventListener("click", async () => {
  if (!reader.book) return;
  $("#bm-note").value = "";
  await loadBookmarks();
  renderBookmarks();
  $("#bm-modal").hidden = false;
});
$("#bm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = reader.book;
  if (!b) return;
  const { error } = await sb.from("bookmarks").insert({ book_id: b.id, page: reader.page, note: $("#bm-note").value.trim() || null });
  if (error) {
    toast(`No se pudo guardar el marcador: ${error.message}`);
    return;
  }
  $("#bm-note").value = "";
  await loadBookmarks();
  renderBookmarks();
  toast("Marcador guardado", 2000);
});
$("#bm-close").addEventListener("click", () => ($("#bm-modal").hidden = true));

// Dos páginas
$("#rd-spread").addEventListener("click", () => {
  reader.spread = !reader.spread;
  setPref("nb_spread", reader.spread ? "1" : "0");
  updateReaderUI();
  renderPage();
  toast(reader.spread ? "Dos páginas (gira el celular para verlas mejor)" : "Una página", 2500);
});

// Pantalla completa (si el navegador no la permite, oculta las barras)
$("#rd-full").addEventListener("click", async () => {
  const box = $("#reader");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (box.requestFullscreen) await box.requestFullscreen();
    else throw new Error("sin API");
  } catch {
    box.classList.toggle("fs");
    box.classList.toggle("immersive", box.classList.contains("fs"));
  }
  updateReaderUI();
  setTimeout(() => reader.pdf && renderPage(), 150);
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) $("#reader").classList.remove("immersive");
  else $("#reader").classList.add("immersive");
  updateReaderUI();
  setTimeout(() => reader.pdf && renderPage(), 150);
});

// Vista previa
$("#dt-preview").addEventListener("click", () => {
  const b = detailBook;
  closeDetail();
  if (b) openReader(b, { preview: true });
});
$("#rd-full-read").addEventListener("click", () => {
  const b = reader.book;
  if (b) openReader(b);
});

/* ---------- Estadísticas y exportación ---------- */

function barList(entries, total) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return el(
    "div",
    { class: "bars" },
    entries.map(([name, n]) =>
      el("div", { class: "bar-row" }, el("span", { class: "bn" }, name), el("span", { class: "bt" }, el("i", { style: `width:${Math.round((n / max) * 100)}%` })), el("span", { class: "bv" }, String(n)))
    )
  );
}
const countBy = (list, fn) => {
  const m = new Map();
  for (const b of list) for (const k of [].concat(fn(b))) if (k) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
};

async function openStats() {
  const bs = state.books;
  const bytes = bs.reduce((a, b) => a + (b.size_bytes || 0), 0);
  const pages = bs.reduce((a, b) => a + (b.pages || 0), 0);
  const read = bs.reduce((a, b) => a + (b.opens || 0), 0);
  const GB = 1024 * 1024 * 1024;
  const pctUsed = Math.min(100, (bytes / GB) * 100);
  const card = (n, label) => el("div", { class: "stat-card" }, el("strong", {}, String(n)), el("span", { class: "muted" }, label));
  const top = [...bs].filter((b) => b.opens > 0).sort((a, b) => b.opens - a.opens).slice(0, 5);
  $("#stats-body").replaceChildren(
    el("div", { class: "stat-cards" }, card(bs.length, "libros"), card(pages.toLocaleString("es-CL"), "páginas"), card(bs.filter((b) => b.favorite).length, "favoritos"), card(read, "lecturas")),
    el("p", { class: "muted small-text" }, `Almacenamiento: ${fmtMB(bytes)} de 1 GB (${pctUsed.toFixed(0)}%)`),
    el("div", { class: "meter" }, el("i", { style: `width:${pctUsed}%` })),
    el("h3", {}, "Por etiqueta"), barList(allTags().slice(0, 8)),
    el("h3", {}, "Por categoría"), barList(countBy(bs, (b) => b.category)),
    top.length ? el("h3", {}, "Más leídos") : null,
    top.length ? barList(top.map((b) => [b.title, b.opens])) : null,
    el("h3", {}, "Agregados recientemente"),
    el("ul", { class: "recent" }, ...bs.slice(0, 6).map((b) => el("li", {}, el("span", {}, b.title), el("span", { class: "muted" }, ago(b.created_at)))))
  );
  $("#stats-modal").hidden = false;
  if (state.profile?.role === "admin") {
    const { data } = await sb.rpc("admin_users");
    const who = (data || []).filter((u) => u.books > 0).sort((a, b) => b.books - a.books).map((u) => [u.username || u.full_name || u.email, Number(u.books)]);
    if (who.length) $("#stats-body").append(el("h3", {}, "Aportes por colaborador"), barList(who));
  }
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$("#btn-stats").addEventListener("click", openStats);
$("#st-close").addEventListener("click", () => ($("#stats-modal").hidden = true));
$("#st-csv").addEventListener("click", () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["titulo", "autor", "categoria", "etiquetas", "paginas", "tamano_mb", "favorito", "lecturas", "descargas", "agregado"];
  const rows = state.books.map((b) => [b.title, b.author, b.category, tagsOf(b).join("; "), b.pages, b.size_bytes ? (b.size_bytes / 1048576).toFixed(2) : "", b.favorite ? "si" : "no", b.opens || 0, b.downloads || 0, b.created_at]);
  saveFile("netbook-biblioteca.csv", "﻿" + [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  toast("Lista descargada (CSV)");
});
$("#st-json").addEventListener("click", async () => {
  const { data: marks } = await sb.from("bookmarks").select("*");
  const backup = { app: "Netbook", exported_at: new Date().toISOString(), books: state.books, bookmarks: marks || [], progress: [...state.progress.values()] };
  saveFile("netbook-respaldo.json", JSON.stringify(backup, null, 2), "application/json");
  toast("Respaldo de datos descargado (los PDFs no se incluyen)", 6000);
});

/* ---------- Compartir e instalar la app ---------- */

const APP_URL = location.origin + location.pathname;
let installEvent = null;
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
});
window.addEventListener("appinstalled", () => {
  installEvent = null;
  document.querySelectorAll(".app-install").forEach((b) => (b.hidden = true));
  toast("¡Netbook instalada!");
});
if (isStandalone()) document.querySelectorAll(".app-install").forEach((b) => (b.hidden = true));

document.querySelectorAll(".app-share").forEach((b) =>
  b.addEventListener("click", async () => {
    const data = { title: "Netbook", text: "Biblioteca digital abierta para leer, compartir y descargar libros", url: APP_URL };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(APP_URL);
      toast("Link de la app copiado. ¡Pégalo donde quieras compartirlo!", 5000);
    } catch {
      toast(APP_URL, 9000);
    }
  })
);

document.querySelectorAll(".app-install").forEach((b) =>
  b.addEventListener("click", async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice.catch(() => {});
      installEvent = null;
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    await askConfirm(
      "Instalar Netbook",
      ios
        ? [el("p", {}, "En iPhone o iPad (con Safari):"), el("ol", { class: "cf-list" }, [el("li", {}, "Toca el botón Compartir (el cuadrado con la flecha)."), el("li", {}, "Elige «Agregar a inicio»."), el("li", {}, "Toca «Agregar».")])]
        : [el("p", {}, "En Android (Chrome):"), el("ol", { class: "cf-list" }, [el("li", {}, "Toca el menú ⋮ arriba a la derecha."), el("li", {}, "Elige «Instalar app» o «Agregar a la pantalla de inicio»."), el("li", {}, "Confirma con «Instalar».")]), el("p", { class: "muted" }, "Si no aparece la opción, abre este link directamente en Chrome.")],
      "Entendido"
    );
  })
);

/* ---------- App instalable ---------- */

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ---------- Arranque ---------- */

(async function boot() {
  const { data } = await sb.auth.getSession();
  setSession(data.session);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") $("#reset-modal").hidden = false;
    setSession(session);
  });
})();
