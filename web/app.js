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
};

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
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/* ---------- Autenticación ---------- */

async function doAuth(mode) {
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const msg = $("#auth-msg");
  msg.textContent = "";
  if (!email || password.length < 6) {
    msg.textContent = "Ingresa un correo y una contraseña de al menos 6 caracteres.";
    return;
  }
  const { data, error } =
    mode === "signup"
      ? await sb.auth.signUp({ email, password, options: { data: { username: $("#username").value.trim() } } })
      : await sb.auth.signInWithPassword({ email, password });
  if (error) {
    msg.textContent = error.message;
    return;
  }
  if (mode === "signup" && !data.session) {
    msg.textContent = "Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.";
  }
}

function setSession(session) {
  const prevId = state.user?.id;
  state.user = session?.user ?? null;
  $("#auth").hidden = !!state.user;
  $("#app").hidden = !state.user;
  if (state.user && state.user.id !== prevId) {
    refresh();
  } else if (!state.user) {
    state.profile = null;
    renderBadge();
    state.books = [];
    state.progress.clear();
    state.covers.clear();
    render();
  }
}

$("#auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  doAuth("signin");
});
$("#btn-signup").addEventListener("click", () => doAuth("signup"));
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
  const { data, error } = await sb.from("profiles").select("username,role").eq("id", state.user.id).maybeSingle();
  state.profile = error ? null : data;
  renderBadge();
}

async function refresh() {
  loadProfile();
  const [booksRes, progRes] = await Promise.all([
    sb.from("books").select("*").order("created_at", { ascending: false }),
    sb.from("reading_progress").select("book_id,last_page,updated_at"),
  ]);
  const err = booksRes.error || progRes.error;
  if (err) {
    toast(`No se pudo cargar la biblioteca: ${err.message}`);
    return;
  }
  state.books = booksRes.data;
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

function cardEl(b) {
  const cover = state.covers.get(b.id);
  const p = state.progress.get(b.id);
  const pct = p && b.pages ? clamp(Math.round((p.last_page / b.pages) * 100), 0, 100) : 0;
  return el(
    "button",
    { class: "card", type: "button", title: b.title, onclick: () => openReader(b) },
    cover ? el("img", { src: cover, alt: "", loading: "lazy" }) : el("div", { class: "ph" }, b.title),
    el("div", { class: "card-info" }, el("strong", {}, b.title), el("span", {}, b.author || b.category)),
    pct > 0 ? el("div", { class: "bar" }, el("i", { style: `width:${pct}%` })) : null
  );
}

function rowEl(title, books, grid = false) {
  const section = el("section", { class: "row" }, el("h2", {}, title));
  if (grid && !books.length) {
    section.append(el("p", { class: "muted" }, "Sin resultados."));
    return section;
  }
  const strip = el("div", { class: grid ? "strip grid" : "strip" }, books.map(cardEl));
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
  if (!book || state.query.trim()) {
    hero.hidden = true;
    return;
  }
  hero.hidden = false;
  const cover = state.covers.get(book.id);
  const img = $("#hero-img");
  if (cover) img.src = cover;
  else img.removeAttribute("src");
  img.hidden = !cover;
  $("#hero-kicker").textContent = resuming[0] ? "Continuar leyendo" : "Agregado recientemente";
  $("#hero-title").textContent = book.title;
  $("#hero-author").textContent = book.author || book.category;
  $("#hero-btn").textContent = resuming[0] ? "▶ Continuar" : "▶ Leer";
  $("#hero-btn").onclick = () => openReader(book);
}

function render() {
  const rows = $("#rows");
  rows.replaceChildren();
  const hasBooks = state.books.length > 0;
  $("#empty").hidden = hasBooks || !state.user;
  if (!hasBooks) {
    $("#hero").hidden = true;
    return;
  }

  const q = state.query.trim().toLowerCase();
  const resuming = continueReading();
  renderHero(resuming);

  if (q) {
    const hits = state.books.filter((b) =>
      [b.title, b.author, b.category].some((v) => (v || "").toLowerCase().includes(q))
    );
    rows.append(rowEl(`Resultados para "${state.query.trim()}"`, hits, true));
    return;
  }

  if (resuming.length) rows.append(rowEl("Continuar leyendo", resuming));
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

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});

