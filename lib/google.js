/* Paquetes especificos en vez de "googleapis" completo: aquel trae TODAS las
   APIs de Google (113 MB) y tarda ~840 ms en cargarse en cada arranque en
   frio de la funcion. Estos tres suman ~4 MB y ~140 ms. */
const { sheets: sheetsApi } = require("@googleapis/sheets");
const { drive: driveApi } = require("@googleapis/drive");
const { OAuth2Client } = require("google-auth-library");

let clients = null;

function leerConfig() {
  const bruto = process.env.GOOGLE_OAUTH_CONFIG;
  if (!bruto) throw new Error("GOOGLE_OAUTH_CONFIG no está definida en Vercel");

  let cfg;
  try {
    cfg = JSON.parse(bruto);
  } catch (e) {
    throw new Error("GOOGLE_OAUTH_CONFIG no es JSON válido: " + e.message);
  }

  // Google entrega el JSON envuelto en "installed" o "web" según el tipo
  // de cliente OAuth. Aceptamos ambos y también el formato plano.
  const nucleo = cfg.installed || cfg.web || cfg;

  const client_id = nucleo.client_id || cfg.client_id;
  const client_secret = nucleo.client_secret || cfg.client_secret;
  const refresh_token = nucleo.refresh_token || cfg.refresh_token || cfg.token;

  const faltan = [];
  if (!client_id) faltan.push("client_id");
  if (!client_secret) faltan.push("client_secret");
  if (!refresh_token) faltan.push("refresh_token");

  if (faltan.length) {
    const presentes = [
      ...Object.keys(cfg),
      ...(cfg.installed ? Object.keys(cfg.installed).map(k => "installed." + k) : []),
      ...(cfg.web ? Object.keys(cfg.web).map(k => "web." + k) : []),
    ];
    throw new Error(
      `GOOGLE_OAUTH_CONFIG: faltan ${faltan.join(", ")}. ` +
      `Campos encontrados: ${presentes.join(", ")}`
    );
  }
  return { client_id, client_secret, refresh_token };
}

function getClients() {
  if (clients) return clients;
  const cfg = leerConfig();
  const auth = new OAuth2Client(cfg.client_id, cfg.client_secret);
  auth.setCredentials({ refresh_token: cfg.refresh_token });
  clients = {
    auth,
    sheets: sheetsApi({ version: "v4", auth }),
    drive: driveApi({ version: "v3", auth }),
  };
  return clients;
}

/* Claves por persona, para saber en los logs quien ha tocado que.

   PANEL_KEYS = "alejandro:CLAVE1,jefe:CLAVE2"   (recomendado)
   PANEL_KEY  = "CLAVE"                          (compatibilidad: usuario "panel")

   Se pueden tener las dos: PANEL_KEY sigue valiendo mientras se reparten
   las nuevas. */
function usuariosConfigurados() {
  const out = [];
  for (const par of String(process.env.PANEL_KEYS || "").split(",")) {
    const i = par.indexOf(":");
    if (i <= 0) continue;
    const nombre = par.slice(0, i).trim();
    const clave = par.slice(i + 1).trim();
    if (nombre && clave) out.push({ nombre, clave });
  }
  const unica = String(process.env.PANEL_KEY || "").trim();
  if (unica) {
    out.push({ nombre: String(process.env.PANEL_KEY_NOMBRE || "panel").trim(), clave: unica });
  }
  return out;
}

function checkKey(req) {
  const usuarios = usuariosConfigurados();
  if (!usuarios.length) return { ok: false, motivo: "sin_configurar" };
  const recibida = String(
    (req.query && req.query.key) || (req.body && req.body.key) || ""
  ).trim();
  if (!recibida) return { ok: false, motivo: "sin_clave" };
  const u = usuarios.find((x) => x.clave === recibida);
  if (!u) return { ok: false, motivo: "no_coincide" };
  return { ok: true, motivo: null, usuario: u.nombre, rol: rolDe(u.nombre) };
}

/* Los que aparecen en PANEL_INGENIEROS entran con rol reducido: solo
   Importantes y el asistente. Quien no este en la lista sigue siendo
   admin, para no romper las claves que ya funcionaban. */
