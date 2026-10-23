// Detecta título y autor de un PDF:
//   1) metadatos del PDF (si son válidos)  2) texto de la portada (fuente más grande = título)
//   3) nombre del archivo limpiado (quita números de ID, prefijos, "z-lib", etc.)
// Funciona en el navegador (window.NetbookMeta) y en Node (module.exports) para poder probarlo.
(function (root) {
  "use strict";

  /* ---------- Limpieza de texto ---------- */

  const SMALL_WORDS = new Set([
    "de", "del", "la", "las", "el", "los", "y", "e", "en", "a", "un", "una", "por", "para", "con", "o", "u", "al",
    "of", "the", "and", "in", "on", "to", "for", "an",
  ]);

  function toTitleCase(s) {
    return s
      .toLowerCase()
      .split(" ")
      .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }

  // Si todo viene en MAYÚSCULAS lo pasa a formato título.
  function fixCaps(s) {
    return s.length > 3 && /\p{L}/u.test(s) && s === s.toUpperCase() ? toTitleCase(s) : s;
  }

  const tidy = (s) => s.replace(/\s+/g, " ").replace(/^[\s\-–—_.:,;|]+|[\s\-–—_.:,;|]+$/g, "").trim();

  function cleanFilename(name) {
    const original = String(name || "").replace(/\.pdf$/i, "").trim();
    let s = original;
    // Primero los nombres de sitios (llevan puntos), luego el resto.
    s = s.replace(/[(\[]?\s*z-?lib(rary)?(\.org)?\s*[)\]]?/gi, " ");
    s = s.replace(/[(\[]?\s*libgen[\w.\-]*\s*[)\]]?/gi, " ");
    s = s.replace(/oceanofpdf(\.com)?/gi, " ");
    s = s.replace(/[_]+/g, " ");
    s = s.replace(/\.(?=\S)/g, " "); // puntos entre palabras
    s = s.replace(/\(\d{1,2}\)\s*$/g, " "); // "(1)" de copias descargadas
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " "); // uuid
    s = s.replace(/\b\d{7,}\b/g, " "); // ISBN, fechas largas, ids
    s = s.replace(/^\s*(\d{1,3}|0\d+|\d{5,})[\s\-–.)]+(?=\D)/, ""); // "01 - ", "12. ", "0045 - ", "00123_"
    s = s.replace(/[\s\-–]+\d{5,}\s*$/g, ""); // id numérico al final
    s = tidy(s);
    if (!/\p{L}/u.test(s)) return tidy(original.replace(/_/g, " ")) || original || "Sin título";
    return fixCaps(s);
  }

  /* ---------- Metadatos del PDF ---------- */

  const JUNK_AUTHOR = /^(admin(istrator)?|user|usuario|unknown|desconocido|owner|pc|windows user|microsoft|adobe|acrobat|calibre|libgen|scribd|anonymous|an[oó]nimo|default|author|autor|yo|me|null|undefined)$/i;
  const JUNK_TITLE = /^(untitled|sin t[ií]tulo|documento?\s*\d*|microsoft\s+(word|powerpoint|excel)\b.*|slide\s*\d+|presentation\s*\d*|portada|cover|capa|scan(ned)?\b.*|new document|doc\d*|libro\s*\d*|book\s*\d*|layout\s*\d*|page\s*\d+|cap[ií]tulo\s*\d+|null|undefined)$/i;
  const LOOKS_LIKE_FILE = /\.(docx?|pdf|indd|qxd|tex|odt|rtf|pptx?|xlsx?|txt|psd|ai)\s*$/i;

  function cleanMetaText(v) {
    if (typeof v !== "string") return null;
    const s = tidy(v.replace(/[\u0000-\u001f]/g, " "));
    return s.length ? s : null;
  }

  function validTitle(t) {
    return t.length >= 3 && t.length <= 200 && /\p{L}/u.test(t) && !JUNK_TITLE.test(t) && !LOOKS_LIKE_FILE.test(t);
  }

  function validAuthor(a) {
    return a.length >= 3 && a.length <= 120 && /\p{L}/u.test(a) && !JUNK_AUTHOR.test(a) && !LOOKS_LIKE_FILE.test(a);
  }

  /* ---------- Texto de la portada ---------- */

  const HARD_NOISE = /(https?:\/\/|www\.|\.(com|org|net|info)\b|isbn|issn|©|\bcopyright\b|todos los derechos|all rights reserved|z-?lib|libgen|oceanofpdf)/i;
  const SOFT_WORDS = new Set([
    "editorial", "ediciones", "edicion", "edición", "publishing", "publishers", "press", "traduccion", "traducción",
    "traducido", "prologo", "prólogo", "coleccion", "colección", "volumen", "vol", "tomo", "novela", "bestseller",
    "premio", "nobel", "grupo", "libros", "books", "biblioteca", "universidad", "university", "capitulo", "capítulo",
    "chapter", "contenido", "contents", "indice", "índice", "presenta", "presents", "edition",
  ]);
  const NAME_TOKEN = /^(\p{Lu}[\p{L}'’.\-]*|de|del|la|las|los|van|von|der|den|da|das|do|dos|di|du|le|y|e|and|&)$/u;

  const tokensOf = (s) => s.toLowerCase().replace(/[.,;:()]/g, " ").split(/\s+/).filter(Boolean);
  const hasSoftWord = (s) => tokensOf(s).some((t) => SOFT_WORDS.has(t));

  function looksLikeName(text) {
    const t = text.replace(/^(por|by|de|autor|author|escrito por|written by)\s*[:.\-]?\s+/i, "");
    if (/\d/.test(t) || t.length > 60) return null;
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 7) return null;
    if (!tokens.every((tok) => NAME_TOKEN.test(tok))) return null;
    const caps = tokens.filter((tok) => /^\p{Lu}/u.test(tok)).length;
    if (caps < 2 || hasSoftWord(t)) return null;
    return fixCaps(tidy(t));
  }

  async function pageLines(page) {
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((i) => typeof i.str === "string" && i.str.trim() !== "")
      .map((i) => ({
        str: i.str,
        x: i.transform[4],
        y: i.transform[5],
        size: Math.hypot(i.transform[0], i.transform[1]) || i.height || 0,
      }));
    if (!items.length) return [];
    items.sort((a, b) => b.y - a.y || a.x - b.x); // de arriba hacia abajo
    const rows = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(last.size, it.size) * 0.4) {
        last.parts.push(it);
        last.size = Math.max(last.size, it.size);
      } else {
        rows.push({ y: it.y, size: it.size, parts: [it] });
      }
    }
    return rows.map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      return { text: tidy(r.parts.map((p) => p.str).join(" ")), size: r.size, y: r.y };
    });
  }

  // Devuelve { title, author } si la página parece una portada; null si parece texto corrido u otra cosa.
  function pickTitleAuthor(lines) {
    const usable = lines.filter(
      (l) => l.text.length >= 2 && l.size > 0 && /\p{L}/u.test(l.text) && !/^\d+$/.test(l.text) && !HARD_NOISE.test(l.text)
    );
    if (!usable.length || usable.length > 18) return null;

    const sizes = usable.map((l) => l.size);
    const maxSize = Math.max(...sizes);
    const minSize = Math.min(...sizes);
    if (usable.length > 6 && maxSize / minSize < 1.15) return null; // todo del mismo tamaño: texto corrido

    const threshold = maxSize * 0.85;
    const start = usable.findIndex((l) => l.size >= threshold);
    let end = start;
    while (
      end + 1 < usable.length &&
      usable[end + 1].size >= threshold &&
      Math.abs(usable[end].y - usable[end + 1].y) <= maxSize * 2.6
    ) {
      end++;
    }
    const block = usable.slice(start, end + 1);
    const rawTitle = tidy(block.map((l) => l.text).join(" "));
    if (rawTitle.length < 3 || rawTitle.length > 160) return null;
    // Un bloque corto hecho de palabras de editorial/colección no es un título.
    if (hasSoftWord(rawTitle) && rawTitle.split(/\s+/).length <= 4) return null;

    const rest = usable.filter((l) => !block.includes(l));
    const candidates = rest
      .filter((l) => l.size >= maxSize * 0.25)
      .map((l) => ({ line: l, name: looksLikeName(l.text) }))
      .filter((c) => c.name);

    let author = null;
    if (candidates.length) {
      const bestSize = Math.max(...candidates.map((c) => c.line.size));
      const top = candidates.filter((c) => c.line.size >= bestSize * 0.9);
      const blockIdx = usable.indexOf(block[block.length - 1]);
      const after = top.find((c) => usable.indexOf(c.line) > blockIdx);
      author = (after || top[0]).name;
    }
    return { title: fixCaps(rawTitle), author };
  }

  /* ---------- API principal ---------- */

  // pdf: documento de pdf.js. Devuelve { title, author, source: "metadata" | "cover" | "filename" }.
  async function guessMeta(pdf, filename) {
    const result = { title: null, author: null, source: "filename" };

    try {
      const meta = await pdf.getMetadata();
      const t = cleanMetaText(meta && meta.info && meta.info.Title);
      const a = cleanMetaText(meta && meta.info && meta.info.Author);
      if (t && validTitle(t)) {
        result.title = fixCaps(t);
        result.source = "metadata";
      }
      if (a && validAuthor(a)) result.author = fixCaps(a);
    } catch (_) { /* sin metadatos */ }

    if (!result.title || !result.author) {
      try {
        const limit = Math.min(pdf.numPages, 3);
        for (let n = 1; n <= limit; n++) {
          const pick = pickTitleAuthor(await pageLines(await pdf.getPage(n)));
          if (!pick) continue;
          if (!result.title) {
            result.title = pick.title;
            result.source = "cover";
          }
          if (!result.author && pick.author) result.author = pick.author;
          break;
        }
      } catch (_) { /* PDF sin capa de texto (escaneado) */ }
    }

    if (!result.title) result.title = cleanFilename(filename);
    return result;
  }

  /* ---------- Etiquetas sugeridas por el título ---------- */

  // Reglas editables: si el título contiene alguna de las palabras, se sugiere la etiqueta.
  // Las palabras de 4+ letras coinciden por prefijo ("program" encuentra "programación");
  // las de 3 o menos letras deben coincidir completas ("sql", "dax", "git").
  const TAG_RULES = [
    {
      tag: "Analista de datos",
      words: [
        "python", "pandas", "numpy", "scikit", "matplotlib", "sql", "mysql", "postgres", "postgresql", "datos", "data",
        "estadistica", "statistic", "machine learning", "aprendizaje automatico", "analisis de datos", "analytics",
        "analitica", "excel", "big data", "ciencia de datos",
      ],
    },
    {
      tag: "Analista BI",
      words: [
        "power bi", "powerbi", "dax", "tableau", "qlik", "looker", "dashboard", "business intelligence",
        "inteligencia de negocio", "data warehouse", "almacen de datos", "etl", "kimball", "modelado dimensional",
        "visualizacion", "indicadores", "kpi", "reporting",
      ],
    },
    {
      tag: "IT",
      words: [
        "programacion", "programming", "javascript", "typescript", "java", "linux", "redes", "network", "cloud", "nube",
        "aws", "azure", "docker", "kubernetes", "git", "devops", "software", "algoritmo", "ciberseguridad",
        "seguridad informatica", "base de datos", "bases de datos", "database", "api", "html", "css", "react", "node",
        "sistemas operativos", "computacion", "informatica", "hacking",
      ],
    },
    { tag: "Cuentos", words: ["cuentos", "cuento", "relatos", "relato", "short stories", "stories"] },
    { tag: "Novela", words: ["novela", "novel"] },
    {
      tag: "Negocios",
      words: ["negocios", "business", "emprendimiento", "startup", "marketing", "ventas", "management", "liderazgo"],
    },
    { tag: "Finanzas", words: ["finanzas", "finance", "inversion", "inversiones", "contabilidad", "economia", "trading"] },
    {
      tag: "Desarrollo personal",
      words: ["habitos", "productividad", "mindset", "motivacion", "autoayuda", "inteligencia emocional"],
    },
  ];

  const normText = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();

  function matchesWord(text, word) {
    const w = normText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = word.length <= 3;
    return new RegExp(`(^|[^a-z0-9])${w}${exact ? "([^a-z0-9]|$)" : ""}`).test(text);
  }

  function suggestTags(title) {
    const text = normText(title);
    return TAG_RULES.filter((r) => r.words.some((w) => matchesWord(text, w))).map((r) => r.tag);
  }

  const DEFAULT_TAGS = TAG_RULES.map((r) => r.tag);

  const api = { guessMeta, cleanFilename, pickTitleAuthor, pageLines, suggestTags, DEFAULT_TAGS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NetbookMeta = api;
})(typeof window !== "undefined" ? window : globalThis);
