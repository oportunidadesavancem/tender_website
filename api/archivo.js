const { checkKey, rechazar, descargarArchivoDrive } = require("../lib/google");

module.exports = async (req, res) => {
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);

  const id = String((req.query && req.query.id) || "").trim();
  if (!id) return res.status(400).json({ error: "falta el id del archivo" });

  try {
    const { nombre, mimeType, buffer } = await descargarArchivoDrive(id);
    res.setHeader("Content-Type", mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(nombre)}"`
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(buffer);
  } catch (e) {
    console.error("Fallo en /api/archivo:", e);
    return res.status(e.codigo || 500).json({ error: String(e.message || e) });
  }
};
