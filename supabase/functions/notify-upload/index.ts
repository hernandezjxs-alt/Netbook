// Edge Function "notify-upload": envía por correo (Resend) el aviso de libros nuevos.
// Secretos: RESEND_API_KEY (obligatorio para enviar), NOTIFY_TO (opcional; por defecto hernandezjxs@gmail.com).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { notification_id } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: n } = await sb.from("notifications").select("*").eq("id", notification_id).maybeSingle();
    if (!n) return json({ sent: false, reason: "not_found" }, 404);
    if (Date.now() - new Date(n.created_at).getTime() > 5 * 60 * 1000) return json({ sent: false, reason: "too_old" });
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ sent: false, reason: "no_key" });
    const to = Deno.env.get("NOTIFY_TO") ?? "hernandezjxs@gmail.com";
    const titles = (n.titles as string[]).slice(0, 15);
    const more = n.count > titles.length ? `<li>…y ${n.count - titles.length} más</li>` : "";
    const html = `<div style="font-family:system-ui,sans-serif"><h2>📚 Nuevos libros en Netbook</h2><p><b>${esc(n.username ?? "Un usuario")}</b> subió <b>${n.count}</b> libro(s):</p><ul>${titles.map((t) => `<li>${esc(t)}</li>`).join("")}${more}</ul><p><a href="https://hernandezjxs-alt.github.io/Netbook/">Abrir Netbook</a></p></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Netbook <onboarding@resend.dev>", to: [to], subject: `📚 ${n.username ?? "Alguien"} subió ${n.count} libro(s) a Netbook`, html }),
    });
    return json({ sent: r.ok, status: r.status });
  } catch (e) {
    return json({ sent: false, error: String(e) }, 500);
  }
});
