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

- **+ Subir PDF**: eliges el archivo, el navegador genera la portada y cuenta las páginas, y todo se guarda en tu cuenta.
- Filas automáticas: *Continuar leyendo*, *Agregados recientemente* y una por categoría.
- Buscador por título, autor o categoría.
- Lector: flechas del teclado o deslizar en el móvil, zoom, y el progreso se guarda solo.
- Para eliminar un libro, ábrelo y usa el botón 🗑.

## Límites del plan gratuito de Supabase

- 1 GB de almacenamiento en total y 50 MB por archivo.
- El proyecto se pausa tras aproximadamente una semana sin actividad (se reactiva desde el panel).
- Cada usuario ve solo sus propios libros.
