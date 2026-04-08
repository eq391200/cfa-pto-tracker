/**
 * Social Media Post Automation Module
 *
 * Generates on-brand IG posts using Claude API.
 * Endpoints: generate, photo upload, history, icons, brand config.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { logApiCall, checkBudget } = require('../services/apiCostTracker');

// ── Photo Upload Config ────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'social-photos');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── AI Image Generation Config ────────────────────────────────────
const NANOBANANA_DIR = path.join(__dirname, '..', '..', 'nanobanana-output');
const GEMINI_PATH = process.env.GEMINI_PATH || '/opt/homebrew/bin/gemini';
if (!fs.existsSync(NANOBANANA_DIR)) fs.mkdirSync(NANOBANANA_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Solo se permiten archivos JPEG, PNG o WEBP'));
  }
});

// ── Helper: Get brand config as object ─────────────────────────────
function getBrandConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM social_brand_config').all();
  const config = {};
  for (const r of rows) config[r.key] = r.value;
  return config;
}

// ── Helper: Get icon manifest ──────────────────────────────────────
function getIconManifest() {
  const db = getDb();
  return db.prepare('SELECT id, name, category, tags, compatible_types FROM social_icons WHERE active = 1').all()
    .map(i => ({ ...i, tags: JSON.parse(i.tags || '[]'), compatible_types: JSON.parse(i.compatible_types || '[]') }));
}

// ── Helper: Get product photo catalog ─────────────────────────────
function getProductPhotoCatalog() {
  const db = getDb();
  try {
    return db.prepare('SELECT id, name, category, tags, file_path FROM social_product_photos WHERE active = 1').all()
      .map(p => ({ ...p, tags: JSON.parse(p.tags || '[]') }));
  } catch (e) { return []; }
}

// ── Helper: Call Claude API ────────────────────────────────────────
async function callClaude(formData, brandConfig, iconManifest, productPhotos) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  // Build icon manifest for prompt (id + tags only)
  const iconList = iconManifest.map(i => `- ${i.id} [${i.category}]: ${i.tags.join(', ')}`).join('\n');

  // Build product photo catalog for prompt
  const photoList = (productPhotos || [])
    .filter(p => p.category !== 'social') // exclude story templates from auto-selection
    .map(p => `- ID:${p.id} "${p.name}" [${p.category}] tags: ${p.tags.join(', ')} → ${p.file_path}`)
    .join('\n');

  const ctaOptions = JSON.parse(brandConfig.cta_options || '[]');
  const forbiddenWords = JSON.parse(brandConfig.forbidden_words || '[]');

  const systemPrompt = `Eres un director creativo y copywriter de redes sociales para ${brandConfig.brand_name}, un restaurante de pollo en Puerto Rico.

VOZ DE MARCA: ${brandConfig.brand_voice}

IDENTIDAD VISUAL DE MARCA (basada en @chickfila_larambla Instagram):
- Colores: CFA Red (#DD0033), Navy (#004F71), Blanco, Gris (#999) para subtexto
- Tipografía: Apercu (Bold para headlines, Medium para subtítulos, Regular para cuerpo)
- Estilo: Limpio, editorial, generoso espacio en blanco. Menos es más.
- Personalidad: Cálido pero profesional, premium pero accesible.
- REGLA OBLIGATORIA: El fondo SIEMPRE debe ser blanco (#FFFFFF). Los colores (Red, Navy) se usan SOLO como capas de acento sutiles: líneas finas, bordes, badges, botones pill. NUNCA fondos completos de color.
- CTAs siempre en botón pill (border-radius redondeado) rojo con texto blanco.
- Fotos de producto: tamaño moderado, centradas, con drop-shadow sutil. NUNCA enormes.
- Logo CFA: pequeño, consistente — centrado arriba para posts de producto, esquina inferior-izquierda para informativos.
- Subtextos en gris (#999) con letter-spacing amplio para variantes de producto (estilo dot-separated).

REGLAS ESTRICTAS DE COPY:
- Todo el copy debe estar escrito EXCLUSIVAMENTE en español. No uses inglés en ningún campo.
- Nunca uses estas palabras: ${forbiddenWords.join(', ')}
- El headline debe ser impactante, corto y en mayúsculas (estilo editorial).
- El subheadline incluye fecha y hora del evento/promoción si aplica.
- El body_copy es descriptivo, cálido y orientado a la acción.
- El cta_text es un llamado a la acción corto.
- El disclaimer es texto legal pequeño que resume las condiciones.

OPCIONES DE CTA SUGERIDAS: ${ctaOptions.join(', ')}

DIRECCIÓN CREATIVA — LAYOUT STYLES:
Debes elegir uno de estos estilos de layout para cada post. Varía el estilo según el tipo de contenido:

1. "hero-banner" — Fondo blanco, logo arriba-izquierda, headline rojo grande, línea roja fina como divisor. CTA en botón pill rojo. Generoso espacio en blanco. Ideal para anuncios fuertes.
2. "split-diagonal" — Fondo blanco con tenue wash diagonal rojo (6% opacidad) + línea diagonal fina. Logo arriba-izquierda. Dinámico y moderno. CTA en botón pill.
3. "accent-frame" — Borde rojo fino (10px) enmarca el post. Interior blanco, logo centrado arriba. Elegant y limpio, bueno para eventos.
4. "photo-dominant" — Logo centrado arriba, headline rojo centrado, subtexto gris, foto de producto centrada con drop-shadow. CTA en botón pill. Solo usar cuando hay foto. Estilo editorial @chickfila_larambla.
5. "bold-type" — Sin foto. Logo arriba-izquierda pequeño. Headline GIGANTE en rojo. Línea fina roja. CTA en pill. Impacto tipográfico puro. Mensajes cortos y poderosos.
6. "icon-showcase" — Logo centrado arriba. Iconos CFA prominentes entre líneas rojas finas. Headline y body centrados. CTA en pill. Bueno para menú.
7. "navy-elegance" — Fondo blanco, líneas navy+roja finas en top. Logo centrado. Headline navy, CTA en botón navy pill. Premium. Eventos especiales.
8. "minimal-red" — Línea roja vertical fina (8px) en el borde izquierdo. Logo arriba-izquierda pequeño. Ultra limpio, mucho whitespace.
9. "warm-product" — Estilo @chickfila_larambla: logo centrado arriba, headline rojo grande, subtexto gris con letter-spacing. Foto centrada moderada con drop-shadow. Badge circular "POR TIEMPO LIMITADO" con borde rojo (no relleno). CTA en pill rojo. Ideal para LTOs y productos.
10. "event-calendar" — Estilo @chickfila_larambla: logo centrado, líneas navy+roja finas como separador. Headline navy centrado. Body estructurado con bullets rojos pequeños. CTA en pill rojo. Perfecto para eventos y calendarios.

Elige el layout que mejor se adapte al contenido. NO repitas siempre el mismo layout.
REGLA ESPECIAL: Para posts de tipo "lto" o que mencionan productos nuevos/limitados, prefiere "warm-product" o "photo-dominant".
REGLA ESPECIAL: Para posts de tipo "community-event" o calendarios, prefiere "event-calendar".

${iconList.length > 0 ? `BIBLIOTECA DE ICONOS DISPONIBLES (103 iconos CFA oficiales):\n${iconList}\n\nSelecciona 2-3 iconos apropiados del listado que complementen visualmente el post. Devuelve sus IDs exactos en "suggested_icons".` : 'No hay iconos disponibles actualmente.'}

${photoList.length > 0 ? `BIBLIOTECA DE FOTOS DE PRODUCTO DISPONIBLES:\n${photoList}\n\nSELECCIÓN AUTOMÁTICA DE FOTO: Si el usuario NO subió una foto manualmente, DEBES seleccionar la foto de producto más relevante basándote en el contenido del post. Devuelve el file_path exacto en "suggested_photo". Si el usuario ya subió una foto, devuelve null en "suggested_photo".` : ''}

FORMATO INSTAGRAM:
- headline max 50 chars, subheadline max 80, body max 120, cta max 30

Responde ÚNICAMENTE con un objeto JSON válido. Sin preámbulo, sin markdown, sin backticks.`;

  const hasUserPhoto = !!formData.photo_url;

  const userPrompt = `Genera el draft de Instagram para un post de tipo "${formData.post_type}".

DATOS DEL FORMULARIO:
- Título/Nombre del evento: ${formData.headline}
- Detalle clave: ${formData.key_detail || 'N/A'}
- Contexto del evento/promoción: ${formData.context || 'N/A'}
- Tono: ${formData.tone || 'default'}
- CTA preferido: ${formData.cta || 'Automático'}
- Formato Instagram: ${formData.ig_format === 'ig-portrait' ? '4:5 Portrait (1080×1350)' : '1:1 Square (1080×1080)'}
- Foto subida por usuario: ${hasUserPhoto ? 'SÍ (usar la foto del usuario, no sugerir otra)' : 'NO (selecciona la foto de producto más relevante de la biblioteca)'}

Genera el JSON con esta estructura exacta:
{
  "instagram_draft": {
    "headline": "string",
    "subheadline": "string o null",
    "body_copy": "string o null",
    "cta_text": "string",
    "suggested_icons": ["icon-id-1", "icon-id-2"],
    "disclaimer": "string con condiciones legales",
    "layout_style": "uno de: hero-banner, split-diagonal, accent-frame, photo-dominant, bold-type, icon-showcase, navy-elegance, minimal-red, warm-product, event-calendar"
  },
  "suggested_photo": "${hasUserPhoto ? 'null (usuario ya subió foto)' : 'file_path de la foto más relevante de la biblioteca, o null si ninguna aplica'}"
}`;

  // Budget check before making API call
  const budgetCheck = checkBudget('anthropic');
  if (!budgetCheck.allowed) {
    throw new Error('API budget limit reached: ' + budgetCheck.reason);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    logApiCall({ service: 'anthropic', endpoint: 'social-post-generate', model: 'claude-sonnet-4-20250514', status: 'error', errorMessage: `HTTP ${response.status}` });
    throw new Error(`Claude API error ${response.status}: ${errBody}`);
  }

  const result = await response.json();

  // Log API usage & cost
  logApiCall({
    service: 'anthropic', endpoint: 'social-post-generate',
    inputTokens: result.usage?.input_tokens || 0,
    outputTokens: result.usage?.output_tokens || 0,
    model: 'claude-sonnet-4-20250514', status: 'success'
  });

  const text = result.content?.[0]?.text || '';

  // Parse JSON from response (handle potential markdown wrapping)
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);

  // Validate required fields
  if (!parsed.instagram_draft) {
    throw new Error('Claude response missing instagram_draft');
  }
  const draft = parsed.instagram_draft;
  if (!draft.headline || !draft.cta_text) {
    throw new Error('instagram_draft missing headline or cta_text');
  }
  // Validate icon IDs exist
  if (draft.suggested_icons && iconManifest.length > 0) {
    const validIds = new Set(iconManifest.map(i => i.id));
    draft.suggested_icons = draft.suggested_icons.filter(id => validIds.has(id));
  }

  return parsed;
}

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── POST /generate — Generate dual-platform drafts ─────────────────
router.post('/generate', async (req, res) => {
  try {
    const { post_type, ig_format, headline, key_detail, context, tone, cta, photo_url } = req.body;

    if (!post_type || !headline) {
      return res.status(400).json({ error: 'post_type and headline are required' });
    }

    const brandConfig = getBrandConfig();
    const iconManifest = getIconManifest();
    const productPhotos = getProductPhotoCatalog();

    const drafts = await callClaude(
      { post_type, ig_format: ig_format || 'ig-square', headline, key_detail, context, tone, cta, photo_url },
      brandConfig,
      iconManifest,
      productPhotos
    );

    // Use user-uploaded photo, or Claude's suggested product photo, or null
    const finalPhotoUrl = photo_url || drafts.suggested_photo || null;

    // Save to DB
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO social_posts (post_type, ig_format, headline, key_detail, context, tone, cta, photo_url,
        ig_headline, ig_subheadline, ig_body, ig_cta, ig_icons, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ig = drafts.instagram_draft;
    const user = req.session?.username || req.session?.employeeName || 'unknown';

    const result = stmt.run(
      post_type, ig_format || 'ig-square', headline, key_detail || null, context || null, tone || 'default', cta || null, finalPhotoUrl,
      ig.headline, ig.subheadline || null, ig.body_copy || null, ig.cta_text, JSON.stringify(ig.suggested_icons || []),
      user
    );

    res.json({
      id: result.lastInsertRowid,
      instagram_draft: ig,
      brand: {
        primary_color: brandConfig.primary_color,
        secondary_color: brandConfig.secondary_color,
        accent_color: brandConfig.accent_color,
        bg_color: brandConfig.bg_color,
        text_color: brandConfig.text_color,
        brand_name: brandConfig.brand_name
      },
      photo_url: finalPhotoUrl,
      suggested_photo: drafts.suggested_photo || null,
      auto_photo: !photo_url && !!drafts.suggested_photo
    });
  } catch (err) {
    console.error('Social post generation error:', err);
    res.status(500).json({ error: err.message || 'Error generating post' });
  }
});

// ── POST /regenerate/:id — Regenerate drafts for existing post ─────
router.post('/regenerate/:id', async (req, res) => {
  try {
    const db = getDb();
    const post = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const brandConfig = getBrandConfig();
    const iconManifest = getIconManifest();
    const productPhotos = getProductPhotoCatalog();

    const drafts = await callClaude(
      { post_type: post.post_type, ig_format: post.ig_format, headline: post.headline, key_detail: post.key_detail, context: post.context, tone: post.tone, cta: post.cta, photo_url: post.photo_url },
      brandConfig,
      iconManifest,
      productPhotos
    );

    const ig = drafts.instagram_draft;
    const finalPhotoUrl = post.photo_url || drafts.suggested_photo || null;

    db.prepare(`
      UPDATE social_posts SET ig_headline=?, ig_subheadline=?, ig_body=?, ig_cta=?, ig_icons=?,
        photo_url=?, updated_at=datetime('now')
      WHERE id = ?
    `).run(
      ig.headline, ig.subheadline || null, ig.body_copy || null, ig.cta_text, JSON.stringify(ig.suggested_icons || []),
      finalPhotoUrl, req.params.id
    );

    res.json({
      id: post.id,
      instagram_draft: ig,
      brand: {
        primary_color: brandConfig.primary_color,
        secondary_color: brandConfig.secondary_color,
        accent_color: brandConfig.accent_color,
        bg_color: brandConfig.bg_color,
        text_color: brandConfig.text_color,
        brand_name: brandConfig.brand_name
      },
      photo_url: finalPhotoUrl,
      suggested_photo: drafts.suggested_photo || null,
      auto_photo: !post.photo_url && !!drafts.suggested_photo
    });
  } catch (err) {
    console.error('Social post regeneration error:', err);
    res.status(500).json({ error: err.message || 'Error regenerating post' });
  }
});

// ── POST /photo-upload — Upload photo for post ─────────────────────
router.post('/photo-upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const tempUrl = `/uploads/social-photos/${req.file.filename}`;
  res.json({ temp_url: tempUrl, filename: req.file.filename });
});

// ── Helper: Claude refines the image prompt for best results ──────
async function refineImagePrompt(rawInput, postType, igFormat, headline, keyDetail, context, matchedProduct) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawInput; // fallback to raw if no API key

  const isPortrait = igFormat === 'ig-portrait';
  const dimensions = isPortrait ? '1080x1350 (4:5 portrait)' : '1080x1080 (1:1 square)';

  const typeHints = {
    'weekly-special': 'promotional food photography, appetizing presentation',
    'lto': 'limited time offer, premium product showcase, urgency feel',
    'community-event': 'community event, warm welcoming atmosphere',
    'seasonal': 'seasonal celebration, festive mood',
    'brand-moment': 'brand lifestyle, emotional connection'
  };


  const systemMsg = `Eres un director creativo experto en diseño de posts para Instagram de restaurantes premium. Tu trabajo es tomar una descripción simple del usuario y generar un prompt ESTRUCTURADO y detallado para un generador de imágenes AI.

Tu prompt SIEMPRE debe seguir esta estructura exacta (en español):

---
Diseña un post para Instagram inspirado en una promoción de Chick-fil-A, manteniendo el mismo estilo visual, composición y estética del ejemplo proporcionado.
Formato: ${isPortrait ? 'vertical (4:5)' : 'cuadrado (1:1)'}
Estilo: limpio, minimalista, moderno y corporativo
Fondo: Blanco #FFFFFF
Tipografía: Apercu, bold para títulos, alineación izquierda
Colores principales: azul #004F71 (títulos), rojo Chick-fil-A #DD0033 (subtítulos y cuerpo), blanco
Branding: incluir logo de Chick-fil-A La Rambla en la parte inferior
Contenido del diseño:
  Título grande Apercu (en azul #004F71, bold): [El título principal derivado de la descripción del usuario]
  Subtítulo Rooney (en rojo): [Detalles de fecha/hora/lugar si aplica]
  Cuerpo (en rojo, párrafo alineado a la izquierda): [Texto promocional breve y atractivo]
Elementos gráficos: [Elementos decorativos sutiles relacionados al tema — corazones, estrellas, etc. tipo doodle]
  Imagen realista del producto (bien apetitoso, iluminación suave, estilo food photography)
Composición:
  Texto alineado a la izquierda ocupando la mitad superior/izquierda
  Producto ubicado en la parte inferior derecha
  Espacios en blanco amplios para mantener elegancia
Tono general: Promocional, cálido, atractivo y alineado a la identidad visual de Chick-fil-A
---

REGLAS:
- SIEMPRE usa esta estructura. No inventes otro formato.
- Rellena cada campo basándote en la descripción del usuario.
- El título debe ser corto e impactante (máximo 6 palabras).
- El subtítulo incluye fechas, horarios o detalles logísticos si se mencionan.
- El cuerpo es un párrafo breve (2-3 oraciones) que invite al cliente.
- Para posts de producto: destacar el producto como hero visual.
- Para eventos: usar layout tipo calendario con fecha destacada.
- Para promociones: enfatizar la oferta con urgencia sutil.
- Mantén los decorativos tipo doodle sutiles y relevantes al tema.
- NUNCA uses fondos oscuros, gradientes pesados, ni composiciones recargadas.
Responde ÚNICAMENTE con el prompt estructurado. Sin explicaciones, sin markdown, sin comillas envolventes.`;

  const userMsg = `Tipo de post: ${postType || 'general'}
Contexto de estilo: ${typeHints[postType] || 'diseño editorial limpio de comida'}
Descripción del usuario: ${rawInput || 'N/A'}
Contexto adicional: ${context || 'N/A'}

Genera el prompt estructurado para el generador de imágenes AI siguiendo la plantilla exacta.`;

  try {
    // Budget check (non-blocking — falls back to raw prompt if over budget)
    const budgetCheck = checkBudget('anthropic');
    if (!budgetCheck.allowed) {
      console.warn('API budget limit reached for prompt refinement, using raw prompt');
      return rawInput;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        temperature: 0.6,
        system: systemMsg,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!response.ok) {
      logApiCall({ service: 'anthropic', endpoint: 'social-prompt-refine', model: 'claude-sonnet-4-20250514', status: 'error', errorMessage: `HTTP ${response.status}` });
      console.warn('Claude prompt refinement failed, using raw prompt');
      return rawInput;
    }

    const result = await response.json();
    logApiCall({
      service: 'anthropic', endpoint: 'social-prompt-refine',
      inputTokens: result.usage?.input_tokens || 0,
      outputTokens: result.usage?.output_tokens || 0,
      model: 'claude-sonnet-4-20250514', status: 'success'
    });

    const refined = (result.content?.[0]?.text || '').trim();
    if (refined.length > 20) {
      console.log('Image prompt refined by Claude:', refined.substring(0, 100) + '...');
      return refined;
    }
    return rawInput;
  } catch (e) {
    console.warn('Claude prompt refinement error:', e.message);
    return rawInput;
  }
}

// ── Helper: Check if description mentions a real CFA product ──────
function findMatchingProductPhoto(description) {
  const productPhotos = getProductPhotoCatalog();
  if (!productPhotos.length) return null;

  const desc = (description || '').toLowerCase();

  // Score each product photo by how many tags match the description
  let bestMatch = null;
  let bestScore = 0;

  for (const photo of productPhotos) {
    let score = 0;
    // Check product name
    if (photo.name && desc.includes(photo.name.toLowerCase())) score += 3;
    // Check tags
    for (const tag of (photo.tags || [])) {
      if (desc.includes(tag.toLowerCase())) score += 1;
    }
    // Check category
    if (photo.category && desc.includes(photo.category.toLowerCase())) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = photo;
    }
  }

  // Only return if we have a meaningful match (at least 2 tag hits or name match)
  return bestScore >= 2 ? bestMatch : null;
}

// ── POST /generate-image — AI image generation via Nano Banana ────
router.post('/generate-image', async (req, res) => {
  try {
    const { prompt, headline, context, post_type, ig_format, key_detail } = req.body;

    if (!prompt && !headline) {
      return res.status(400).json({ error: 'Provide an image description or post headline' });
    }

    const fullDescription = `${prompt || ''} ${headline || ''} ${key_detail || ''} ${context || ''}`;

    // Step 0: Check if description references a real CFA product in the library
    const matchedProduct = findMatchingProductPhoto(fullDescription);
    let productPhotoPath = null;
    if (matchedProduct && matchedProduct.file_path) {
      const relPath = matchedProduct.file_path.startsWith('/') ? matchedProduct.file_path.slice(1) : matchedProduct.file_path;
      productPhotoPath = path.join(__dirname, '..', '..', 'public', relPath);
      if (!fs.existsSync(productPhotoPath)) {
        productPhotoPath = path.join(__dirname, '..', '..', relPath);
      }
      if (!fs.existsSync(productPhotoPath)) {
        productPhotoPath = null;
      } else {
        console.log(`Product photo matched: "${matchedProduct.name}" — will use /edit`);
      }
    }

    // Step 1: Let Claude refine the image prompt for best results
    const rawPrompt = (prompt || '').trim() || `${headline}. ${key_detail || ''} ${context || ''}`;
    let imagePrompt = await refineImagePrompt(rawPrompt, post_type, ig_format, headline, key_detail, context, null);

    // Sanitize prompt — strip characters that could break CLI args
    imagePrompt = imagePrompt.replace(/[`$\\'"]/g, '');

    // Snapshot existing files before generation
    const filesBefore = new Set(
      fs.existsSync(NANOBANANA_DIR) ? fs.readdirSync(NANOBANANA_DIR) : []
    );

    // Pick reference design — user-selected or random from library
    const refDir = path.join(__dirname, '..', '..', 'public', 'social-templates', 'reference-designs');
    let referenceImagePath = null;
    try {
      if (req.body.reference_design) {
        // User picked a specific reference design
        const picked = path.join(refDir, path.basename(req.body.reference_design));
        if (fs.existsSync(picked)) {
          referenceImagePath = picked;
          console.log(`Reference design (user-selected): ${path.basename(picked)}`);
        }
      }
      if (!referenceImagePath && fs.existsSync(refDir)) {
        // Fallback: random pick from library
        const refFiles = fs.readdirSync(refDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
        if (refFiles.length > 0) {
          const pick = refFiles[Math.floor(Math.random() * refFiles.length)];
          referenceImagePath = path.join(refDir, pick);
          console.log(`Reference design (random): ${pick}`);
        }
      }
    } catch (e) { /* no reference designs available */ }

    // Build Gemini CLI command
    const projectRoot = path.join(__dirname, '..', '..');
    let geminiArgs;
    const variantCount = parseInt(req.body.count) || 3;

    // Enrich prompt with reference design context if available
    let finalPrompt = imagePrompt;

    if (referenceImagePath) {
      finalPrompt += ` Copia el estilo visual, composición, tipografía y estética exacta de este diseño de referencia de @chickfila_larambla.`;
      console.log(`Reference design context added: ${path.basename(referenceImagePath)}`);
    }

    // Sanitize again after enrichment
    finalPrompt = finalPrompt.replace(/[`$\\'"]/g, '');

    const runGemini = (args) => new Promise((resolve, reject) => {
      execFile(GEMINI_PATH, args, {
        cwd: projectRoot,
        timeout: 180000,
        env: { ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY }
      }, (err, stdout, stderr) => {
        if (err) {
          console.error('Gemini CLI error:', stderr || err.message);
          return reject(new Error(stderr || err.message));
        }
        resolve(stdout);
      });
    });

    if (productPhotoPath) {
      // Product photo matched — use /edit with real photo (1 variant)
      console.log(`Running /edit with product photo: ${path.basename(productPhotoPath)}`);
      await runGemini(['--yolo', `/edit ${productPhotoPath} '${finalPrompt}'`]);
    } else {
      // No product match — use /generate with 3 variants
      console.log(`Running /generate with --count=${variantCount}...`);
      await runGemini(['--yolo', `/generate '${finalPrompt}' --count=${variantCount}`]);
    }

    // Find newly generated file(s)
    const filesAfter = fs.readdirSync(NANOBANANA_DIR);
    const newFiles = filesAfter
      .filter(f => !filesBefore.has(f) && /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(NANOBANANA_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (newFiles.length === 0) {
      const allImages = filesAfter
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(NANOBANANA_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (allImages.length === 0) {
        return res.status(500).json({ error: 'Image generation failed — no output file found' });
      }
      newFiles.push(allImages[0]);
    }

    // Copy ALL generated variants to uploads
    const variants = [];
    const filesToCopy = newFiles.slice(0, variantCount);
    for (const file of filesToCopy) {
      const srcFile = path.join(NANOBANANA_DIR, file.name);
      const ext = path.extname(file.name).toLowerCase() || '.png';
      const destName = crypto.randomUUID() + ext;
      const destFile = path.join(UPLOAD_DIR, destName);
      fs.copyFileSync(srcFile, destFile);
      variants.push({
        temp_url: `/uploads/social-photos/${destName}`,
        filename: destName
      });
    }

    // Cleanup: remove old nanobanana files older than 1 hour
    const oneHourAgo = Date.now() - 3600000;
    filesAfter.forEach(f => {
      try {
        const fp = path.join(NANOBANANA_DIR, f);
        if (fs.statSync(fp).mtimeMs < oneHourAgo) fs.unlinkSync(fp);
      } catch (e) { /* ignore */ }
    });

    res.json({
      temp_url: variants[0].temp_url,
      filename: variants[0].filename,
      variants: variants,
      ai_generated: true
    });
  } catch (err) {
    console.error('AI image generation error:', err);
    res.status(500).json({ error: err.message || 'Error generating image with AI' });
  }
});

// ── POST /export-log — Record export event ─────────────────────────
router.post('/export-log', (req, res) => {
  const { post_id } = req.body;
  if (!post_id) return res.status(400).json({ error: 'post_id required' });

  const db = getDb();
  db.prepare(`UPDATE social_posts SET ig_exported = 1, updated_at = datetime('now') WHERE id = ?`).run(post_id);
  res.json({ ok: true });
});

// ── GET /history — Paginated post history ──────────────────────────
router.get('/history', (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as c FROM social_posts').get().c;
  const posts = db.prepare(`
    SELECT id, post_type, ig_format, headline, context, ig_headline,
           ig_exported, created_by, created_at
    FROM social_posts ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({ posts, total, page, pages: Math.ceil(total / limit) });
});

