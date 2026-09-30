const { checkKey, rechazar, registrarLog } = require("../lib/google");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);
  const accion = `${chk.usuario || "?"}  lanza análisis IA`
    + (req.body && req.body.queue_token ? " (confirmando cuota)" : "");
  console.log(`[panel] ${accion}`);
  registrarLog(accion).catch(() => {});
  const { sheet_id, queue_token } = req.body || {};
  const claveRender = process.env.RENDER_PANEL_KEY || process.env.PANEL_KEY;
  try {
    let r;
    if (queue_token) {
      // Confirmar una cola que excedía la cuota diaria de Render
      r = await fetch(`${process.env.RENDER_URL}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Panel-Key": claveRender,
        },
        body: JSON.stringify({ queue_token }),
      });
    } else {
      r = await fetch(`${process.env.RENDER_URL}/panel/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          panel_key: claveRender,
          sheet_id: sheet_id || null,
        }),
      });
    }
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
