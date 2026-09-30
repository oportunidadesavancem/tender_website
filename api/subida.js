const { checkKey, rechazar, abrirSubidaDrive } = require("../lib/google");
const { puedeUsarAsistente } = require("../lib/estado");

const MAX_MB = Number(process.env.SUBIDA_MAX_MB || 100);
const TIPOS = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

module.exports = async (req, res) => {
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);
  if (req.method !== "POST") return res.status(405).json({ error: "usa POST" });
  if (!puedeUsarAsistente(chk)) return res.status(403).json({ error: "Esta sección no está disponible para tu usuario" });

  const { nombre, tamano } = req.body || {};
  const n = String(nombre || "").trim();
  if (!n) return res.status(400).json({ error: "falta el nombre del fichero" });
  const ext = ((/\.([a-z0-9]+)$/i.exec(n) || [])[1] || "").toLowerCase();
  const mime = TIPOS[ext];
  if (!mime) {
    return res.status(400).json({ error: "Solo se admiten PDF y Excel (.xlsx, .xls)" });
  }
  const bytes = Number(tamano);
  if (!isFinite(bytes) || bytes <= 0) return res.status(400).json({ error: "tamaño no válido" });
  if (bytes > MAX_MB * 1024 * 1024) {
    return res.status(413).json({ error: `El fichero pasa de ${MAX_MB} MB` });
  }

  const origen = req.headers.origin
    || String(process.env.PANEL_ORIGEN || "").trim()
    || (req.headers.host ? `https://${req.headers.host}` : "");
  try {
    const uploadUrl = await abrirSubidaDrive({
      nombre: n.slice(0, 180), tipo: mime, tamano: bytes, origen,
    });
    return res.status(200).json({ uploadUrl });
  } catch (e) {
    console.error("Fallo en /api/subida:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
};