// ── GET /post/:id — Get full post detail ───────────────────────────
router.get('/post/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

// ── GET /icons — Full icon manifest ────────────────────────────────
router.get('/icons', (_req, res) => {
  res.json(getIconManifest());
});

// ── GET /icons/:id/svg — Raw SVG content ───────────────────────────
router.get('/icons/:id/svg', (req, res) => {
  const db = getDb();
  const icon = db.prepare('SELECT file_path FROM social_icons WHERE id = ? AND active = 1').get(req.params.id);
  if (!icon) return res.status(404).json({ error: 'Icon not found' });

  const svgPath = path.join(__dirname, '..', '..', 'public', icon.file_path);
  if (!fs.existsSync(svgPath)) return res.status(404).json({ error: 'SVG file not found' });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(fs.readFileSync(svgPath, 'utf8'));
});

// ── POST /icons — Admin: upload new icon ───────────────────────────
router.post('/icons', upload.single('svg'), (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!req.file) return res.status(400).json({ error: 'No SVG file' });

  const { id, name, category, tags, compatible_types } = req.body;
  if (!id || !name || !category) return res.status(400).json({ error: 'id, name, category required' });

  // Move SVG to icons dir
  const destDir = path.join(__dirname, '..', '..', 'public', 'social-templates', 'icons', category);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `${id}.svg`);
  fs.renameSync(req.file.path, destFile);

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO social_icons (id, name, category, tags, file_path, compatible_types)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, category, tags || '[]', `social-templates/icons/${category}/${id}.svg`, compatible_types || '[]');

  res.json({ ok: true, id });
});

