const { getClients, checkKey, rechazar, leerJsonDrive, escribirJsonDrive, registrarLog } = require("../lib/google");

const HOJAS = ["Licitaciones", "Importantes"];
const CAMPOS = ["vista", "importante", "ia"];

function letraCol(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s || "A";
}

const sinAcentos = (s) =>
  String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// Localizamos las columnas por el TEXTO de la cabecera, igual que /api/datos:
// contar columnas engaña (las hojas traen 26 por defecto aunque usen 25).
function indicesPorCabecera(cab) {
  const pos = {};
  (cab || []).forEach((h, i) => {
    const k = sinAcentos(h);
    if (k && !(k in pos)) pos[k] = i;
  });
  const claves = Object.keys(pos);
  const buscar = (alts) => {
    for (const a of alts) if (a in pos) return pos[a];
    for (const a of alts) {
      const k = claves.find((x) => x.startsWith(a));
      if (k !== undefined) return pos[k];
    }
    return -1;
  };
  return {
    // A, B y C son fijas por estructura. La C1 no dice "Análisis IA": el bot
    // le escribe una fórmula HYPERLINK, así que por cabecera no aparece.
    vista: buscar(["vista"]) >= 0 ? buscar(["vista"]) : 0,
    importante: buscar(["importante", "import"]) >= 0 ? buscar(["importante", "import"]) : 1,
    ia: buscar(["analisis ia", "analisis"]) >= 0 ? buscar(["analisis ia", "analisis"]) : 2,
    iid: buscar(["id interno"]),
  };
}

// Igual que _norm en filtro_organismos.py: solo el sufijo de país, nunca
// cualquier paréntesis final (rompía los organismos con acrónimo).
const SUFIJO_PAIS = /\s*\((?:espa[nñ]a|spain)\)\s*$/i;