/* ---------- Subida ---------- */

function openUpload() {
  $("#upload-form").reset();
  $("#up-category").value = "General";
  $("#up-status").textContent = "";
  $("#up-submit").disabled = false;
  const cats = [...new Set(state.books.map((b) => b.category).filter(Boolean))].sort();
  $("#category-list").replaceChildren(...cats.map((c) => el("option", { value: c })));
  $("#upload-modal").hidden = false;
}

function closeUpload() {
  $("#upload-modal").hidden = true;
}

$("#btn-upload").addEventListener("click", openUpload);
$("#btn-upload-empty").addEventListener("click", openUpload);
$("#up-cancel").addEventListener("click", closeUpload);

$("#up-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f && !$("#up-title").value) {
    $("#up-title").value = f.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
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

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#up-file").files[0];
  const status = $("#up-status");
  const submit = $("#up-submit");
  if (!file) return;

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    status.textContent = "El archivo debe ser un PDF.";
    return;
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    status.textContent = `El archivo supera ${MAX_MB} MB (límite del plan gratuito de Supabase).`;
    return;
  }

  submit.disabled = true;
  status.textContent = "Procesando PDF…";
  const id = crypto.randomUUID();
  const uid = state.user.id;
  const pdfPath = `${uid}/${id}.pdf`;
  const coverPath = `${uid}/${id}.jpg`;
  let pdfUploaded = false;
  let coverUploaded = false;

  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = pdf.numPages;
    const coverBlob = await renderCover(pdf);
    pdf.destroy();

    status.textContent = "Subiendo archivo…";
    const up1 = await sb.storage.from("pdfs").upload(pdfPath, file, { contentType: "application/pdf" });
    if (up1.error) throw up1.error;
    pdfUploaded = true;

    const up2 = await sb.storage.from("covers").upload(coverPath, coverBlob, { contentType: "image/jpeg" });
    if (up2.error) throw up2.error;
    coverUploaded = true;

    const { error } = await sb.from("books").insert({
      id,
      title: $("#up-title").value.trim(),
      author: $("#up-author").value.trim() || null,
      category: $("#up-category").value.trim() || "General",
      pages,
      pdf_path: pdfPath,
      cover_path: coverPath,
    });
    if (error) throw error;

    closeUpload();
    toast("Libro agregado");
    await refresh();
  } catch (err) {
    // Limpia archivos huérfanos si algo falló a medio camino.
    if (pdfUploaded) await sb.storage.from("pdfs").remove([pdfPath]);
    if (coverUploaded) await sb.storage.from("covers").remove([coverPath]);
    status.textContent = `No se pudo subir: ${err.message || err}`;
    submit.disabled = false;
  }
});

/* ---------- Lector ---------- */

const reader = {
  book: null,
  pdf: null,
  page: 1,
  zoom: 1,
  task: null,
  token: 0, // invalida cargas obsoletas al cerrar/abrir
  seq: 0,   // invalida renders obsoletos al cambiar de página
  ready: false,
  saveTimer: null,
};

async function openReader(book) {
  const token = ++reader.token;
  reader.book = book;
  reader.pdf = null;
  reader.zoom = 1;
  reader.page = 1;
  reader.ready = false;

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

  const saved = state.progress.get(book.id)?.last_page ?? 1;
  reader.page = clamp(saved, 1, reader.pdf.numPages);
  $("#rd-status").textContent = "";
  $("#page-canvas").hidden = false;
  await renderPage();
}

