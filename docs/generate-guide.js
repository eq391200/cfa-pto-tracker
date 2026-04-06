#!/usr/bin/env node
/**
 * Generate the Gastos onboarding guide as a .docx file.
 * Run: node docs/generate-guide.js
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageBreak, PageNumber
} = require("docx");

// ── Brand Colors ─────────────────────────────────────────────────
const RED = "DD0033";
const NAVY = "004F71";
const LIGHT_BG = "F0F4F8";
const WHITE = "FFFFFF";
const GRAY = "666666";
const ORANGE = "E67E22";
const GREEN = "27AE60";
const BRIGHT_GREEN = "2ECC71";
const ERROR_RED = "E74C3C";
const BADGE_GRAY = "95A5A6";

// ── Reusable Helpers ─────────────────────────────────────────────
const PAGE_WIDTH = 12240;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2; // 9360

const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function heading1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}
function heading2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
}
function para(runs, opts = {}) {
  const children = typeof runs === "string"
    ? [new TextRun(runs)]
    : runs.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ children, ...opts });
}
function bold(text) { return { text, bold: true }; }
function boldRed(text) { return { text, bold: true, color: RED }; }
function boldNavy(text) { return { text, bold: true, color: NAVY }; }
function italic(text) { return { text, italics: true, color: GRAY }; }
function spacer(pts = 120) { return new Paragraph({ spacing: { before: pts } }); }
function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }

function bullet(textOrRuns) {
  const children = typeof textOrRuns === "string"
    ? [new TextRun(textOrRuns)]
    : textOrRuns.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, children });
}
function bullet2(textOrRuns) {
  const children = typeof textOrRuns === "string"
    ? [new TextRun(textOrRuns)]
    : textOrRuns.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ numbering: { reference: "bullets2", level: 0 }, children });
}
function numbered(textOrRuns) {
  const children = typeof textOrRuns === "string"
    ? [new TextRun(textOrRuns)]
    : textOrRuns.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ numbering: { reference: "numbers", level: 0 }, children });
}
function numbered2(textOrRuns) {
  const children = typeof textOrRuns === "string"
    ? [new TextRun(textOrRuns)]
    : textOrRuns.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ numbering: { reference: "numbers2", level: 0 }, children });
}
function numbered3(textOrRuns) {
  const children = typeof textOrRuns === "string"
    ? [new TextRun(textOrRuns)]
    : textOrRuns.map(r => typeof r === "string" ? new TextRun(r) : new TextRun(r));
  return new Paragraph({ numbering: { reference: "numbers3", level: 0 }, children });
}
function nota(text) {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    shading: { fill: "FFF8E1", type: ShadingType.CLEAR },
    indent: { left: 360, right: 360 },
    children: [
      new TextRun({ text: "NOTA: ", bold: true, color: ORANGE }),
      new TextRun(text)
    ]
  });
}
function importante(text) {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    shading: { fill: "FFEBEE", type: ShadingType.CLEAR },
    indent: { left: 360, right: 360 },
    children: [
      new TextRun({ text: "IMPORTANTE: ", bold: true, color: RED }),
      new TextRun(text)
    ]
  });
}
function problema(prob, sol) {
  return [
    new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [
        new TextRun({ text: "PROBLEMA: ", bold: true, color: ERROR_RED }),
        new TextRun(prob)
      ]
    }),
    new Paragraph({
      spacing: { after: 120 },
      indent: { left: 360 },
      children: [
        new TextRun({ text: "SOLUCION: ", bold: true, color: GREEN }),
        new TextRun(sol)
      ]
    })
  ];
}

function makeCell(content, opts = {}) {
  const children = typeof content === "string"
    ? [new Paragraph({ children: [new TextRun(opts.bold ? { text: content, bold: true, color: opts.color } : content)], alignment: opts.align })]
    : [content];
  return new TableCell({
    borders,
    width: { size: opts.width || 2340, type: WidthType.DXA },
    margins: cellMargins,
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined,
    children
  });
}

// ── Build Document ───────────────────────────────────────────────

// COVER PAGE section
const coverSection = {
  properties: {
    page: {
      size: { width: PAGE_WIDTH, height: 15840 },
      margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
    }
  },
  children: [
    spacer(3000),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: "GUIA DE USUARIO", size: 56, bold: true, color: NAVY, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: "Modulo de Gastos", size: 48, bold: true, color: RED, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: RED, space: 12 } },
      spacing: { before: 400, after: 200 },
      children: [new TextRun({ text: "Sistema de Gestion de Facturas", size: 28, color: GRAY, font: "Arial" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({ text: "CFA La Rambla", size: 32, bold: true, color: NAVY, font: "Arial" })]
    }),
    spacer(1200),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Abril 2026  |  Version 1.0", size: 22, color: GRAY })]
    }),
    pageBreak()
  ]
};

// MAIN CONTENT section
const mainChildren = [];

// TOC
mainChildren.push(
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: "TABLA DE CONTENIDO", size: 32, bold: true, color: NAVY })] }),
  new TableOfContents("Tabla de Contenido", { hyperlink: true, headingStyleRange: "1-2" }),
  pageBreak()
);

// ═══════════════ SECTION 1 ═══════════════
mainChildren.push(
  heading1("1. Introduccion"),
  para("El modulo de Gastos es una herramienta integrada en el Admin Hub de CFA La Rambla que automatiza el proceso de entrada de facturas. Combina inteligencia artificial (Claude Vision) para leer facturas automaticamente, un sistema de revision y aprobacion, y un bookmarklet que llena los formularios de Inc. (backoffice.cfahome.com) de manera automatica."),
  spacer(),
  para([bold("Beneficios principales:")]),
  bullet([bold("Eliminacion de entrada manual de datos"), " \u2014 la IA lee las facturas por ti"]),
  bullet("Reduccion de errores en montos, fechas y categorias"),
  bullet("Seguimiento completo del ciclo de vida de cada factura"),
  bullet("Integracion directa con el sistema Inc. de Chick-fil-A"),
  bullet("Exportacion de recibos en PDF con Payment ID para auditoria"),
  pageBreak()
);

// ═══════════════ SECTION 2 ═══════════════
mainChildren.push(
  heading1("2. Acceso al Modulo"),
  heading2("2.1 Requisitos"),
  bullet("Debes tener rol de Administrador en el Admin Hub"),
  bullet([" Navega a la pestana ", bold("\"Gastos\""), " en la barra de navegacion superior (icono de billete)"]),
  bullet("Si no ves la pestana, contacta al administrador del sistema"),
  spacer(),
  heading2("2.2 Vista General"),
  para("Al entrar al modulo veras:"),
  bullet([bold("Barra de estadisticas: "), "Muestra cantidad de facturas por estado (Borradores, Listas, Enviadas, Verificadas) y el monto total"]),
  bullet([bold("Filtros: "), "Filtro de estado y filtro de mes (por fecha de pago)"]),
  bullet([bold("Botones de accion: "), "Subir Factura, Entrada Manual, Bookmarklet, Exportar CSV, Exportar Recibos PDF"]),
  bullet([bold("Tabla de facturas: "), "Lista todas las facturas con su estado, proveedor, numero, fecha, items, total, Payment ID y fecha de creacion"]),
  pageBreak()
);

// ═══════════════ SECTION 3 ═══════════════
mainChildren.push(
  heading1("3. Subir una Factura (OCR con IA)"),
  para([italic("Este es el metodo principal y mas rapido para ingresar facturas.")]),
  spacer(),
  heading2("3.1 Subir Una Sola Factura"),
  numbered([bold("Paso 1: "), "Haz clic en el boton \"Upload Invoice\" (Subir Factura)"]),
  numbered([bold("Paso 2: "), "Selecciona el archivo de la factura (JPG, PNG o PDF)"]),
  numbered([bold("Paso 3: "), "Haz clic en \"Upload & Analyze\" (Subir y Analizar)"]),
  numbered([bold("Paso 4: "), "Espera mientras la IA analiza el documento (veras el icono del robot y un mensaje de progreso)"]),
  numbered([bold("Paso 5: "), "Se abrira la ventana de revision con los datos extraidos"]),
  spacer(),
  heading2("3.2 Subir Multiples Facturas (Carga Masiva)"),
  numbered2([bold("Paso 1: "), "Haz clic en \"Upload Invoice\""]),
  numbered2([bold("Paso 2: "), "Selecciona MULTIPLES archivos (manten presionado Ctrl o Cmd mientras seleccionas)"]),
  numbered2([bold("Paso 3: "), "Haz clic en \"Upload & Analyze\""]),
  numbered2([bold("Paso 4: "), "El sistema procesara cada factura secuencialmente mostrando una barra de progreso"]),
  numbered2([bold("Paso 5: "), "Todas las facturas se guardaran automaticamente como BORRADORES"]),
  numbered2([bold("Paso 6: "), "Al terminar, veras un resumen indicando cuantas se procesaron exitosamente"]),
  numbered2([bold("Paso 7: "), "Revisa y ajusta cada factura individualmente desde la tabla"]),
  nota("La carga masiva es ideal cuando tienes muchas facturas acumuladas. Cada una se guarda como borrador para que puedas revisarlas una por una."),
  pageBreak()
);

// ═══════════════ SECTION 4 ═══════════════
mainChildren.push(
  heading1("4. Revisar Datos Extraidos por la IA"),
  para("Despues de subir una factura individual, se abre la ventana de revision."),
  spacer(),
  heading2("4.1 Campos a Verificar"),
  bullet([bold("Proveedor: "), "La IA intenta emparejar el nombre del proveedor. Si no lo encuentra, seleccionalo manualmente del menu desplegable."]),
  bullet([bold("Numero de Factura: "), "Verifica que sea correcto."]),
  bullet([bold("Fecha de Factura: "), "Verifica la fecha. Se convierte automaticamente al formato correcto."]),
  bullet([bold("Mes de Pago: "), "Se establece automaticamente al mes actual. Ajustalo si la factura corresponde a otro periodo."]),
  spacer(),
  heading2("4.2 Items de Linea"),
  bullet([bold("Categoria de Gasto: "), "La IA sugiere una categoria basada en el historial del proveedor o el contenido de la factura. Hay 164 categorias disponibles \u2014 verifica que la seleccion sea correcta."]),
  bullet([bold("Monto: "), "El monto total de la factura INCLUYENDO impuestos (IVU), envio y recargos."]),
  bullet([bold("Descripcion: "), "Un resumen breve de lo que cubre la factura."]),
  spacer(),
  heading2("4.3 Acciones"),
  bullet([bold("\"+ Add Line\": "), "Agregar una linea adicional si es necesario"]),
  bullet([bold("\"X\" (rojo): "), "Eliminar una linea"]),
  bullet([bold("\"Cancel\": "), "Cancelar sin guardar"]),
  bullet([bold("\"Save Invoice\": "), "Guardar la factura como BORRADOR"]),
  importante("Cada factura se guarda como UNA sola linea. El monto debe ser el TOTAL FINAL de la factura."),
  pageBreak()
);

// ═══════════════ SECTION 5 ═══════════════
mainChildren.push(
  heading1("5. Entrada Manual de Facturas"),
  para([italic("Para facturas que no se pueden escanear o cuando prefieres ingresarlas manualmente.")]),
  spacer(),
  numbered3([bold("Paso 1: "), "Haz clic en \"+ Manual Entry\" (Entrada Manual)"]),
  numbered3([bold("Paso 2: "), "Completa los campos:"]),
  bullet2([bold("Proveedor"), " (requerido)"]),
  bullet2([bold("Numero de Factura"), " (requerido)"]),
  bullet2([bold("Fecha de Factura"), " (requerido)"]),
  bullet2([bold("Fecha de Pago"), " (opcional)"]),
  bullet2([bold("Mes de Pago"), " (opcional pero recomendado)"]),
  bullet2([bold("Moneda"), " (USD por defecto)"]),
  numbered3([bold("Paso 3: "), "Agrega items de linea con categoria, monto y descripcion"]),
  numbered3([bold("Paso 4: "), "Verifica el total calculado automaticamente"]),
  numbered3([bold("Paso 5: "), "Haz clic en \"Save Invoice\" para guardar como borrador"]),
  pageBreak()
);

// ═══════════════ SECTION 6 ═══════════════
mainChildren.push(
  heading1("6. Tabla de Facturas y Estados"),
  heading2("6.1 Columnas de la Tabla"),
  bullet([bold("Estado: "), "Badge de color indicando el estado actual"]),
  bullet([bold("Proveedor: "), "Nombre del proveedor"]),
  bullet([bold("Factura #: "), "Numero de factura"]),
  bullet([bold("Fecha: "), "Fecha de la factura"]),
  bullet([bold("Lineas: "), "Cantidad de items"]),
  bullet([bold("Total: "), "Monto total"]),
  bullet([bold("Payment ID: "), "ID de pago asignado por Inc. (aparece despues de enviar)"]),
  bullet([bold("Creado: "), "Fecha de creacion en el sistema"]),
  bullet([bold("Acciones: "), "Botones de accion"]),
  spacer(),
  heading2("6.2 Estados del Ciclo de Vida"),
  para("Cada factura pasa por estos estados:"),
  spacer(),
);

// Status table
const statusColors = [
  { status: "BORRADOR", color: BADGE_GRAY, desc: "Recien creada, pendiente de revision" },
  { status: "LISTA PARA INC.", color: ORANGE, desc: "Revisada y aprobada, esperando ser enviada al sistema Inc." },
  { status: "ENVIADA A INC.", color: GREEN, desc: "Ya fue ingresada en el sistema Inc. via bookmarklet" },
  { status: "VERIFICADA", color: BRIGHT_GREEN, desc: "Confirmada y cerrada" },
  { status: "ERROR", color: ERROR_RED, desc: "Hubo un problema que requiere atencion" },
];

const headerShading = NAVY;
const statusTableRows = [
  new TableRow({
    children: [
      makeCell(new Paragraph({ children: [new TextRun({ text: "Estado", bold: true, color: WHITE, size: 20 })], alignment: AlignmentType.CENTER }), { width: 2400, shading: headerShading }),
      makeCell(new Paragraph({ children: [new TextRun({ text: "Color", bold: true, color: WHITE, size: 20 })], alignment: AlignmentType.CENTER }), { width: 1400, shading: headerShading }),
      makeCell(new Paragraph({ children: [new TextRun({ text: "Descripcion", bold: true, color: WHITE, size: 20 })]}), { width: 5560, shading: headerShading }),
    ]
  })
];
for (const s of statusColors) {
  statusTableRows.push(new TableRow({
    children: [
      makeCell(s.status, { width: 2400, bold: true }),
      makeCell(new Paragraph({ children: [new TextRun({ text: "\u25CF", color: s.color, size: 28 })], alignment: AlignmentType.CENTER }), { width: 1400 }),
      makeCell(s.desc, { width: 5560 }),
    ]
  }));
}
mainChildren.push(
  new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [2400, 1400, 5560],
    rows: statusTableRows
  }),
  spacer(),
  heading2("6.3 Acciones Disponibles"),
  bullet([bold("Ojo (Ver Detalle): "), "Abre la vista completa de la factura"]),
  bullet([bold("\"Ready\" (naranja): "), "Aparece solo en borradores y verificadas \u2014 marca la factura como lista para enviar a Inc."]),
  bullet([bold("Papelera (Eliminar): "), "Elimina la factura permanentemente (requiere confirmacion)"]),
  pageBreak()
);

// ═══════════════ SECTION 7 ═══════════════
mainChildren.push(
  heading1("7. Vista de Detalle de Factura"),
  para("Haz clic en el icono del ojo para ver todos los detalles de una factura."),
  spacer(),
  heading2("7.1 Informacion Mostrada"),
  bullet("Proveedor, estado, fechas, periodo, moneda, total"),
  bullet("Si fue enviada a Inc. (Si/No)"),
  bullet("Payment ID (en verde si existe, \"No asignado\" si no)"),
  bullet("Notas adicionales"),
  bullet("Tabla de items de linea con categoria, descripcion y monto"),
  spacer(),
  heading2("7.2 Editar Payment ID"),
  para("En la parte inferior de la vista de detalle hay un campo para ingresar o actualizar el Payment ID:"),
  numbered([bold("Paso 1: "), "Escribe el Payment ID en el campo de texto"]),
  numbered([bold("Paso 2: "), "Haz clic en \"Save\" (verde)"]),
  numbered([bold("Paso 3: "), "El Payment ID se guardara y aparecera en la tabla principal"]),
  nota("Esto es util para agregar el Payment ID a facturas que ya fueron enviadas antes de que existiera esta funcion."),
  spacer(),
  heading2("7.3 Cambiar Estado"),
  para("Debajo del Payment ID hay un control para cambiar el estado:"),
  numbered2([bold("Paso 1: "), "Selecciona el nuevo estado del menu desplegable"]),
  numbered2([bold("Paso 2: "), "Haz clic en \"Update\""]),
  numbered2([bold("Paso 3: "), "El estado se actualiza inmediatamente"]),
  pageBreak()
);

// ═══════════════ SECTION 8 ═══════════════
mainChildren.push(
  heading1("8. El Bookmarklet \u2014 Envio Automatico a Inc."),
  para("El bookmarklet es una herramienta que automatiza el llenado de formularios en el sitio web de Inc. (backoffice.cfahome.com)."),
  spacer(),
  heading2("8.1 Instalacion del Bookmarklet"),
  numbered([bold("Paso 1: "), "Haz clic en \"Bookmarklet\" en la barra de herramientas de Gastos"]),
  numbered([bold("Paso 2: "), "Arrastra el boton rojo \"Fill from Gastos\" a tu barra de marcadores del navegador"]),
  numbered([bold("Paso 3: "), "El bookmarklet queda instalado y listo para usar"]),
  nota("El bookmarklet incluye un token de autenticacion que expira en 24 horas. Si recibes un error de token, regenera el bookmarklet desde la pestana de Gastos."),
  spacer(),
  heading2("8.2 Preparacion"),
  para("Antes de usar el bookmarklet:"),
  numbered2([bold("1. "), "Asegurate de tener al menos una factura con estado \"Lista para Inc.\" (naranja)"]),
  numbered2([bold("2. "), "Inicia sesion en backoffice.cfahome.com"]),
  numbered2([bold("3. "), "Navega a la pagina principal de gastos del sitio Inc."]),
  spacer(),
  heading2("8.3 Flujo de Uso (3 Paginas)"),
  spacer(),
  para([boldNavy("PAGINA 1 \u2014 Seleccion de Proveedor y Mes:")]),
  numbered3("Estando en la pagina principal de Inc., haz clic en el bookmarklet"),
  numbered3("Aparece un panel con los datos de la proxima factura lista"),
  numbered3("Revisa la informacion mostrada (proveedor, factura, fecha, total)"),
  numbered3([" Haz clic en ", bold("\"Select Supplier & Continue\"")]),
  numbered3("El bookmarklet selecciona automaticamente el proveedor y mes de pago"),
  numbered3("La pagina navega automaticamente a la siguiente"),
  spacer(),
  para([boldNavy("PAGINA 4 \u2014 Numero y Fecha de Factura:")]),
  numbered([" Haz clic en el bookmarklet nuevamente"]),
  numbered("El panel muestra: \"Pagina 4: Llenara numero de factura y fecha\""),
  numbered([" Haz clic en ", bold("\"Fill Header & Continue\"")]),
  numbered("El bookmarklet llena el numero de factura y la fecha"),
  numbered("La pagina navega a la siguiente"),
  spacer(),
  para([boldNavy("PAGINA 5 \u2014 Items de Linea:")]),
  numbered2("Haz clic en el bookmarklet nuevamente"),
  numbered2("Para cada item de linea: el panel muestra la categoria, descripcion y monto; los campos se llenan automaticamente"),
  numbered2([" Haz clic en ", bold("\"Save Detail & Fill Next\""), " (o \"Save Last Detail\" para el ultimo)"]),
  numbered2("Espera 2 segundos mientras se guarda"),
  numbered2([" Despues del ultimo item, haz clic en ", bold("\"Save & Mark Submitted\"")]),
  numbered2("La factura se marca como enviada en nuestro sistema"),
  numbered2("La pagina de Inc. se actualiza"),
  spacer(),
  heading2("8.4 Captura del Payment ID"),
  para("Despues de enviar la factura en Inc., el sistema genera un Payment ID:"),
  numbered3("Haz clic en el bookmarklet una vez mas en la pagina resultante"),
  numbered3("El bookmarklet intentara detectar automaticamente el Payment ID en la pagina"),
  numbered3("Si lo encuentra, lo guarda automaticamente y muestra una notificacion verde"),
  numbered3("Si no lo encuentra, te pedira que lo ingreses manualmente en un campo de texto"),
  numbered3("Haz clic en \"Save Payment ID\" o \"Skip\" si no lo tienes"),
  importante("El Payment ID se estampa en los recibos exportados como PDF, lo cual es esencial para auditoria."),
  pageBreak()
);

// ═══════════════ SECTION 9 ═══════════════
mainChildren.push(
  heading1("9. Filtros y Busqueda"),
  heading2("9.1 Filtro de Estado"),
  para("Selecciona del menu desplegable:"),
  bullet("Todos los Estados"),
  bullet("Borrador"),
  bullet("Lista para Inc."),
  bullet("Enviada"),
  bullet("Verificada"),
  bullet("Error"),
  para("La tabla y las estadisticas se actualizan inmediatamente."),
  spacer(),
  heading2("9.2 Filtro de Mes"),
  para("Selecciona el mes del menu desplegable (muestra los ultimos 12 meses)."),
  importante("Este filtro se basa en la FECHA DE PAGO de la factura, no en la fecha de la factura."),
  spacer(),
  heading2("9.3 Actualizacion Automatica"),
  para("La tabla se actualiza automaticamente cuando regresas a la pestana de Gastos despues de usar otra pestana o el bookmarklet en otra ventana."),
  pageBreak()
);

// ═══════════════ SECTION 10 ═══════════════
mainChildren.push(
  heading1("10. Exportaciones"),
  heading2("10.1 Exportar CSV"),
  bullet([" Haz clic en ", bold("\"Export CSV\"")]),
  bullet("Se descarga un archivo con todas las facturas y sus detalles"),
  bullet("Incluye: Numero de factura, fechas, periodo, moneda, total, estado, Payment ID, proveedor, descripcion, monto por linea y categoria"),
  bullet("Util para reportes en Excel"),
  spacer(),
  heading2("10.2 Exportar Recibos PDF"),
  bullet([" Haz clic en ", bold("\"Export Receipts PDF\"")]),
  bullet("Se genera un PDF que combina todos los recibos/facturas originales subidas"),
  bullet("Si la factura tiene un Payment ID, se estampa en la esquina inferior derecha de cada pagina"),
  bullet([bold("RESPETA los filtros activos: "), "Si tienes seleccionado un mes o estado especifico, solo se exportan esas facturas"]),
  bullet("Ideal para auditoria y archivo fisico"),
  pageBreak()
);

// ═══════════════ SECTION 11 ═══════════════
mainChildren.push(
  heading1("11. Flujo de Trabajo Recomendado"),
  para([italic("Para maximizar eficiencia, te recomendamos seguir este flujo:")]),
  spacer(),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "1. RECOPILAR", bold: true, color: NAVY, size: 24 })]
  }),
  para("Acumula las facturas del periodo (fotos o PDFs)"),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "2. SUBIR", bold: true, color: NAVY, size: 24 })]
  }),
  para("Usa la carga masiva para subir todas las facturas a la vez. Todas se guardaran como borradores."),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "3. REVISAR", bold: true, color: NAVY, size: 24 })]
  }),
  para("Abre cada borrador y verifica: proveedor correcto, monto total correcto (incluyendo impuestos), categoria de gasto apropiada, y mes de pago correcto."),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "4. MARCAR LISTA", bold: true, color: NAVY, size: 24 })]
  }),
  para("Una vez verificada, haz clic en \"Ready\" para marcarla como lista."),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "5. ENVIAR A INC.", bold: true, color: NAVY, size: 24 })]
  }),
  para("Abre Inc. (backoffice.cfahome.com) y usa el bookmarklet para enviar cada factura."),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "6. CAPTURAR PAYMENT ID", bold: true, color: NAVY, size: 24 })]
  }),
  para("Despues de cada envio, el bookmarklet captura el Payment ID automaticamente."),
  spacer(80),
  new Paragraph({
    spacing: { before: 200, after: 60 },
    shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
    indent: { left: 240, right: 240 },
    children: [new TextRun({ text: "7. EXPORTAR", bold: true, color: NAVY, size: 24 })]
  }),
  para("Al final del periodo, exporta los recibos como PDF para archivo."),
  pageBreak()
);

// ═══════════════ SECTION 12 ═══════════════
mainChildren.push(
  heading1("12. Solucion de Problemas"),
  ...problema(
    "\"Error: Not authenticated\" al subir factura",
    "Tu sesion expiro. Recarga la pagina e inicia sesion nuevamente."
  ),
  ...problema(
    "El bookmarklet muestra \"Invalid or expired token\"",
    "El token expira cada 24 horas. Ve a la pestana Gastos, haz clic en \"Bookmarklet\", y arrastra el nuevo boton a tus marcadores."
  ),
  ...problema(
    "La IA no reconoce el proveedor",
    "Selecciona el proveedor manualmente del menu desplegable en la ventana de revision."
  ),
  ...problema(
    "El monto extraido es incorrecto",
    "Edita el monto manualmente en la ventana de revision. La IA a veces confunde subtotales con totales."
  ),
  ...problema(
    "El bookmarklet no detecta la pagina de Inc.",
    "Asegurate de estar en backoffice.cfahome.com. Navega a la pagina correcta y haz clic en el bookmarklet de nuevo."
  ),
  ...problema(
    "No aparece el boton \"Ready\" en la tabla",
    "El boton solo aparece para facturas en estado \"Borrador\" o \"Verificada\"."
  ),
  ...problema(
    "El Payment ID no se captura automaticamente",
    "El bookmarklet te dara la opcion de ingresarlo manualmente. Tambien puedes agregarlo despues desde la vista de detalle de la factura."
  ),
  ...problema(
    "El filtro de mes no muestra mis facturas",
    "El filtro se basa en la FECHA DE PAGO. Verifica que la factura tenga una fecha de pago asignada que corresponda al mes seleccionado."
  ),
  pageBreak()
);

// ═══════════════ SECTION 13 ═══════════════
const glossaryTerms = [
  ["Admin Hub", "Portal de administracion del restaurante CFA La Rambla"],
  ["Bookmarklet", "Acceso directo en el navegador que ejecuta codigo para automatizar tareas"],
  ["Claude Vision", "Inteligencia artificial de Anthropic que puede leer y analizar imagenes de documentos"],
  ["Inc.", "Sistema corporativo de Chick-fil-A para gestion de gastos (backoffice.cfahome.com)"],
  ["IVU", "Impuesto sobre Ventas y Uso de Puerto Rico"],
  ["OCR", "Reconocimiento Optico de Caracteres \u2014 tecnologia que convierte imagenes en texto"],
  ["Oracle APEX", "Plataforma tecnologica del sistema Inc."],
  ["Payment ID", "Identificador unico asignado por el sistema Inc. al registrar un pago"],
  ["Periodo de Pago", "El mes al que se asigna el gasto para propositos contables"],
];

const glossaryRows = [
  new TableRow({
    children: [
      makeCell(new Paragraph({ children: [new TextRun({ text: "Termino", bold: true, color: WHITE, size: 20 })]}), { width: 2600, shading: NAVY }),
      makeCell(new Paragraph({ children: [new TextRun({ text: "Definicion", bold: true, color: WHITE, size: 20 })]}), { width: 6760, shading: NAVY }),
    ]
  })
];
for (const [term, def] of glossaryTerms) {
  glossaryRows.push(new TableRow({
    children: [
      makeCell(term, { width: 2600, bold: true }),
      makeCell(def, { width: 6760 }),
    ]
  }));
}

mainChildren.push(
  heading1("13. Glosario"),
  spacer(),
  new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [2600, 6760],
    rows: glossaryRows
  })
);

const mainSection = {
  properties: {
    page: {
      size: { width: PAGE_WIDTH, height: 15840 },
      margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }
    }
  },
  headers: {
    default: new Header({
      children: [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RED, space: 4 } },
          spacing: { after: 120 },
          children: [
            new TextRun({ text: "CFA La Rambla \u2014 Guia de Gastos", size: 18, color: NAVY, italics: true })
          ]
        })
      ]
    })
  },
  footers: {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          border: { top: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD", space: 4 } },
          children: [
            new TextRun({ text: "Pagina ", size: 18, color: GRAY }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GRAY }),
            new TextRun({ text: "  |  Modulo de Gastos v1.0  |  Abril 2026", size: 18, color: GRAY })
          ]
        })
      ]
    })
  },
  children: mainChildren
};

// ── Assemble Document ────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Arial", size: 22 } }  // 11pt default
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: NAVY },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RED, space: 6 } }
        }
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: NAVY },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 }
      },
    ]
  },
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
      {
        reference: "bullets2",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2013", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }]
      },
      {
        reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
      {
        reference: "numbers2",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
      {
        reference: "numbers3",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
    ]
  },
  sections: [coverSection, mainSection]
});

// ── Write File ───────────────────────────────────────────────────
const outPath = path.join(__dirname, "Guia-Gastos-CFA-La-Rambla.docx");
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer);
  console.log("Document created:", outPath);
  console.log("Size:", (buffer.length / 1024).toFixed(1), "KB");
});