// ── PATCH /icons/:id — Admin: update/deactivate icon ───────────────
router.patch('/icons/:id', (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const db = getDb();
  const icon = db.prepare('SELECT * FROM social_icons WHERE id = ?').get(req.params.id);
  if (!icon) return res.status(404).json({ error: 'Icon not found' });

  const { name, tags, compatible_types, active } = req.body;
  db.prepare(`
    UPDATE social_icons SET
      name = COALESCE(?, name),
      tags = COALESCE(?, tags),
      compatible_types = COALESCE(?, compatible_types),
      active = COALESCE(?, active)
    WHERE id = ?
  `).run(name || null, tags || null, compatible_types || null, active !== undefined ? active : null, req.params.id);

  res.json({ ok: true });
});

// ── GET /brand-config — Brand configuration ────────────────────────
router.get('/brand-config', (_req, res) => {
  res.json(getBrandConfig());
});

// ── PUT /brand-config — Admin: update brand config ─────────────────
router.put('/brand-config', (req, res) => {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO social_brand_config (key, value) VALUES (?, ?)');
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    stmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  res.json({ ok: true });
});

// ── GET /product-photos — Product photo library ──────────────────
router.get('/product-photos', (_req, res) => {
  const photos = getProductPhotoCatalog();
  res.json(photos);
});