async function renderPage() {
  const { pdf, token } = reader;
  if (!pdf) return;
  const seq = ++reader.seq;

  if (reader.task) {
    reader.task.cancel();
    try { await reader.task.promise; } catch { /* cancelado */ }
    reader.task = null;
  }
  const page = await pdf.getPage(reader.page);
  if (token !== reader.token || seq !== reader.seq) return;

  const stage = $("#stage");
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min((stage.clientWidth - 24) / base.width, 2);
  const scale = fit * reader.zoom;
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: scale * dpr });

  const canvas = $("#page-canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;

  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  reader.task = task;
  try {
    await task.promise;
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
  const total = reader.pdf?.numPages ?? 1;
  $("#rd-page").value = reader.page;
  $("#rd-page").max = total;
  $("#rd-total").textContent = `/ ${total}`;
  $("#rd-prev").disabled = reader.page <= 1;
  $("#rd-next").disabled = reader.page >= total;
  $("#rd-zoom").textContent = `${Math.round(reader.zoom * 100)}%`;
}

function go(n) {
  if (!reader.pdf) return;
  const target = clamp(Math.round(Number(n)) || 1, 1, reader.pdf.numPages);
  if (target === reader.page) {
    updateReaderUI();
    return;
  }
  reader.page = target;
  $("#stage").scrollTop = 0;
  updateReaderUI();
  renderPage();
}

function setZoom(z) {
  reader.zoom = clamp(Math.round(z * 100) / 100, 0.5, 3);
  updateReaderUI();
  renderPage();
}

function scheduleSave() {
  if (!reader.book) return;
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
  const { book, page, ready } = reader;
  reader.token++;
  reader.seq++;
  reader.task?.cancel();
  reader.pdf?.destroy();
  reader.book = null;
  reader.pdf = null;
  reader.task = null;
  reader.ready = false;

  $("#reader").hidden = true;
  document.body.classList.remove("noscroll");
  if (!skipSave && ready) await saveProgress(book.id, page);
  render();
}

async function deleteBook() {
  const b = reader.book;
  if (!b) return;
  if (!confirm(`¿Eliminar "${b.title}"? Esta acción no se puede deshacer.`)) return;
  const { error } = await sb.from("books").delete().eq("id", b.id);
  if (error) {
    toast(`No se pudo eliminar: ${error.message}`);
    return;
  }
  await sb.storage.from("pdfs").remove([b.pdf_path]);
  if (b.cover_path) await sb.storage.from("covers").remove([b.cover_path]);
  await closeReader({ skipSave: true });
  await refresh();
  toast("Libro eliminado");
}

$("#rd-close").addEventListener("click", () => closeReader());
$("#rd-prev").addEventListener("click", () => go(reader.page - 1));
$("#rd-next").addEventListener("click", () => go(reader.page + 1));
$("#rd-page").addEventListener("change", (e) => go(e.target.value));
$("#rd-zoom-in").addEventListener("click", () => setZoom(reader.zoom + 0.25));
$("#rd-zoom-out").addEventListener("click", () => setZoom(reader.zoom - 0.25));
$("#rd-delete").addEventListener("click", deleteBook);

document.addEventListener("keydown", (e) => {
  if ($("#reader").hidden) {
    if (e.key === "Escape" && !$("#upload-modal").hidden) closeUpload();
    return;
  }
  if (e.target.tagName === "INPUT") return;
  if (e.key === "Escape") closeReader();
  else if (e.key === "ArrowRight" || e.key === "PageDown") go(reader.page + 1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") go(reader.page - 1);
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
  if (Math.abs(dx) > 70) go(reader.page + (dx < 0 ? 1 : -1));
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => reader.pdf && renderPage(), 250);
});

// Guarda el progreso si se cierra la pestaña.
window.addEventListener("pagehide", () => {
  if (reader.book && reader.ready) saveProgress(reader.book.id, reader.page);
});

/* ---------- Arranque ---------- */

(async function boot() {
  const { data } = await sb.auth.getSession();
  setSession(data.session);
  sb.auth.onAuthStateChange((_event, session) => setSession(session));
})();
