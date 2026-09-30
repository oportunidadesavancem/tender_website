const { checkKey, rechazar, registrarLog } = require("../lib/google");
const { leerEstado, guardarEstado, vistaEstado, puedeUsarAsistente } = require("../lib/estado");

const ACCIONES = ["resumen", "presupuesto", "organizacion", "memoria",
  "solvencia", "riesgos", "criterios", "preguntas"];

function documentosValidos(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.map((d) => {
    const nombre = String((d && d.nombre) || "").trim().slice(0, 180);
    if (d && d.driveId) return { nombre: nombre || "documento.pdf", driveId: String(d.driveId) };
    if (d && d.url && /^https?:\/\//i.test(d.url)) return { nombre: nombre || "documento", url: String(d.url) };
    return null;
  }).filter(Boolean).slice(0, 30);
}

module.exports = async (req, res) => {
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);
  if (req.method !== "POST") return res.status(405).json({ error: "usa POST" });
  if (!puedeUsarAsistente(chk)) return res.status(403).json({ error: "Esta sección no está disponible para tu usuario" });

  const url = String(process.env.N8N_WEBHOOK_URL || "").trim();
  const token = String(process.env.N8N_WEBHOOK_TOKEN || "").trim();
  if (!url || !token) return res.status(500).json({ error: "Faltan N8N_WEBHOOK_URL o N8N_WEBHOOK_TOKEN en Vercel" });

  const { accion, licitacion = {}, documentos, contexto = {} } = req.body || {};
  if (!ACCIONES.includes(accion)) return res.status(400).json({ error: `Acción desconocida: ${accion}` });
  const licId = String(licitacion.id || "").trim();
  const titulo = String(licitacion.titulo || "").trim();
  if (!licId || !titulo) return res.status(400).json({ error: "Falta la licitación" });
  const docs = documentosValidos(documentos);
  const idValido = (x) => /^[A-Za-z0-9_-]{10,}$/.test(String(x || ""));
  const pedido = contexto && typeof contexto === "object" ? contexto.reanudar : null;
  const reanudar = pedido && idValido(pedido.analisisId) && idValido(pedido.textosId)
    ? { analisisId: String(pedido.analisisId), textosId: String(pedido.textosId) }
    : null;
  if (!docs.length && !reanudar) return res.status(400).json({ error: "No hay ningún fichero marcado para analizar" });

  let estado;
  try {
    estado = await leerEstado();
  } catch (e) {
    return res.status(500).json({ error: `No se pudo leer el estado: ${e.message}` });
  }
  const vista = vistaEstado(estado.est);
  if (vista.ocupado) {
    return res.status(409).json({ error: "El sistema está en uso", ocupado: vista.ocupado });
  }

  const est = estado.est;
  const lic = est.licitaciones[licId] || { acciones: {} };
  lic.titulo = titulo;
  lic.organo = String(licitacion.organo || "");
  lic.expediente = String(licitacion.expediente || "");
  lic.acciones = lic.acciones || {};
  const previo = lic.acciones[accion];
  const guardado = {
    reanudar: reanudar || (previo && previo.reanudar) || undefined,
    rescate: (previo && previo.rescate) || undefined,
  };
  lic.acciones[accion] = {
    estado: "procesando", desde: new Date().toISOString(),
    anterior: previo && previo.estado === "listo" ? previo : undefined,
    ...guardado,
  };
  est.licitaciones[licId] = lic;

  let estadoId;
  try {
    estadoId = await guardarEstado(est);
  } catch (e) {
    return res.status(500).json({ error: `No se pudo guardar el estado: ${e.message}` });
  }

  const cuerpo = {
    accion,
    licitacion: { id: licId, expediente: lic.expediente, titulo, organo: lic.organo },
    documentos: docs,
    contexto: { ...(contexto && typeof contexto === "object" ? contexto : {}), reanudar: reanudar || undefined },
    estadoId,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-panel-token": token },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`n8n respondió HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    lic.acciones[accion] = previo && previo.estado === "listo" ? previo : {
      estado: "error", fecha: new Date().toISOString(),
      mensaje: `No se pudo lanzar en n8n: ${e.message}`,
      ayuda: "Comprueba que el flujo de n8n está activo y que la URL y el token coinciden.",
      ...guardado,
    };
    try { await guardarEstado(est); } catch (x) {}
    return res.status(502).json({ error: `No se pudo lanzar el análisis: ${e.message}` });
  }

  registrarLog(`${chk.usuario || "?"}  ASISTENTE ${accion}${reanudar ? " (retomado)" : ""}  ${titulo.slice(0, 60)}  ${docs.length} doc(s)`).catch(() => {});
  return res.status(202).json({ ok: true, accion, licId });
};
