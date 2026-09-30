const { leerJsonDrive, escribirJsonDrive, invalidarJson } = require("./google");

const NOMBRE = "estado_asistente.json";
const CADUCIDAD_MIN = Number(process.env.ASISTENTE_CADUCIDAD_MIN || 60);

async function leerEstado() {
  invalidarJson(NOMBRE);
  const { id, datos } = await leerJsonDrive(NOMBRE);
  const est = datos && typeof datos === "object" ? datos : {};
  if (!est.licitaciones || typeof est.licitaciones !== "object") est.licitaciones = {};
  return { id, est };
}

async function guardarEstado(est) {
  est.actualizado = new Date().toISOString();
  const id = await escribirJsonDrive(NOMBRE, est);
  invalidarJson(NOMBRE);
  return id;
}

function vistaEstado(est) {
  const ahora = Date.now();
  const copia = JSON.parse(JSON.stringify(est));
  let ocupado = null;
  for (const [licId, lic] of Object.entries(copia.licitaciones || {})) {
    for (const [accion, a] of Object.entries(lic.acciones || {})) {
      if (!a || a.estado !== "procesando") continue;
      const min = (ahora - Date.parse(a.desde)) / 60000;
      if (!isFinite(min) || min > CADUCIDAD_MIN) {
        lic.acciones[accion] = {
          estado: "error",
          fecha: a.desde,
          mensaje: `El análisis no terminó: lleva más de ${CADUCIDAD_MIN} minutos sin respuesta de n8n.`,
          ayuda: "Revisa la ejecución en n8n y vuelve a lanzarlo.",
          reanudar: a.reanudar || undefined,
          rescate: a.rescate || undefined,
        };
      } else if (!ocupado || Date.parse(a.desde) < Date.parse(ocupado.desde)) {
        ocupado = { licId, accion, titulo: lic.titulo || "", desde: a.desde };
      }
    }
  }
  return { licitaciones: copia.licitaciones || {}, ocupado, caducidadMin: CADUCIDAD_MIN };
}

function puedeUsarAsistente(chk) {
  if (chk.rol === "ingeniero") return true;
  const permitidos = String(process.env.ASISTENTE_USUARIOS || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!permitidos.length) return true;
  return permitidos.includes(String(chk.usuario || "").toLowerCase());
}

module.exports = { leerEstado, guardarEstado, vistaEstado, puedeUsarAsistente, CADUCIDAD_MIN };