function norm(s) {
  return String(s || "")
    .replace(SUFIJO_PAIS, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const chk = checkKey(req);
  if (!chk.ok) {
    console.warn(`[panel] clave rechazada (${chk.motivo})`);
    return rechazar(res, chk);
  }
  const quien = chk.usuario || "?";
  const { sheet_id, cambios } = req.body || {};
  if (!sheet_id || !Array.isArray(cambios) || !cambios.length)
    return res.status(400).json({ error: "faltan sheet_id o cambios" });

  /* Los ingenieros solo escriben la casilla de analisis IA. Vista,
     Importante, vetos y configuracion quedan fuera. Se corta aqui y no
     solo en la interfaz, porque esconder una casilla no es una barrera. */
  if (chk.rol === "ingeniero") {
    const prohibidos = cambios.filter((c) => c.campo !== "ia");
    if (prohibidos.length) {
      return res.status(403).json({
        error: "Tu usuario solo puede marcar licitaciones para análisis IA",
      });
    }
  }

  try {
    const { sheets } = getClients();
    const resumen = {};
    for (const c of cambios || []) {
      const k = c.campo === "veto_anadir" ? "veta"
        : c.campo === "veto_quitar" ? "desveta"
        : String(c.campo).startsWith("cfg:") ? "config"
        : `${c.campo}=${c.valor ? "si" : "no"}`;
      resumen[k] = (resumen[k] || 0) + 1;
    }
    const detalle = Object.entries(resumen).map(([k, n]) => `${k}x${n}`).join(" ");
    const bitacora = [`${quien}  ${(cambios || []).length} cambio(s)  ${detalle}`];
    console.log(`[panel] ${bitacora[0]}`);

    // Los vetos y la configuracion, con detalle: son las acciones que mas
    // cuesta deshacer si alguien se equivoca. Y las marcas de Importante,
    // porque el resumen "importante=sixN" no dice CUAL se marco.
    for (const c of cambios || []) {
      if (c.campo === "veto_anadir") bitacora.push(`${quien}  VETA: ${c.valor}`);
      if (c.campo === "veto_quitar") bitacora.push(`${quien}  DESVETA: ${c.valor}`);
      if (c.campo === "importante") {
        const que = c.titulo ? String(c.titulo).slice(0, 90) : `(sin título) id ${c.id}`;
        bitacora.push(
          `${quien}  ${c.valor ? "MARCA IMPORTANTE" : "QUITA IMPORTANTE"}: ${que}`
        );
      }
      if (String(c.campo).startsWith("cfg:")) {
        bitacora.push(`${quien}  CONFIG ${c.campo.slice(4)} = ${c.valor}`);
      }
    }

    const casillas = cambios.filter(c => CAMPOS.includes(c.campo));
    const blAnadir = cambios.filter(c => c.campo === "veto_anadir").map(c => c.valor);
    const blQuitar = cambios.filter(c => c.campo === "veto_quitar").map(c => c.valor);
    const cfgCambios = cambios.filter(c => c.campo.startsWith("cfg:"));

    if (casillas.length) {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: sheet_id,
        fields: "sheets(properties(title,gridProperties(columnCount)))",
      });
      const anchos = {};
      for (const h of meta.data.sheets) {
        anchos[h.properties.title] = h.properties.gridProperties.columnCount || 25;
      }
      const hojas = HOJAS.filter(h => anchos[h] !== undefined);

      // 1) cabeceras de cada pestaña
      const rCab = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheet_id,
        ranges: hojas.map(h => `'${h}'!A1:${letraCol(anchos[h])}1`),
      });
      const idxPorHoja = {};
      rCab.data.valueRanges.forEach((vr, i) => {
        idxPorHoja[hojas[i]] = indicesPorCabecera((vr.values || [[]])[0] || []);
      });

      const utiles = hojas.filter(h => idxPorHoja[h].iid >= 0);
      if (!utiles.length) {
        return res.status(500).json({
          error: "No encuentro la columna 'ID interno' en ninguna pestaña",
        });
      }

      // 2) columna de ID interno de cada pestaña, ya en su posición real
      const rId = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheet_id,
        ranges: utiles.map(h => {
          const L = letraCol(idxPorHoja[h].iid + 1);
          return `'${h}'!${L}2:${L}`;
        }),
      });
      const mapas = {};
      rId.data.valueRanges.forEach((vr, i) => {
        const m = new Map();
        (vr.values || []).forEach((row, j) => {
          const v = String(row[0] || "").replace(/^'/, "");
          if (v) m.set(v, j + 2);
        });
        mapas[utiles[i]] = m;
      });

      const data = [];
      for (const c of casillas) {
        for (const h of utiles) {
          const fila = mapas[h].get(String(c.id));
          const col = idxPorHoja[h][c.campo];
          if (fila && col >= 0) {
            data.push({
              range: `'${h}'!${letraCol(col + 1)}${fila}`,
              values: [[!!c.valor]],
            });
          }
        }
      }
      if (data.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheet_id,
          requestBody: { valueInputOption: "USER_ENTERED", data },
        });
      }
    }

    if (blAnadir.length || blQuitar.length) {
      const bl = await leerJsonDrive("organismos_blacklist.json");
      let lista = (bl.datos && bl.datos.organismos) || [];
      const quitar = new Set(blQuitar.map(norm));
      lista = lista.filter(o => !quitar.has(norm(o)));
      const vistos = new Set(lista.map(norm));
      for (const o of blAnadir) {
        const limpio = String(o).replace(/\s*\(España\)\s*$/, "").replace(/\s+/g, " ").trim();
        if (limpio && !vistos.has(norm(limpio))) { vistos.add(norm(limpio)); lista.push(limpio); }
      }
      await escribirJsonDrive("organismos_blacklist.json", { organismos: lista });
    }

    for (const c of cfgCambios) {
      const [, fichero, op] = c.campo.split(":");
      if (fichero === "general") {
        const cfg = (await leerJsonDrive("config.json")).datos || {};
        if (op === "coste_minimo" || op === "coste_maximo") cfg[op] = c.valor;
        if (op === "dest_anadir") cfg.destinatarios_correo = [...new Set([...(cfg.destinatarios_correo || []), c.valor])];
        if (op === "dest_quitar") cfg.destinatarios_correo = (cfg.destinatarios_correo || []).filter(d => d !== c.valor);
        await escribirJsonDrive("config.json", cfg);
      } else {
        const nombre = fichero === "avancem" ? "cpvs_avancem.json" : "cpvs_mademan.json";
        const cpvs = (await leerJsonDrive(nombre)).datos || { exactos: [], familias: [] };
        const [tipo, accion] = op.split("_");
        cpvs[tipo] = cpvs[tipo] || [];
        if (accion === "anadir" && !cpvs[tipo].includes(c.valor)) cpvs[tipo].push(c.valor);
        if (accion === "quitar") cpvs[tipo] = cpvs[tipo].filter(x => x !== c.valor);
        await escribirJsonDrive(nombre, cpvs);
      }
    }

    await registrarLog(bitacora);
    res.status(200).json({ ok: true, aplicados: cambios.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
