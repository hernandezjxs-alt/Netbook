# Netbook — biblioteca de PDFs estilo Netflix

Frontend estático (HTML/CSS/JS) en **GitHub Pages** + **Supabase** (Auth, Postgres y Storage privado).
Sin backend propio. Lector con PDF.js, portadas generadas en el navegador y progreso de lectura sincronizado.

```
biblioteca/
├── web/                         # lo que se publica en GitHub Pages
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── bg.svg                   # fondo minimalista del login
│   └── config.js                # ← aquí van tu URL y anon key
├── supabase/schema.sql          # libros, progreso, RLS y buckets
├── supabase/profiles.sql        # usuarios con roles admin/user
└── .github/workflows/deploy.yml # despliegue automático
```

## 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor** → pega y ejecuta `supabase/schema.sql` completo.
   Crea las tablas `books` y `reading_progress`, las políticas RLS y los buckets privados `pdfs` y `covers`.
3. En el mismo SQL Editor ejecuta `supabase/profiles.sql` (después de `schema.sql`).
   Crea la tabla `profiles` con roles `admin` / `user`, un trigger que genera el perfil al registrarse
   y las políticas RLS. **La primera cuenta que crees será `admin`**; las demás serán `user`.
   Un usuario no puede cambiarse el rol a sí mismo; para promover a alguien:
   `update public.profiles set role = 'admin' where email = 'correo@ejemplo.com';`
4. **Project Settings → API**: copia la *Project URL* y la clave *anon public*.
5. **Authentication → URL Configuration**: en *Site URL* pon la URL de tu GitHub Pages
   (`https://TU-USUARIO.github.io/NOMBRE-REPO/`).
6. Opcional, para uso personal: en **Authentication → Providers → Email** desactiva *Confirm email*
   si no quieres confirmar por correo. Cuando hayas creado tu cuenta, desactiva *Allow new users to sign up*
   para que nadie más pueda registrarse.

## 2. Configurar la web

Edita `web/config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

La anon key es pública por diseño; los datos quedan protegidos por RLS y los buckets son privados
(los PDFs se sirven con URLs firmadas que caducan en 1 hora).
**Nunca** pongas la `service_role` key en el repo.

## 3. GitHub Pages

1. Sube el proyecto a un repositorio (rama `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Cada `git push` a `main` ejecuta el workflow y publica la carpeta `web/`.

## Uso

- **+ Subir PDF**: puedes elegir varios archivos a la vez. El navegador genera la portada, cuenta las páginas y detecta
  el **título y el autor** leyendo (en este orden) los metadatos del PDF, el texto de la portada y, si no hay nada,
  el nombre del archivo limpiado (quita números de ID, ISBN, "z-lib", etc.).
  Funciona con PDFs que tienen texto; en PDFs escaneados (solo imagen) usa el nombre del archivo.
- **Etiquetas y filtros**: cada libro puede tener varias etiquetas (por ejemplo *Analista de datos*, *Analista BI*, *IT*,
  *Cuentos*). Arriba aparecen chips para filtrar; si activas varios se muestran los libros que tengan cualquiera de ellos.
  El chip *Sin etiqueta* muestra lo que falta por clasificar.
  - Al subir, las etiquetas se sugieren por palabras del título (se pueden cambiar o desactivar).
  - **✨ Etiquetar automático** clasifica de una vez los libros sin etiqueta usando esas mismas reglas.
  - **Seleccionar** permite marcar varios libros (o "Todos los visibles" con un filtro activo) y agregarles etiquetas juntos.
  - Las reglas están en `web/meta.js` (`TAG_RULES`): puedes agregar palabras o etiquetas nuevas.
  - Requiere la columna `tags` de la tabla `books`, que ya incluye `supabase/schema.sql`. Si tu base es anterior, ejecuta:
    `alter table public.books add column if not exists tags text[] not null default '{}';`
- **Informe de subida**: al elegir archivos se revisan al instante (PDF válido, máx. 50 MB) y al terminar aparece una lista
  por libro con el motivo: ✓ subido, ↺ repetido (mismo título y páginas), ✕ demasiado pesado (con su tamaño en MB),
  ✕ no es PDF, ✕ error (cuota llena, conexión, PDF dañado o con contraseña…), más el conteo de cada caso.
  Si algo no se subió, la ventana queda abierta con el informe (y un botón para copiarlo).
