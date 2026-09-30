# Panel AVANCEM — v63 (asistente con n8n, prompts por órgano y rescate)

El panel ya no habla con Anthropic ni descarga pliegos. Recoge la licitación
y los ficheros, bloquea, llama a n8n y enseña el resultado cuando n8n lo deja
en `estado_asistente.json`.

## Qué trae la v63

Va con el flujo `flujo_asincrono.json` de esta misma entrega (nodos de Claude
propios de n8n, memoria de ITER en dos llamadas, rescate y retomar). No lleva
las funciones de Word y Excel en Vercel: n8n monta el .doc y el .xls.

- **Licitación propia.** Botón en el asistente para lo que no llega por la
  hoja (ITER, CERN…): título, órgano y expediente.
- **Subida de varios ficheros a la vez**, PDF y Excel (.xlsx, .xls). Los .zip
  hay que descomprimirlos y los Word guardarlos como PDF.
- **Prompts por órgano en n8n.** ITER tiene prompt propio de memoria en dos
  llamadas (análisis del RFP y redacción); con el resto de acciones se añade
  una tabla de equivalencias de documentos de ITER.
- **Análisis previo descargable** junto a la memoria.
- **Rescate y retomar.** Si algo falla después de pagar una llamada a Claude,
  n8n guarda en la carpeta de la licitación lo ya generado (`rescate_…`). El
  panel enseña esos ficheros junto al error y, si se guardó el análisis,
  ofrece "Retomar desde el análisis guardado": no hay que volver a subir los
  ficheros y solo se paga la redacción. No borres los `rescate_…` mientras
  quieras poder retomar.
- **Estado más fiable.** El panel usa siempre el mismo `estado_asistente.json`
  (el más antiguo si hubiera duplicados). En n8n, `Leer estado`,
  `Actualizar estado` y `Guardar estado` reintentan 3 veces y, si fallan, la
  ejecución sale en rojo con el motivo en vez de fallar en silencio. Si el
  JSON está vacío, se rehace.
- Un análisis colgado se da por fallido a los 60 minutos.

## Carpeta `api/` en el repositorio

Tiene que tener exactamente estos 7 ficheros: `analisis.js`, `archivo.js`,
`datos.js`, `estado.js`, `guardar.js`, `lanzar.js` y `subida.js`. Borra
cualquier otro (`docx.js`, `xlsx.js`, `asistente.js`, `historial.js`,
`pliegos.js`, `subir.js`…): el plan Hobby de Vercel admite como mucho 12.

## n8n: antes de activar el flujo

- **Configuración:** pon el id real en `carpetaTemporal`. Si tu cuenta de
  Anthropic tiene Opus 5.5, puedes cambiar `modeloCaro` a `claude-opus-5-5`.
- **Credencial de Anthropic:** en los nodos `Claude` y `Claude (análisis)`,
  elige tu propia credencial de Anthropic (el crédito gratuito de n8n está
  gastado).
- **Credencial de Google Drive** en los nodos de Drive y HTTP de Drive.

## Orden de montaje

1. **Crea una carpeta en Drive** llamada, por ejemplo, `temporal asistente`,
   con la misma cuenta de Google que usan el panel y n8n. Copia su id (lo que
   va después de `/folders/` en la URL).
2. **Importa `flujo_asincrono.json` en n8n.** Trae tu configuración y tus
   credenciales. En el nodo **Configuración** rellena `carpetaTemporal` con el
   id del paso 1. Genera un token nuevo (el antiguo se vio en el chat) y ponlo
   en `token`.
3. **Activa el flujo** con el interruptor de arriba y copia la **URL de
   producción** del nodo Webhook (no la de test).
4. **Variables en Vercel** (tabla de abajo) y **redespliega**.
5. **Sube este repositorio** y ejecuta `npm install` para regenerar el
   `package-lock.json`.

## Variables de Vercel

| Variable | Valor |
|---|---|
| `N8N_WEBHOOK_URL` | URL de producción del webhook de n8n |
| `N8N_WEBHOOK_TOKEN` | El mismo token del nodo Configuración |
| `DRIVE_CARPETA_TEMPORAL` | Id de la carpeta temporal (paso 1) |
| `DRIVE_CARPETA_RESULTADOS` | El `carpetaRaiz` de n8n: donde crea las carpetas por licitación |