function rolDe(nombre) {
  const ingenieros = String(process.env.PANEL_INGENIEROS || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return ingenieros.includes(String(nombre || "").toLowerCase())
    ? "ingeniero" : "admin";
}

function rechazar(res, chk) {
  const msg = chk.motivo === "sin_configurar"
    ? "PANEL_KEY no está configurada en Vercel (o falta redesplegar tras añadirla)"
    : "clave incorrecta";
  return res.status(401).json({ error: msg, motivo: chk.motivo });
}

let cacheMeses = null, cacheMesesTs = 0;
const TTL_MESES = 10 * 60 * 1000;

async function listarMeses() {
  // Un Sheet nuevo aparece una vez al mes: no hace falta preguntarlo
  // en cada refresco del panel.
  if (cacheMeses && Date.now() - cacheMesesTs < TTL_MESES) return cacheMeses;
  const { drive } = getClients();
  const res = await drive.files.list({
    q: `name contains 'AVANCEM_2' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 60,
  });
  cacheMeses = res.data.files
    .filter(f => /^AVANCEM_\d{6}$/.test(f.name))
    .map(f => ({ mes: f.name.slice(8), id: f.id }))
    .sort((a, b) => b.mes.localeCompare(a.mes));
  cacheMesesTs = Date.now();
  return cacheMeses;
}

/* ------------------------------------------------------------------
   Caché de Drive.

   Sin esto, cada lectura de un JSON costaba 3 llamadas (buscar carpeta,
   buscar fichero, descargar) y /api/datos lee cuatro JSON: 12 llamadas
   por refresco solo en configuración. Con las tres capas de abajo, un
   refresco en caliente cuesta 0.

   Las variables viven en el módulo, así que sobreviven entre
   invocaciones mientras la función siga caliente.
   ------------------------------------------------------------------ */
let cacheCarpeta = null;                 // el id no cambia nunca
let cacheIndice = null;                  // nombre -> id de fichero
let cacheIndiceTs = 0;
const cacheJson = new Map();             // nombre -> { datos, id, ts }
const TTL_INDICE = 10 * 60 * 1000;
const TTL_JSON = 60 * 1000;

async function carpetaConfig() {
  if (cacheCarpeta) return cacheCarpeta;
  const { drive } = getClients();
  const root = process.env.AVANCEM_ROOT_FOLDER_ID;
  const res = await drive.files.list({
    q: `'${root}' in parents and name='configuracion' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
  });
  if (!res.data.files.length) throw new Error("carpeta configuracion no encontrada");
  cacheCarpeta = res.data.files[0].id;
  return cacheCarpeta;
}

// Un solo listado de la carpeta para todos los ficheros, en vez de una
// búsqueda por cada uno.
async function indiceConfig() {
  if (cacheIndice && Date.now() - cacheIndiceTs < TTL_INDICE) return cacheIndice;
  const { drive } = getClients();
  const folder = await carpetaConfig();
  const res = await drive.files.list({
    q: `'${folder}' in parents and trashed=false`,
    fields: "files(id,name)",
    orderBy: "createdTime",
    pageSize: 200,
  });
  cacheIndice = {};
  for (const f of res.data.files) if (!(f.name in cacheIndice)) cacheIndice[f.name] = f.id;
  cacheIndiceTs = Date.now();
  return cacheIndice;
}

async function buscarEnConfig(nombre) {
  const { drive } = getClients();
  const folder = await carpetaConfig();
  const res = await drive.files.list({
    q: `'${folder}' in parents and name='${String(nombre).replace(/'/g, "\\'")}' and trashed=false`,
    fields: "files(id)",
    orderBy: "createdTime",
    pageSize: 10,
  });
  const id = res.data.files.length ? res.data.files[0].id : null;
  if (cacheIndice) {
    if (id) cacheIndice[nombre] = id;
    else delete cacheIndice[nombre];
  }
  return id;
}

async function leerJsonDrive(nombre) {
  const enCache = cacheJson.get(nombre);
  if (enCache && Date.now() - enCache.ts < TTL_JSON) {
    return { id: enCache.id, datos: enCache.datos };
  }
  const { drive } = getClients();
  const indice = await indiceConfig();
  let id = indice[nombre] || await buscarEnConfig(nombre);
  if (!id) return { id: null, datos: null };
  let contenido;
  try {
    contenido = await drive.files.get({ fileId: id, alt: "media" });
  } catch (e) {
    if (!e || (e.code !== 404 && e.status !== 404)) throw e;
    id = await buscarEnConfig(nombre);
    if (!id) return { id: null, datos: null };
    contenido = await drive.files.get({ fileId: id, alt: "media" });
  }
  cacheJson.set(nombre, { datos: contenido.data, id, ts: Date.now() });
  return { id, datos: contenido.data };
}

// Tras escribir, la copia en caché queda obsoleta.
function invalidarJson(nombre) {
  cacheJson.delete(nombre);
}

let cacheCarpetaDocs = null;

/* Los documentos que genera la IA no van a "configuracion": se guardan
   aparte para que no ensucien el indice ni el listado de configuracion. */
async function carpetaDocumentos() {
  if (cacheCarpetaDocs) return cacheCarpetaDocs;
  const { drive } = getClients();
  const root = process.env.AVANCEM_ROOT_FOLDER_ID;
  const nombre = "documentos_ia";
  const res = await drive.files.list({
    q: `'${root}' in parents and name='${nombre}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
  });
  if (res.data.files.length) {
    cacheCarpetaDocs = res.data.files[0].id;
    return cacheCarpetaDocs;
  }
  const creada = await drive.files.create({
    requestBody: {
      name: nombre,
      parents: [root],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });
  cacheCarpetaDocs = creada.data.id;
  return cacheCarpetaDocs;
}

async function descargarArchivoDrive(fileId) {
  const { drive } = getClients();
  const meta = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,parents",
  });
  const padres = meta.data.parents || [];
  const resultados = String(process.env.DRIVE_CARPETA_RESULTADOS || "").trim();
  let permitido = padres.includes(await carpetaDocumentos());
  if (!permitido && resultados) {
    for (const p of padres) {
      const carpeta = await drive.files.get({ fileId: p, fields: "parents" });
      if ((carpeta.data.parents || []).includes(resultados)) { permitido = true; break; }
    }
  }
  if (!permitido) {
    const e = new Error("el archivo no está en las carpetas de resultados del asistente");
    e.codigo = 403;
    throw e;
  }
  const bin = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return {
    nombre: meta.data.name,
    mimeType: meta.data.mimeType,
    buffer: Buffer.from(bin.data),
  };
}

async function abrirSubidaDrive({ nombre, tipo, tamano, origen }) {
  const carpeta = String(process.env.DRIVE_CARPETA_TEMPORAL || "").trim();
  if (!carpeta) throw new Error("Falta DRIVE_CARPETA_TEMPORAL en Vercel");
  const { auth } = getClients();
  const { token } = await auth.getAccessToken();
  const cabeceras = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": tipo,
    "X-Upload-Content-Length": String(tamano),
  };
  if (origen) cabeceras.Origin = origen;
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",
    { method: "POST", headers: cabeceras, body: JSON.stringify({ name: nombre, parents: [carpeta] }) }
  );
  if (!r.ok) throw new Error(`Drive no abrió la subida (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  const url = r.headers.get("location");
  if (!url) throw new Error("Drive no devolvió la URL de subida");
  return url;
}

async function escribirJsonDrive(nombre, datos) {
  invalidarJson(nombre);
  const { drive } = getClients();
  const existente = await leerJsonDrive(nombre);
  const body = JSON.stringify(datos, null, 2);
  const idExistente = existente.id || await buscarEnConfig(nombre);
  if (idExistente) {
    await drive.files.update({
      fileId: idExistente,
      media: { mimeType: "application/json", body },
    });
    return idExistente;
  }
  const folder = await carpetaConfig();
  const creado = await drive.files.create({
    requestBody: { name: nombre, parents: [folder], mimeType: "application/json" },
    media: { mimeType: "application/json", body },
    fields: "id",
  });
  if (cacheIndice) cacheIndice[nombre] = creado.data.id;
  return creado.data.id;
}

/* ------------------------------------------------------------------
   Registro de actividad en Drive (configuracion/log_vercel.txt).

   Los logs de Vercel necesitan plan de pago para consultarlos, asi que
   dejamos el rastro en un fichero de texto en Drive, que se abre desde
   el navegador como cualquier otro.

   Cuesta 2 llamadas a Drive por guardado (leer + escribir), pero el panel
   agrupa los cambios cada 5 minutos, asi que son unas pocas al dia.
   ------------------------------------------------------------------ */
const LOG_NOMBRE = "log_vercel.txt";
const LOG_MAX_LINEAS = 3000;

/* Hora de España, no UTC: la funcion corre en un servidor en otra zona y
   toISOString() daba dos horas menos en verano (y una en invierno), asi
   que el registro no cuadraba con lo que recordaba la gente. El locale
   sv-SE devuelve directamente "2026-08-03 18:30:00". */
const _horaES = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Madrid",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

function selloTemporal() {
  try {
    return _horaES.format(new Date());
  } catch (e) {
    return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }
}

async function registrarLog(lineas) {
  const arr = (Array.isArray(lineas) ? lineas : [lineas]).filter(Boolean);
  if (!arr.length) return;
  try {
    const { drive } = getClients();
    const sello = selloTemporal();
    const nuevas = arr.map((l) => `${sello}  ${l}`);

    const indice = await indiceConfig();
    const id = indice[LOG_NOMBRE];

    let previo = "";
    if (id) {
      try {
        const r = await drive.files.get({ fileId: id, alt: "media" });
        previo = typeof r.data === "string" ? r.data : String(r.data || "");
      } catch (e) { previo = ""; }
    }

    let todas = (previo ? previo.split("\n") : []).concat(nuevas)
      .filter((l) => l.trim());
    if (todas.length > LOG_MAX_LINEAS) todas = todas.slice(-LOG_MAX_LINEAS);
    const body = todas.join("\n") + "\n";

    if (id) {
      await drive.files.update({
        fileId: id, media: { mimeType: "text/plain", body },
      });
    } else {
      const folder = await carpetaConfig();
      await drive.files.create({
        requestBody: { name: LOG_NOMBRE, parents: [folder], mimeType: "text/plain" },
        media: { mimeType: "text/plain", body },
        fields: "id",
      });
      cacheIndice = null;   // el indice se ha quedado corto
    }
  } catch (e) {
    // El registro nunca debe tumbar un guardado
    console.error("No se pudo escribir el log en Drive:", e.message || e);
  }
}

module.exports = { getClients, checkKey, rolDe, listarMeses, leerJsonDrive, escribirJsonDrive, rechazar, invalidarJson, usuariosConfigurados, registrarLog, descargarArchivoDrive, abrirSubidaDrive };