- **✎** en el lector: corrige título, autor o categoría de un libro cuando la detección no acertó.
- Filas automáticas: *Continuar leyendo*, *Agregados recientemente* y una por categoría.
- Buscador por título, autor o categoría.
- Lector: flechas del teclado o deslizar en el móvil, zoom, y el progreso se guarda solo.
- Para eliminar un libro, ábrelo y usa el botón 🗑.

## Biblioteca compartida

- Todos los libros son **públicos para los usuarios con sesión** (se pueden leer, descargar y compartir). Al subir o editar un libro
  se puede desmarcar «Compartir con los demás usuarios» para que solo lo vea su dueño.
- Cada usuario ve sus propios favoritos, progreso y marcadores. Solo el dueño (o el admin) edita, etiqueta o elimina un libro.
- Como el registro es abierto, cualquiera que cree cuenta podrá ver los libros públicos: si prefieres controlar quién entra,
  desactiva *Allow new users to sign up* en Supabase (Authentication) después de crear las cuentas que necesites.

## Experiencia de lectura

- Tocar un libro abre su **detalle** (portada, datos, progreso, favorito, compartir, descargar, editar, eliminar).
- **Orden** (recientes, título, autor, más leídos, páginas) y **vista de lista o cuadrícula**; **♥ Favoritos** como filtro y fila.
- **👁 Vista previa** (en el detalle): lee una muestra (~10 % del libro, entre 3 y 10 páginas) sin guardar progreso.
- Lector: **📖 dos páginas** y **⛶ pantalla completa** (ajusta la página al alto de la pantalla).
- Lector con modos *normal / sepia / noche*, un toque en la página oculta la barra, y **marcadores con notas** (🔖).
- 📊 **Estadísticas** (almacenamiento usado frente a 1 GB) y exportación de la lista en CSV o un respaldo JSON de los datos.
- Tema claro/oscuro (🌓) y app instalable (`sw.js`; sin internet solo abre la interfaz, no los libros).

## Cuentas, perfil y administración

- Al crear cuenta se piden nombre completo, **RUT** (se valida el dígito verificador, también en la base de datos), correo y
  aceptar Términos y Privacidad. Las cuentas anteriores ven un aviso para completar el perfil.
- «¿Olvidaste tu contraseña?» envía un enlace de recuperación (configura la *Site URL* en Supabase Auth).
- El admin ve 👥 *Usuarios* (RUT enmascarado, con botón para verlo) y 📨 *Mensajes* del formulario de contacto.
- Al subir libros hay que declarar que se tiene derecho a compartirlos. Los textos legales (en `app.js`, `LEGAL`) son una plantilla:
  conviene revisarlos con un abogado (Ley 19.628 y la nueva Ley 21.719 de datos personales).
- La web es instalable en el celular («Agregar a pantalla de inicio»).

## Límites del plan gratuito de Supabase

- 1 GB de almacenamiento en total y 50 MB por archivo.
- El proyecto se pausa tras aproximadamente una semana sin actividad (se reactiva desde el panel).
- Cada usuario ve solo sus propios libros.

## Avisos de libros nuevos
Cuando un usuario (no admin) termina de subir libros, la app crea un aviso en la tabla `notifications` y aparece en el 📨 del admin (con contador y un mensaje arriba). Si la Edge Function `notify-upload` tiene el secreto `RESEND_API_KEY`, también llega un correo a `NOTIFY_TO` (por defecto hernandezjxs@gmail.com). Sin ese secreto, el correo se omite y solo funciona el aviso dentro de la app.

## Etiquetas y categorias oficiales
El admin las crea desde el icono 🏷️ (tabla `taxonomy`, solo el admin escribe, todos leen). Aparecen en los desplegables de subir y editar para todos.

## Subrayados y notas
En el lector se selecciona texto y aparece "Resaltar" / "Resaltar con nota". Se guardan en `highlights` (rectángulos relativos a la página, así escalan con el zoom) y solo los ve su dueño (RLS). El botón 🖍️ lista todos los de un libro.