Opcionales: `ASISTENTE_CADUCIDAD_MIN` (60), `SUBIDA_MAX_MB` (100),
`PANEL_ORIGEN` (solo si la subida a Drive falla por origen).

Se siguen usando: `GOOGLE_OAUTH_CONFIG`, `AVANCEM_ROOT_FOLDER_ID`,
`PANEL_KEYS`, `ASISTENTE_USUARIOS`, `PANEL_INGENIEROS`.

Se pueden borrar: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
`ANTHROPIC_WORKSPACE_ID` y cualquier otra `ANTHROPIC_*`, `PLIEGOS_MODO`,
`FIGURAS_*`, `MEMBRETE_*`.

## Prueba de la guía ITER

1. **Licitación propia…** → título, órgano `ITER`, expediente.
2. Sube los PDF y el Excel de la matriz de evaluación.
3. **Redactar memoria técnica.** Tarda más que el resto: son dos llamadas
   seguidas. El resumen debe empezar por "Prompt específico de ITER (dos
   fases: análisis y redacción)", el Word salir en inglés y aparecer también
   el botón para descargar el análisis previo.
4. Pasa la memoria, el análisis previo, los pliegos y
   `prompt_revision_chatgpt.md` al ChatGPT de David.

Con esta versión la memoria puede salir cortada por el límite de salida del
nodo de Claude de n8n. Si pasa, el panel avisa de que faltan las
comprobaciones finales.

## Prueba del rescate

Con poco saldo en Anthropic, la memoria de ITER fallará en la redacción. Debe
aparecer el error con "Se ha agotado el saldo", los ficheros `rescate_…` en la
carpeta de la licitación y el botón de retomar. Recarga saldo y pulsa
Retomar: el resultado debe llegar sin repetir el análisis.

## Pruebas, en este orden

1. **Subir un PDF a mano.** Es la única pieza que no se ha podido probar de
   verdad: depende de que Google acepte la subida directa desde el dominio del
   panel. Si falla, mira la consola del navegador (F12): un error de CORS
   significa que hay que poner `PANEL_ORIGEN` con la URL del panel.
2. **Lanzar Analizar solvencia** (va por Sonnet, es la barata). El panel debe
   pasar a "Analizando desde hace…" y, al terminar, pintar el resumen y el
   botón de descarga sin recargar.
3. **Con el análisis en marcha, abrir el panel en otra pestaña**: debe salir
   "Sistema en uso".
4. **Cerrar la pestaña a mitad** y volver al rato: el resultado tiene que
   estar en el historial.
5. **Comprobar en Drive** que el PDF subido a mano ha desaparecido de la
   carpeta temporal.

## Cómo funciona

- **Bloqueo**: si hay algún análisis en `procesando` de menos de 60 minutos,
  el panel no deja lanzar otro. Pasado ese tiempo se da por muerto (n8n caído)
  y se libera solo, con un aviso en el historial.
- **Ya hecho**: el botón enseña "Hecho el 23/09 · Ver" pero se puede pulsar;
  pide confirmación antes de rehacerlo. Las versiones anteriores quedan en la
  carpeta de la licitación en Drive.
- **Ficheros**: PCAP y PPT van marcados; los anexos que parecen pliego, también.
  Los zip, docx, xml y similares salen como "no se analiza". Si un PDF no
  tiene texto (escaneado o plano), n8n lo apunta y el resultado lo dice.
- **Descargas**: pasan por `/api/archivo`, que valida la clave del panel. Así
  los ingenieros descargan aunque no tengan acceso al Drive de la cuenta.

## Pendiente

- Flujo diario en n8n que vacíe de la carpeta temporal lo que lleve más de 24
  horas (PDF subidos que nadie llegó a analizar).
- El flujo de aviso de errores (`flujo_error.json`) ya no hace falta: los
  fallos normales los apunta el propio flujo y los catastróficos los libera la
  caducidad de 60 minutos.