// ── GET /product-photos/:id — Single product photo detail ─────────
router.get('/product-photos/:id', (req, res) => {
  const db = getDb();
  const photo = db.prepare('SELECT * FROM social_product_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  res.json(photo);
});

// ── GET /templates — Template metadata list ────────────────────────
router.get('/templates', (_req, res) => {
  res.json([
    {
      template_id: 'promotion',
      name: 'Promocion / Especial',
      supported_post_types: ['weekly-special', 'lto', 'brand-moment'],
      supported_formats: ['ig-square', 'ig-portrait'],
      has_photo_slot: true,
      max_icons: 3
    },
    {
      template_id: 'event',
      name: 'Evento Comunitario',
      supported_post_types: ['community-event', 'seasonal'],
      supported_formats: ['ig-square', 'ig-portrait'],
      has_photo_slot: true,
      max_icons: 3
    }
  ]);
});

// ── Reference Designs CRUD ──────────────────────────────────────────
const REF_DESIGN_DIR = path.join(__dirname, '..', '..', 'public', 'social-templates', 'reference-designs');
if (!fs.existsSync(REF_DESIGN_DIR)) fs.mkdirSync(REF_DESIGN_DIR, { recursive: true });

const refUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, REF_DESIGN_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_').toLowerCase();
      cb(null, Date.now() + '-' + safeName);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
    cb(new Error('Solo JPEG, PNG o WEBP'));
  }
});

// List all reference designs
router.get('/reference-designs', (_req, res) => {
  try {
    const files = fs.readdirSync(REF_DESIGN_DIR)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => ({
        filename: f,
        url: `/social-templates/reference-designs/${f}`,
        size: fs.statSync(path.join(REF_DESIGN_DIR, f)).size,
        uploaded: fs.statSync(path.join(REF_DESIGN_DIR, f)).mtimeMs
      }))
      .sort((a, b) => b.uploaded - a.uploaded);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Upload new reference design
router.post('/reference-designs', refUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    url: `/social-templates/reference-designs/${req.file.filename}`
  });
});

// Delete a reference design
router.delete('/reference-designs/:filename', (req, res) => {
  const filePath = path.join(REF_DESIGN_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
