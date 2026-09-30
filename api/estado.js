const { checkKey, rechazar } = require("../lib/google");
const { leerEstado, vistaEstado, puedeUsarAsistente } = require("../lib/estado");

module.exports = async (req, res) => {
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);
  if (!puedeUsarAsistente(chk)) return res.status(403).json({ error: "Esta sección no está disponible para tu usuario" });
  try {
    const { est } = await leerEstado();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(vistaEstado(est));
  } catch (e) {
    console.error("Fallo en /api/estado:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
