const { getClients, checkKey, rechazar, listarMeses, leerJsonDrive } = require("../lib/google");

const HOJAS = ["Licitaciones", "Avancem", "Mademan"];

function urlDeFormula(v) {
  if (typeof v !== "string") return null;
  const m = v.match(/HYPERLINK\("([^"]+)"/);
  if (m) return m[1];
  return /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
}

// =HYPERLINK("url";"Anexo I") -> { url, nombre: "Anexo I" }
function enlaceDeFormula(v, porDefecto) {
  const url = urlDeFormula(v);
  if (!url) return null;
  let nombre = porDefecto;
  if (typeof v === "string") {
    const m = v.match(/HYPERLINK\("[^"]+"\s*[;,]\s*"([^"]*)"/);
    if (m && m[1].trim()) nombre = m[1].trim();
  }
  return { url, nombre };
}

/* La columna "Más adjuntos" no es un enlace: es un texto con pares
   "nombre: URL", uno por linea, con todos los documentos que no caben en
   las cinco columnas de Adjunto. Antes se trataba como un unico enlace y
   se perdian: en expedientes con 18 documentos solo llegaban 5. */
function listaDeMasAdjuntos(v) {
  if (!v) return [];
  let texto = String(v);
  // Puede venir como HYPERLINK o como texto plano; en ambos casos lo que
  // interesa son los pares nombre + URL que hay dentro.
  const salida = [];
  const vistos = new Set();
  const re = /([^\n\r:]{1,120}?)\s*:\s*(https?:\/\/[^\s"')\]]+)/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const url = m[2].replace(/[.,;]+$/, "");
    let nombre = m[1]
      .replace(/[\uFFFC\u200B]/g, " ")          // marcas de objeto del pegado
      .replace(/^[\s\-–—•*|>]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    // Si el nombre arrastra el final de la URL anterior, quedarse con la
    // ultima parte legible (lo que va tras el ultimo espacio raro).
    if (/^https?:/i.test(nombre)) nombre = "";
    if (!nombre) nombre = "Documento " + (salida.length + 1);
    if (vistos.has(url)) continue;
    vistos.add(url);
    salida.push({ nombre: nombre.slice(0, 120), url });
  }
  return salida;
}

// Con valueRenderOption FORMULA (necesario para leer los HYPERLINK), las
// fechas llegan como serial de Sheets: días desde 1899-12-30, con la hora
// en la parte decimal. 25569 es el desfase hasta la época Unix.
function letraCol(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s || "A";
}

const sinAcentos = (s) =>
  String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// Localiza cada campo por el TEXTO de su cabecera, no por su posición. Es lo
// único fiable: contar columnas engaña porque las hojas de Google traen 26
// por defecto aunque solo se usen 25, y entonces un Sheet sin migrar parece
// migrado y el ID interno se busca en una columna vacía.
function indicesPorCabecera(cab) {
  const pos = {};
  (cab || []).forEach((h, i) => {
    const k = sinAcentos(h);
    if (k && !(k in pos)) pos[k] = i;
  });
  const claves = Object.keys(pos);
  const buscar = (alts, excluir = []) => {
    for (const a of alts) {
      if (a in pos && !excluir.includes(pos[a])) return pos[a];
    }
    for (const a of alts) {
      const k = claves.find((x) => x.startsWith(a) && !excluir.includes(pos[x]));
      if (k !== undefined) return pos[k];
    }
    return -1;
  };

  const iid = buscar(["id interno"]);
  return {
    // A, B y C son fijas por estructura. La C1 no dice "Análisis IA": el bot
    // le escribe una fórmula HYPERLINK, así que por cabecera no aparece.
    vista: buscar(["vista"]) >= 0 ? buscar(["vista"]) : 0,
    importante: buscar(["importante", "import"]) >= 0 ? buscar(["importante", "import"]) : 1,
    ia: buscar(["analisis ia", "analisis"]) >= 0 ? buscar(["analisis ia", "analisis"]) : 2,
    organo: buscar(["organo de contratacion", "organo"]),
    titulo: buscar(["titulo"]),
    cat: buscar(["categoria"]),
    pub: buscar(["fecha de publicacion", "fecha publicacion"]),
    plazo: buscar(["plazo presentacion", "plazo"]),
    imp: buscar(["presupuesto sin iva", "presupuesto"]),
    estado: buscar(["estado"]),
    enlace: buscar(["enlace"]),
    pcap: buscar(["pcap"]),
    ppt: buscar(["ppt"]),
    adj: [1, 2, 3, 4, 5].map((n) => buscar([`adjunto ${n}`])),
    /* Faltaba: sin esto idx.mas era undefined y la columna con el resto
       de documentos no se leia nunca. */
    mas: buscar(["mas adjuntos", "otros adjuntos", "adjuntos extra", "mas documentos"]),
    id: buscar(["id"], [iid]),
    fuente: buscar(["fuente"]),
    cpv: buscar(["cpvs", "cpv"]),
    det: buscar(["fecha detectado"]),
    punt: buscar(["puntuacion"]),
    iid,
  };
}

const val = (row, i) => (i >= 0 ? row[i] : undefined);

function fechaDeSerial(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v !== "number") return String(v);
  const d = new Date(Math.round((v - 25569) * 86400000));
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, "0");
  const fecha = `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  const frac = v - Math.floor(v);
  if (frac > 0.0001) return `${fecha} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return fecha;
}

function estadoIA(v) {
  if (v === true || v === "TRUE") return { ia: true, iaEstado: null };
  if (typeof v === "string") {
    if (v.includes("✓")) return { ia: false, iaEstado: "listo" };
    /* Un analisis fallido vuelve marcado: el bot ya reintenta los errores
       en la siguiente pasada, pero en el panel la casilla salia vacia, la
       fila no contaba como marcada y el boton se quedaba deshabilitado,
       asi que no habia forma de relanzarlo desde aqui. */
    if (v.includes("⚠")) return { ia: true, iaEstado: "error" };
    if (v.includes("ⓘ")) return { ia: true, iaEstado: "sinpliegos" };
  }
  return { ia: false, iaEstado: null };
}

/* Payload ya montado, por mes. Vive mientras la instancia siga caliente:
   evita rehacer las dos llamadas a Sheets y el parseo de 1174 filas. */
const cachePayload = new Map();
const TTL_PAYLOAD = 45 * 1000;

/* Quien puede usar el asistente lo decide ASISTENTE_USUARIOS, la misma
   variable que aplica /api/asistente. Se manda al navegador para que no
   haya una lista de nombres escrita a mano en el HTML. */
function puedeUsarIA(chk) {
  if (chk.rol === "ingeniero") return true;
  const permitidos = String(process.env.ASISTENTE_USUARIOS || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!permitidos.length) return true;
  return permitidos.includes(String(chk.usuario || "").toLowerCase());
}

module.exports = async (req, res) => {
  const chk = checkKey(req);
  if (!chk.ok) return rechazar(res, chk);
  try {
    let meses;
    try {
      meses = await listarMeses();
    } catch (e) {
      e.paso = "listar Sheets en Drive (revisa AVANCEM_ROOT_FOLDER_ID y los permisos del token)";
      throw e;
    }
    if (!meses.length) return res.status(404).json({ error: "no hay Sheets AVANCEM_YYYYMM" });
    const mes = req.query.mes && meses.find(m => m.mes === req.query.mes) ? req.query.mes : meses[0].mes;
    const sheetId = meses.find(m => m.mes === mes).id;

    // ?fresco=1 lo usa el bot para forzar la relectura al terminar su pasada
    const forzar = req.query.fresco === "1";
    const enCache = cachePayload.get(mes);
    if (!forzar && enCache && Date.now() - enCache.ts < TTL_PAYLOAD) {
      res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=600");
      // El payload cacheado es igual para todos MENOS "usuario", que depende de
      // la clave de quien pregunta. Se sobrescribe aqui: si no, quien reutiliza
      // la cache dentro del TTL entra con el nombre del que la lleno.
      return res.status(200).json({
        ...enCache.payload,
        usuario: chk.usuario || null,
        rol: chk.rol || "admin",
        puede_ia: puedeUsarIA(chk),
      });
    }

    const { sheets } = getClients();

    // Los Sheets anteriores a agosto 2026 tienen 25 columnas (sin la casilla
    // "Vetar organismo" en la D). Detectamos el layout de cada pestaña y
    // desplazamos los índices, en vez de exigir que estén migrados.
    let meta;
    try {
      meta = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        fields: "sheets(properties(title,gridProperties(columnCount)))",
      });
    } catch (e) {
      e.paso = "leer la estructura del Sheet";
      throw e;
    }
    const anchos = {};
    for (const h of meta.data.sheets) {
      anchos[h.properties.title] = h.properties.gridProperties.columnCount || 25;
    }
    const ultima = (hoja) => letraCol(anchos[hoja] || 25);

    if (anchos["Licitaciones"] === undefined) {
      const e = new Error(
        `El Sheet del mes ${mes} no tiene pestaña "Licitaciones". ` +
        `Pestañas encontradas: ${Object.keys(anchos).join(", ")}`
      );
      e.paso = "localizar la pestaña Licitaciones";
      throw e;
    }

    // Un mes antiguo puede no tener todas las pestañas de división. Pedimos
    // solo las que existen: un rango a una pestaña inexistente hace fallar
    // el batchGet entero.
    const hojasDiv = ["Avancem", "Mademan"].filter(h => anchos[h] !== undefined);
    const hojaIA = anchos["Análisis IA"] !== undefined ? "Análisis IA" : null;
    const hojaCambios = anchos["Cambios de estado"] !== undefined ? "Cambios de estado" : null;
    const rangos = [
      `'Licitaciones'!A1:${ultima("Licitaciones")}1`,
      `'Licitaciones'!A2:${ultima("Licitaciones")}`,
      ...hojasDiv.map(h => `'${h}'!A1:${ultima(h)}`),
      ...(hojaIA ? [`'${hojaIA}'!A1:${ultima(hojaIA)}`] : []),
      ...(hojaCambios ? [`'${hojaCambios}'!A1:${ultima(hojaCambios)}`] : []),
    ];

    let r;
    try {
      r = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: rangos,
        valueRenderOption: "FORMULA",
      });
    } catch (e) {
      e.paso = `leer los rangos ${rangos.join(" | ")}`;
      throw e;
    }

    const vr = r.data.valueRanges;
    const cabecera = (vr[0].values || [[]])[0] || [];
    const lic = vr[1].values || [];
    const idx = indicesPorCabecera(cabecera);

    if (idx.iid < 0) {
      const e = new Error(
        `No encuentro la columna "ID interno" en ${mes}. ` +
        `Cabeceras leídas: ${cabecera.filter(Boolean).join(" | ")}`
      );
      e.paso = "localizar columnas por cabecera";
      throw e;
    }

    // Divisiones: leemos su cabecera y su columna de ID interno
    const idsDiv = {};
    hojasDiv.forEach((h, i) => {
      const filasDiv = vr[2 + i].values || [];
      const cabDiv = filasDiv[0] || [];
      const j = indicesPorCabecera(cabDiv).iid;
      idsDiv[h] = new Set(
        j < 0 ? [] :
        filasDiv.slice(1).map(f => String(f[j] || "").replace(/^'/, "")).filter(Boolean)
      );
    });
    const av = idsDiv["Avancem"] || new Set();
    const ma = idsDiv["Mademan"] || new Set();

    // Contenido de los análisis IA, indexado por ID interno. La pestaña
    // tiene layout propio: ID, Título, Resumen IA, Análisis solvencia,
    // Fecha análisis, ID interno.
    // Fechas del bot: pueden llegar como serial de Sheets o como ISO string
    const fechaCambio = (v) => {
      if (typeof v === "number") return fechaDeSerial(v);
      const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}`;
      return String(v || "");
    };

    const cambios = [];
    if (hojaCambios) {
      const filasC = vr[2 + hojasDiv.length + (hojaIA ? 1 : 0)].values || [];
      const cabC = filasC[0] || [];
      const posC = {};
      cabC.forEach((h, i) => {
        const k = sinAcentos(h);
        if (k && !(k in posC)) posC[k] = i;
      });
      const jId = posC["id"] ?? -1;
      const jTit = posC["titulo"] ?? -1;
      const jAnt = posC["estado anterior"] ?? -1;
      const jNue = posC["estado nuevo"] ?? -1;
      const jDet = posC["detectado el"] ?? -1;
      const jEnl = posC["enlace"] ?? -1;
      const jIid = posC["id interno"] ?? -1;
      for (const f of filasC.slice(1)) {
        const titulo = jTit >= 0 ? String(f[jTit] || "") : "";
        if (!titulo && !(jId >= 0 && f[jId])) continue;
        cambios.push({
          idLegible: jId >= 0 ? String(f[jId] || "").replace(/^'/, "") : "",
          titulo,
          antes: jAnt >= 0 ? String(f[jAnt] || "") : "",
          despues: jNue >= 0 ? String(f[jNue] || "") : "",
          fecha: jDet >= 0 ? fechaCambio(f[jDet]) : "",
          enlace: jEnl >= 0 ? urlDeFormula(f[jEnl]) : null,
          iid: jIid >= 0 ? String(f[jIid] || "").replace(/^'/, "") : "",
        });
      }
    }

    const analisis = {};
    if (hojaIA) {
      const filasIA = vr[2 + hojasDiv.length].values || [];
      const cabIA = filasIA[0] || [];
      const pos = {};
      cabIA.forEach((h, i) => {
        const k = sinAcentos(h);
        if (k && !(k in pos)) pos[k] = i;
      });
      const jIid = pos["id interno"] ?? -1;
      const jRes = pos["resumen ia"] ?? pos["resumen"] ?? -1;
      const jSol = pos["analisis solvencia"] ?? pos["solvencia"] ?? -1;
      const jFec = pos["fecha analisis"] ?? -1;
      const jTit = pos["titulo"] ?? -1;
      const jId = pos["id"] ?? -1;
      if (jIid >= 0) {
        for (const f of filasIA.slice(1)) {
          const iid = String(f[jIid] || "").replace(/^'/, "");
          if (!iid) continue;
          analisis[iid] = {
            resumen: jRes >= 0 ? String(f[jRes] || "") : "",
            solvencia: jSol >= 0 ? String(f[jSol] || "") : "",
            fecha: jFec >= 0 ? fechaDeSerial(f[jFec]) : "",
            titulo: jTit >= 0 ? String(f[jTit] || "") : "",
            idLegible: jId >= 0 ? String(f[jId] || "").replace(/^'/, "") : "",
          };
        }
      }
    }
    const enAvancem = av;
    const enMademan = ma;
    const layout = idx.organo === 4 ? 26 : 25;

    const filas = [];
    for (const row of lic) {
      const iid = String(val(row, idx.iid) || "").replace(/^'/, "");
      if (!iid) continue;
      const adjuntos = idx.adj
        .map((i, n) => enlaceDeFormula(val(row, i), `Adjunto ${n + 1}`))
        .filter(Boolean);
      /* No dependemos del nombre de la cabecera: si la columna esperada no
         trae nada, se busca en TODA la fila la celda que tenga pares
         "nombre: URL". Es la unica forma fiable, porque esa cabecera no
         esta normalizada entre Sheets de meses distintos. */
      let brutoMas = idx.mas >= 0 ? val(row, idx.mas) : "";
      if (!listaDeMasAdjuntos(brutoMas).length) {
        const usadas = new Set([
          idx.enlace, idx.pcap, idx.ppt, ...idx.adj, idx.iid, idx.id,
        ].filter((n) => n >= 0));
        let mejor = "", mejorN = 0;
        for (let c = 0; c < row.length; c++) {
          if (usadas.has(c)) continue;
          const v = row[c];
          if (typeof v !== "string" || v.length < 40) continue;
          const n = listaDeMasAdjuntos(v).length;
          if (n > mejorN) { mejorN = n; mejor = v; }
        }
        if (mejorN) brutoMas = mejor;
      }
      /* Si la celda es texto plano no hay HYPERLINK que sacar, pero el
         enlace a la ficha del expediente sigue estando en su columna:
         asi el aviso de fallos nunca se queda sin sitio al que mandarte. */
      const masAdj = enlaceDeFormula(brutoMas, "Ver todos en PLACSP")
        || enlaceDeFormula(val(row, idx.enlace), "Ver el expediente en PLACSP");
      /* Los documentos que no caben en las 5 columnas viven aqui como
         texto. Se parsean y se anaden a la lista de adjuntos, sin repetir
         los que ya estan. */
      const yaEstan = new Set(adjuntos.map((a) => a.url));
      for (const extra of listaDeMasAdjuntos(brutoMas)) {
        if (!yaEstan.has(extra.url)) {
          yaEstan.add(extra.url);
          adjuntos.push(extra);
        }
      }
      const div = [];
      if (enAvancem.has(iid)) div.push("avancem");
      if (enMademan.has(iid)) div.push("mademan");
      filas.push({
        id: iid,
        vista: val(row, idx.vista) === true || val(row, idx.vista) === "TRUE",
        importante: val(row, idx.importante) === true || val(row, idx.importante) === "TRUE",
        ...estadoIA(val(row, idx.ia)),
        organo: String(val(row, idx.organo) || ""),
        titulo: String(val(row, idx.titulo) || ""),
        cat: String(val(row, idx.cat) || ""),
        pub: fechaDeSerial(val(row, idx.pub)),
        plazo: fechaDeSerial(val(row, idx.plazo)),
        imp: typeof val(row, idx.imp) === "number" ? val(row, idx.imp) : parseFloat(String(val(row, idx.imp) || "").replace(/[.\s€]/g, "").replace(",", ".")) || 0,
        estado: String(val(row, idx.estado) || ""),
        enlace: urlDeFormula(val(row, idx.enlace)),
        pcap: urlDeFormula(val(row, idx.pcap)),
        ppt: urlDeFormula(val(row, idx.ppt)),
        adj: adjuntos,
        masAdj,
        idLegible: String(val(row, idx.id) || ""),
        fuente: String(val(row, idx.fuente) || ""),
        cpv: String(val(row, idx.cpv) || ""),
        det: fechaDeSerial(val(row, idx.det)),
        punt: val(row, idx.punt) ?? "",
        div,
      });
    }

    const bl = await leerJsonDrive("organismos_blacklist.json");
    const vetados = bl.datos && bl.datos.organismos ? bl.datos.organismos : [];
    const cfg = (await leerJsonDrive("config.json")).datos || {};
    const cpvsAv = (await leerJsonDrive("cpvs_avancem.json")).datos || { exactos: [], familias: [] };
    const cpvsMa = (await leerJsonDrive("cpvs_mademan.json")).datos || { exactos: [], familias: [] };

    // Ventana corta a proposito. Con stale-while-revalidate de 24 h, la
    // primera visita de la mañana recibia la copia de AYER (sin las
    // licitaciones nuevas) y solo veia lo de hoy en la segunda carga; eso
    // se compensaba con el precalentado del bot, ya retirado. Con 10 min,
    // la primera carga del dia lee de verdad: tarda unos segundos mas pero
    // enseña lo que hay. Los cambios PROPIOS no dependen de esto: el panel
    // pide fresco=1 tras escribir.
    const payload = {
      mes, sheet_id: sheetId, layout, analisis, cambios,
      usuario: chk.usuario || null,
      rol: chk.rol || "admin",
      puede_ia: puedeUsarIA(chk),
      meses: meses.map(m => m.mes),
      filas, vetados,
      generado: new Date().toISOString(),
      cfg: {
        coste_minimo: cfg.coste_minimo ?? null,
        coste_maximo: cfg.coste_maximo ?? null,
        destinatarios: cfg.destinatarios_correo || [],
      },
      cpvs: { avancem: cpvsAv, mademan: cpvsMa },
    };
    cachePayload.set(mes, { payload, ts: Date.now() });

    if (forzar) {
      // Respuesta del boton "Recargar": no se cachea en ningun sitio, o el
      // siguiente clic devolveria exactamente lo mismo que acaba de leerse.
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=600");
    }
    res.status(200).json(payload);
  } catch (e) {
    console.error("Fallo en /api/datos:", e);
    res.status(500).json({
      error: String(e.message || e),
      paso: e.paso || "desconocido",
    });
  }
};
