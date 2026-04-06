// ══════════════════════════════════════════════════════════════════════
// SOCIAL MEDIA POST AUTOMATION MODULE
// Generates on-brand Instagram posts using Claude AI.
// ══════════════════════════════════════════════════════════════════════

var SP = {
  currentPost: null,    // { id, instagram_draft, brand, photo_url }
  icons: [],            // icon manifest cache
  brandConfig: null,    // brand config cache
  selectedPhoto: null,  // { temp_url, filename }
  editedIG: null,       // user-edited IG draft overrides
  generating: false
};

// ── Init ────────────────────────────────────────────────────────────
async function spInit() {
  try {
    var res = await fetch('/api/social-posts/brand-config');
    SP.brandConfig = await res.json();
    var icRes = await fetch('/api/social-posts/icons');
    SP.icons = await icRes.json();
  } catch (e) { console.error('SP init error:', e); }
  spLoadHistory();
  spPopulateCTAs();
}

function spPopulateCTAs() {
  var sel = document.getElementById('spCTA');
  if (!sel || !SP.brandConfig) return;
  var opts = [];
  try { opts = JSON.parse(SP.brandConfig.cta_options || '[]'); } catch(e) {}
  sel.innerHTML = '<option value="">Automático (Claude elige)</option>';
  opts.forEach(function(o) {
    sel.innerHTML += '<option value="' + esc(o) + '">' + esc(o) + '</option>';
  });
  sel.innerHTML += '<option value="custom">Personalizado...</option>';
}

// ── Form Handling ───────────────────────────────────────────────────
function spShowCreate(reset) {
  document.getElementById('spCreatePanel').style.display = 'block';
  document.getElementById('spPreviewPanel').style.display = 'none';
  document.getElementById('spHistoryPanel').style.display = 'none';
  if (reset) {
    SP.currentPost = null;
    SP.selectedPhoto = null;
    SP.editedIG = null;
    SP.aiVariants = null;
    SP.selectedVariantIndex = 0;
    SP.useTemplate = false;
    document.getElementById('spForm').reset();
    document.getElementById('spPhotoPreview').innerHTML = '';
    document.getElementById('spCustomCTA').style.display = 'none';
  }
}

function spShowHistory() {
  document.getElementById('spCreatePanel').style.display = 'none';
  document.getElementById('spPreviewPanel').style.display = 'none';
  document.getElementById('spHistoryPanel').style.display = 'block';
  spLoadHistory();
}

function spCTAChanged() {
  var sel = document.getElementById('spCTA');
  document.getElementById('spCustomCTA').style.display = sel.value === 'custom' ? 'block' : 'none';
}

// ── Photo Upload ────────────────────────────────────────────────────
async function spUploadPhoto() {
  var input = document.getElementById('spPhotoFile');
  if (!input.files.length) return;
  var file = input.files[0];
  if (file.size > 10 * 1024 * 1024) {
    alert('El archivo es muy grande. Máximo 10MB.');
    return;
  }

  var fd = new FormData();
  fd.append('photo', file);

  try {
    var res = await fetch('/api/social-posts/photo-upload', { method: 'POST', body: fd });
    var data = await res.json();
    if (data.temp_url) {
      SP.selectedPhoto = data;
      document.getElementById('spPhotoPreview').innerHTML =
        '<img src="' + data.temp_url + '" style="max-width:200px; max-height:150px; border-radius:8px; object-fit:cover;">' +
        '<button class="btn btn-sm" style="margin-left:0.5rem;" onclick="spRemovePhoto()">Eliminar</button>';
    }
  } catch (e) {
    alert('Error subiendo foto: ' + e.message);
  }
}

function spRemovePhoto() {
  SP.selectedPhoto = null;
  document.getElementById('spPhotoFile').value = '';
  document.getElementById('spPhotoPreview').innerHTML = '';
  var promptEl = document.getElementById('spAIImagePrompt');
  if (promptEl) promptEl.value = '';
}

// ── Reference Design Management ────────────────────────────────────
function spLoadRefDesigns() {
  fetch('/api/social-posts/reference-designs')
    .then(function(r) { return r.json(); })
    .then(function(designs) {
      SP.refDesigns = designs || [];
      spRenderRefGrid();
    })
    .catch(function() { SP.refDesigns = []; });
}

function spRenderRefGrid() {
  var grid = document.getElementById('spRefDesignGrid');
  if (!grid) return;
  var designs = SP.refDesigns || [];
  if (designs.length === 0) {
    grid.innerHTML = '<span style="font-size:0.75rem; color:var(--text-light);">No hay diseños de referencia. Sube ejemplos de tus mejores posts.</span>';
    return;
  }
  var selectedRef = (document.getElementById('spSelectedRef') || {}).value || '';
  var html = '';
  for (var i = 0; i < designs.length; i++) {
    var d = designs[i];
    var isSel = selectedRef === d.filename;
    var border = isSel ? '3px solid #7c4dff' : '2px solid #e0e0e0';
    var opacity = isSel ? '1' : '0.7';
    html += '<div style="position:relative; cursor:pointer; border:' + border + '; border-radius:6px; overflow:hidden; width:80px; height:80px; opacity:' + opacity + '; transition:all 0.2s;" ';
    html += 'onclick="spPickRef(\'' + d.filename.replace(/'/g, "\\'") + '\')" ';
    html += 'onmouseover="this.style.opacity=1;this.style.transform=\'scale(1.05)\'" onmouseout="this.style.opacity=' + opacity + ';this.style.transform=\'scale(1)\'">';
    html += '<img src="' + d.url + '" style="width:100%; height:100%; object-fit:cover; display:block;">';
    if (isSel) {
      html += '<div style="position:absolute; top:2px; right:2px; background:#7c4dff; color:white; border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold;">✓</div>';
    }
    html += '<div onclick="event.stopPropagation(); spDeleteRef(\'' + d.filename.replace(/'/g, "\\'") + '\')" style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.6); color:white; border-radius:50%; width:16px; height:16px; display:flex; align-items:center; justify-content:center; font-size:10px; cursor:pointer;" title="Eliminar">×</div>';
    html += '</div>';
  }
  grid.innerHTML = html;
}

function spPickRef(filename) {
  var refInput = document.getElementById('spSelectedRef');
  if (!refInput) return;
  // Toggle: click same = deselect
  refInput.value = refInput.value === filename ? '' : filename;
  spRenderRefGrid();
}

async function spUploadRefDesign() {
  var input = document.getElementById('spRefUpload');
  if (!input || !input.files || !input.files[0]) return;
  var fd = new FormData();
  fd.append('file', input.files[0]);
  try {
    var res = await fetch('/api/social-posts/reference-designs', { method: 'POST', body: fd });
    var data = await res.json();
    if (res.ok) {
      input.value = '';
      spLoadRefDesigns();
    } else {
      alert(data.error || 'Error subiendo diseño');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function spDeleteRef(filename) {
  if (!confirm('¿Eliminar este diseño de referencia?')) return;
  try {
    await fetch('/api/social-posts/reference-designs/' + encodeURIComponent(filename), { method: 'DELETE' });
    var refInput = document.getElementById('spSelectedRef');
    if (refInput && refInput.value === filename) refInput.value = '';
    spLoadRefDesigns();
  } catch (e) { alert('Error: ' + e.message); }
}

// Load reference designs on page init
if (document.getElementById('spRefDesignGrid')) {
  setTimeout(spLoadRefDesigns, 500);
}

// ── AI Image Generation ────────────────────────────────────────────
async function spGenerateAIImage() {
  var btn = document.getElementById('spAIImageBtn');
  if (!btn || btn.disabled) return;

  var prompt = (document.getElementById('spAIImagePrompt').value || '').trim();
  var headline = (document.getElementById('spHeadline').value || '').trim();
  var context = (document.getElementById('spContext').value || '').trim();

  if (!prompt && !headline) {
    alert('Escribe una descripción de la imagen o llena el título del post primero.');
    return;
  }

  btn.disabled = true;
  var origText = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:6px;"></span> Generando imagen...';

  try {
    var res = await fetch('/api/social-posts/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, headline: headline, context: context })
    });

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generating image');

    SP.selectedPhoto = data;
    document.getElementById('spPhotoPreview').innerHTML =
      '<div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">' +
        '<img src="' + data.temp_url + '" style="max-width:200px; max-height:150px; border-radius:8px; object-fit:cover;">' +
        '<div>' +
          '<span style="font-size:0.65rem; background:var(--brand-navy); color:#fff; padding:2px 8px; border-radius:10px;">AI Generated</span>' +
          '<button class="btn btn-sm" style="margin-left:0.5rem;" onclick="spRemovePhoto()">Eliminar</button>' +
        '</div>' +
      '</div>';
  } catch (e) {
    alert('Error generando imagen: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
}

// ── Generate Post ───────────────────────────────────────────────────
// Flow: 1) Generate image via Nano Banana  2) Generate copy via Claude
// The description field drives everything — image, copy, layout.
async function spGenerate() {
  if (SP.generating) return;

  var description = document.getElementById('spContext').value.trim();
  if (!description) { alert('Describe tu post para generar'); return; }

  var postType = document.getElementById('spPostType').value;
  var igFormat = document.getElementById('spIGFormat').value;

  // Auto-fill headline from first line/sentence of description for backend compat
  var autoHeadline = description.split(/[.\n]/)[0].substring(0, 60).trim();
  document.getElementById('spHeadline').value = autoHeadline;

  SP.generating = true;

  // ── STEP 1: Generate image with Nano Banana ──────────────────────
  // Skip if user already uploaded a manual photo
  var photoUrl = SP.selectedPhoto ? SP.selectedPhoto.temp_url : null;

  if (!photoUrl) {
    spShowLoadingStep(1, 'Creando 3 opciones con AI...', 3);
    try {
      var imgRes = await fetch('/api/social-posts/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: description,
          headline: autoHeadline,
          context: description,
          post_type: postType,
          ig_format: igFormat,
          count: 3,
          reference_design: (document.getElementById('spSelectedRef') || {}).value || ''
        })
      });
      var imgCT = imgRes.headers.get('content-type') || '';
      if (!imgCT.includes('application/json')) throw new Error('Sesión expirada');
      var imgData = await imgRes.json();
      if (imgRes.ok && imgData.temp_url) {
        SP.selectedPhoto = imgData;
        SP.aiVariants = imgData.variants || [{ temp_url: imgData.temp_url, filename: imgData.filename }];
        SP.selectedVariantIndex = 0;
        photoUrl = imgData.temp_url;
      }
    } catch (imgErr) {
      console.warn('AI image generation failed, continuing with library:', imgErr.message);
    }
  }

  // ── STEP 2: Generate copy with Claude ────────────────────────────
  spShowLoadingStep(2, 'Generando copy con Claude AI...', 3);

  try {
    var res = await fetch('/api/social-posts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_type: postType,
        ig_format: igFormat,
        headline: autoHeadline,
        context: description,
        tone: 'default',
        cta: null,
        photo_url: photoUrl
      })
    });

    var contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Sesión expirada. Por favor recarga la página e inténtalo de nuevo.');
    }
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generating post');

    SP.currentPost = data;
    SP.editedIG = Object.assign({}, data.instagram_draft);

    // If Nano Banana already generated a photo, force it as the post photo
    // — never let Claude's auto-selection override the AI-generated image
    if (SP.selectedPhoto && SP.selectedPhoto.ai_generated) {
      SP.currentPost.photo_url = SP.selectedPhoto.temp_url;
      SP.currentPost.auto_photo = false;
      SP.currentPost.suggested_photo = null;
    } else if (!SP.selectedPhoto && data.auto_photo && data.suggested_photo) {
      // No Nano Banana and no user upload — use Claude's library suggestion
      SP.selectedPhoto = { temp_url: data.suggested_photo, filename: 'auto', auto: true };
    }
    spRenderPreviews();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    SP.generating = false;
    spShowLoading(false);
  }
}

function spShowLoading(show) {
  var panel = document.getElementById('spPreviewPanel');
  var create = document.getElementById('spCreatePanel');
  if (show) {
    create.style.display = 'none';
    panel.style.display = 'block';
    document.getElementById('spPreviewContent').innerHTML =
      '<div style="display:flex; justify-content:center; padding:3rem;">' +
        '<div style="max-width:500px; background:var(--bg-alt); border-radius:12px; padding:2rem; text-align:center;">' +
          '<div class="loading-spinner" style="margin:2rem auto;"></div>' +
          '<p style="color:var(--text-light);">Generando draft de Instagram...</p>' +
        '</div>' +
      '</div>';
  }
}

function spShowLoadingStep(step, message, totalSteps) {
  var panel = document.getElementById('spPreviewPanel');
  var create = document.getElementById('spCreatePanel');
  create.style.display = 'none';
  panel.style.display = 'block';

  var spinner = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;"></div>';
  var pending = '<span style="color:var(--text-light); font-size:14px;">○</span>';
  var done = '<span style="color:#43a047; font-size:16px;">✓</span>';

  var steps = [
    { label: 'Claude refina el prompt de imagen', icon: step === 1 ? spinner : (step > 1 ? done : pending) },
    { label: 'Nano Banana genera la imagen', icon: step === 1 ? spinner : (step > 1 ? done : pending) },
    { label: 'Claude genera copy + layout', icon: step === 2 ? spinner : (step > 2 ? done : pending) }
  ];
  // Steps 1 & 2 on backend happen together in one call, so show them as one visual block
  // Step 1 = image gen (prompt refine + nanobanana), Step 2 = copy gen

  var stepsHtml = '';
  steps.forEach(function(s, i) {
    var isActive = (i < 2 && step === 1) || (i === 2 && step === 2);
    var isDone = (i < 2 && step >= 2);
    var opacity = isActive ? '1' : (isDone ? '0.6' : '0.35');
    stepsHtml += '<div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; opacity:' + opacity + ';">' +
      (isDone ? done : (isActive ? spinner : pending)) +
      '<span style="font-size:0.85rem;">' + s.label + '</span>' +
    '</div>';
  });

  document.getElementById('spPreviewContent').innerHTML =
    '<div style="display:flex; justify-content:center; padding:3rem;">' +
      '<div style="max-width:520px; background:var(--bg-alt); border-radius:12px; padding:2rem; text-align:center;">' +
        '<div class="loading-spinner" style="margin:1rem auto 1.5rem;"></div>' +
        '<p style="color:var(--text-primary); font-weight:600; margin-bottom:1.5rem; font-size:1.05rem;">' + esc(message) + '</p>' +
        '<div style="text-align:left; max-width:340px; margin:0 auto;">' +
          stepsHtml +
        '</div>' +
        '<p style="color:var(--text-light); font-size:0.75rem; margin-top:1rem;">Esto puede tomar 20-40 segundos</p>' +
      '</div>' +
    '</div>';
}

// ── Render Previews ─────────────────────────────────────────────────
function spRenderPreviews() {
  if (!SP.currentPost) return;

  document.getElementById('spCreatePanel').style.display = 'none';
  document.getElementById('spHistoryPanel').style.display = 'none';
  document.getElementById('spPreviewPanel').style.display = 'block';

  var ig = SP.editedIG || SP.currentPost.instagram_draft;
  var brand = SP.currentPost.brand;
  var photoUrl = SP.currentPost.photo_url;
  var igFormat = document.getElementById('spIGFormat') ? document.getElementById('spIGFormat').value : 'ig-square';

  var igW = 1080, igH = igFormat === 'ig-portrait' ? 1350 : 1080;

  // Scale for preview — larger now with single preview
  var previewScale = 0.45;

  // Check if we have an AI-generated full graphic — show it directly
  var isFullAIGraphic = SP.selectedPhoto && SP.selectedPhoto.ai_generated && !SP.useTemplate;

  var html = '<div style="display:flex; justify-content:center; align-items:flex-start; gap:2rem; flex-wrap:wrap;">';

  if (isFullAIGraphic) {
    // ── AI-GENERATED OPTIONS — show selected + variant picker ──
    var previewW = igFormat === 'ig-portrait' ? 405 : 486;
    var previewH = igFormat === 'ig-portrait' ? 506 : 486;
    var variants = SP.aiVariants || [{ temp_url: SP.selectedPhoto.temp_url, filename: SP.selectedPhoto.filename }];
    var selIdx = SP.selectedVariantIndex || 0;

    html += '<div style="width:100%;">';

    // Main selected preview
    html += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem;">';
    html += '<div><h3 style="margin:0; color:var(--brand-navy); font-size:1rem; display:inline;">Instagram (' + igW + '\u00d7' + igH + ')</h3>';
    html += ' <span style="font-size:0.7rem; background:#7c4dff; color:white; padding:2px 8px; border-radius:10px; margin-left:6px;">AI Design</span></div>';
    html += '<div style="display:flex; gap:0.5rem;">';
    html += '<button class="btn btn-sm" onclick="spExportAI()">Exportar PNG</button>';
    html += '<button class="btn btn-sm" onclick="spFullPreviewAI()">Vista completa</button>';
    html += '</div></div>';

    html += '<div style="display:flex; gap:1.5rem; align-items:flex-start; flex-wrap:wrap;">';

    // Large selected image
    html += '<div id="spCanvas_instagram" style="width:' + previewW + 'px; height:' + previewH + 'px; border-radius:8px; box-shadow:0 2px 12px rgba(0,0,0,0.12); overflow:hidden; flex-shrink:0;">';
    html += '<img src="' + esc(variants[selIdx].temp_url) + '" style="width:100%; height:100%; object-fit:cover;" crossorigin="anonymous">';
    html += '</div>';

    // Variant selector sidebar
    html += '<div style="display:flex; flex-direction:column; gap:0.75rem;">';
    html += '<span style="font-size:0.8rem; font-weight:600; color:var(--brand-navy); margin-bottom:0.25rem;">Elige una opción:</span>';

    for (var vi = 0; vi < variants.length; vi++) {
      var isSelected = vi === selIdx;
      var borderStyle = isSelected ? '3px solid #7c4dff' : '2px solid #e0e0e0';
      var opacityStyle = isSelected ? '1' : '0.7';
      var thumbW = igFormat === 'ig-portrait' ? 120 : 140;
      var thumbH = igFormat === 'ig-portrait' ? 150 : 140;
      html += '<div onclick="spSelectVariant(' + vi + ')" style="cursor:pointer; border:' + borderStyle + '; border-radius:8px; overflow:hidden; width:' + thumbW + 'px; opacity:' + opacityStyle + '; transition:all 0.2s; position:relative;" onmouseover="this.style.opacity=1;this.style.transform=\'scale(1.03)\'" onmouseout="this.style.opacity=' + opacityStyle + ';this.style.transform=\'scale(1)\'">';
      html += '<img src="' + esc(variants[vi].temp_url) + '" style="width:100%; height:' + thumbH + 'px; object-fit:cover; display:block;">';
      if (isSelected) {
        html += '<div style="position:absolute; top:4px; right:4px; background:#7c4dff; color:white; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold;">✓</div>';
      }
      html += '<div style="text-align:center; padding:4px 0; font-size:0.7rem; color:var(--text-light); background:white;">Opción ' + (vi + 1) + '</div>';
      html += '</div>';
    }

    html += '</div>'; // end sidebar
    html += '</div>'; // end flex row
    html += '</div>'; // end wrapper

  } else {
    // ── TEMPLATE LAYOUT — original CSS preview ──
    var layoutLabels = {
      'hero-banner': 'Hero Banner', 'split-diagonal': 'Split Diagonal', 'accent-frame': 'Accent Frame',
      'photo-dominant': 'Photo Dominant', 'bold-type': 'Bold Type', 'icon-showcase': 'Icon Showcase',
      'navy-elegance': 'Navy Elegance', 'minimal-red': 'Minimal Red',
      'warm-product': 'Warm Product', 'event-calendar': 'Event Calendar'
    };
    var currentLayout = ig.layout_style || 'default';

    html += '<div style="max-width:550px;">';
    html += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.75rem;">';
    html += '<div><h3 style="margin:0; color:var(--brand-navy); font-size:1rem; display:inline;">Instagram (' + igW + '\u00d7' + igH + ')</h3>';
    html += ' <span style="font-size:0.7rem; background:var(--brand-navy); color:white; padding:2px 8px; border-radius:10px; margin-left:6px;">' + (layoutLabels[currentLayout] || currentLayout) + '</span></div>';
    html += '<div style="display:flex; gap:0.5rem;">';
    html += '<button class="btn btn-sm" onclick="spExport()">Exportar PNG</button>';
    html += '<button class="btn btn-sm" onclick="spFullPreview()">Vista completa</button>';
    html += '</div></div>';
    html += spBuildPostPreview('instagram', ig, brand, photoUrl, igW, igH, previewScale);
    html += '</div>';
  }

  html += '</div>';

  // Photo source indicator
  if (SP.selectedPhoto && SP.selectedPhoto.ai_generated) {
    html += '<div style="margin-top:1rem; padding:0.75rem 1rem; background:#ede7f6; border-radius:8px; border:1px solid #b39ddb; display:flex; align-items:center; gap:0.5rem;">';
    html += '<span style="font-size:1.2rem;">🎨</span>';
    html += '<span style="font-size:0.85rem; color:#4527a0;"><strong>Imagen AI:</strong> Generada con Nano Banana (Gemini).</span>';
    html += '</div>';
  } else if (SP.currentPost && SP.currentPost.auto_photo) {
    html += '<div style="margin-top:1rem; padding:0.75rem 1rem; background:#e8f5e9; border-radius:8px; border:1px solid #a5d6a7; display:flex; align-items:center; gap:0.5rem;">';
    html += '<span style="font-size:1.2rem;">🤖</span>';
    html += '<span style="font-size:0.85rem; color:#2e7d32;"><strong>Foto auto-seleccionada:</strong> Claude eligió la imagen más relevante de la biblioteca.</span>';
    html += '</div>';
  }

  // Edit & Feedback Section
  html += '<div style="margin-top:1.5rem; padding:1.25rem; background:var(--bg-alt); border-radius:12px; border:1px solid var(--border);">';
  html += '<h4 style="margin:0 0 1rem; color:var(--brand-navy);">Editar Copy</h4>';
  html += '<div style="max-width:500px;">';

  // IG editable fields
  html += '<div style="font-size:0.75rem; font-weight:700; color:var(--brand-navy); margin-bottom:0.5rem; text-transform:uppercase;">Instagram</div>';
  html += spEditField('ig_headline', 'Headline', ig.headline, 50);
  html += spEditField('ig_subheadline', 'Subtítulo', ig.subheadline || '', 80);
  html += spEditField('ig_body', 'Cuerpo', ig.body_copy || '', 120);
  html += spEditField('ig_cta', 'CTA', ig.cta_text, 30);

  html += '</div>';
  html += '<div style="display:flex; gap:0.75rem; margin-top:1rem; align-items:flex-end;">';
  html += '<div style="flex:1;"><label style="font-size:0.8rem; color:var(--text-light);">Feedback para Claude (opcional)</label>';
  html += '<input type="text" id="spFeedback" placeholder="Ej: hazlo más urgente, cambia el tono a algo más cálido..." style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:6px; font-size:0.875rem;"></div>';
  html += '<button class="btn btn-primary btn-sm" onclick="spApplyEdits()">Aplicar cambios</button>';
  html += '<button class="btn btn-sm" onclick="spRegenerateWithFeedback()">Regenerar con AI</button>';
  html += '</div>';
  html += '</div>';

  document.getElementById('spPreviewContent').innerHTML = html;
}

function spEditField(id, label, value, maxLen) {
  return '<div style="margin-bottom:0.5rem;">' +
    '<label style="font-size:0.7rem; color:var(--text-light);">' + label + ' (' + maxLen + ' chars)</label>' +
    '<input type="text" id="spEdit_' + id + '" value="' + esc(value) + '" maxlength="' + maxLen + '" ' +
    'style="width:100%; padding:0.35rem 0.5rem; border:1px solid var(--border); border-radius:4px; font-size:0.8rem;">' +
    '</div>';
}

function spApplyEdits() {
  // Read edited values and update previews
  SP.editedIG = {
    headline: document.getElementById('spEdit_ig_headline').value,
    subheadline: document.getElementById('spEdit_ig_subheadline').value || null,
    body_copy: document.getElementById('spEdit_ig_body').value || null,
    cta_text: document.getElementById('spEdit_ig_cta').value,
    suggested_icons: SP.editedIG ? SP.editedIG.suggested_icons : [],
    disclaimer: SP.editedIG ? SP.editedIG.disclaimer : '',
    layout_style: SP.editedIG ? SP.editedIG.layout_style : 'hero-banner'
  };
  spRenderPreviews();
}

async function spRegenerateWithFeedback() {
  if (!SP.currentPost || SP.generating) return;
  var feedback = document.getElementById('spFeedback').value.trim();

  SP.generating = true;
  spShowLoading(true);

  try {
    // If there's feedback, we do a new generation with context
    var postId = SP.currentPost.id;
    var url = '/api/social-posts/regenerate/' + postId;

    // For feedback, we append to the context
    if (feedback) {
      // Get original form data and append feedback
      var origContext = document.getElementById('spContext').value.trim();
      var enhancedContext = origContext + '\n\nFEEDBACK DEL USUARIO PARA MEJORAR: ' + feedback;

      var res = await fetch('/api/social-posts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_type: document.getElementById('spPostType').value,
          ig_format: document.getElementById('spIGFormat').value,
          headline: document.getElementById('spHeadline').value,
          key_detail: document.getElementById('spKeyDetail').value || null,
          context: enhancedContext,
          tone: document.getElementById('spTone').value,
          cta: document.getElementById('spCTA').value || null,
          photo_url: SP.selectedPhoto ? SP.selectedPhoto.temp_url : null
        })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      SP.currentPost = data;
    } else {
      var res2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      var data2 = await res2.json();
      if (!res2.ok) throw new Error(data2.error);
      SP.currentPost = data2;
    }

    SP.editedIG = Object.assign({}, SP.currentPost.instagram_draft);
    spRenderPreviews();
  } catch (e) {
    alert('Error regenerando: ' + e.message);
  } finally {
    SP.generating = false;
    spShowLoading(false);
  }
}

// ── Build Post Preview HTML ─────────────────────────────────────────
// Supports 8 layout styles chosen by Claude for visual variety.
function spBuildPostPreview(platform, draft, brand, photoUrl, w, h, scale) {
  var sw = Math.round(w * scale);
  var sh = Math.round(h * scale);
  var isTall = h > 1100;
  var layout = draft.layout_style || 'hero-banner';

  var primaryColor = brand.primary_color || '#DD0033';
  var navyColor = brand.secondary_color || '#004F71';
  var textColor = brand.text_color || '#333333';

  // Base font sizes — clean editorial style inspired by @chickfila_larambla
  var headlineSize = isTall ? 76 : 72;
  var subSize = 26;
  var bodySize = 28;
  var ctaSize = 24;
  var disclaimerSize = 15;
  var logoH = 50;

  // Canvas wrapper
  var html = '<div id="spCanvas_instagram" style="' +
    'width:' + w + 'px; height:' + h + 'px; ' +
    'transform:scale(' + scale + '); transform-origin:top left; ' +
    'font-family:Apercu,sans-serif; ' +
    'position:relative; overflow:hidden;' +
    '" data-platform="instagram" data-layout="' + layout + '">';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: hero-banner — white bg + red accent bar layer at top
  // ────────────────────────────────────────────────────────────────
  if (layout === 'hero-banner') {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; display:flex; flex-direction:column; position:relative;">';
    // Thin red accent line at top — subtle layer
    html += '<div style="position:absolute; top:0; left:0; right:0; height:6px; background:' + primaryColor + ';"></div>';
    // Logo top-left
    html += '<div style="padding:40px 80px 0;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain; object-position:left;" crossorigin="anonymous">';
    html += '</div>';
    // Content area — generous whitespace
    html += '<div style="padding:' + (isTall ? '50px' : '40px') + ' 80px 50px; flex:1; display:flex; flex-direction:column;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-top:18px; font-weight:500;">' + esc(draft.subheadline) + '</div>';
    }
    // Thin red divider
    html += '<div style="width:60px; height:3px; background:' + primaryColor + '; margin:28px 0;"></div>';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:' + (photoUrl ? '52%' : '80%') + ';">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:30px; background:' + primaryColor + '; display:inline-block; padding:12px 36px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 140 : 100) + 'px; right:80px; width:260px; height:' + (isTall ? 220 : 190) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    // Icons as ghost watermarks
    if (draft.suggested_icons && draft.suggested_icons.length > 0 && !photoUrl) {
      html += '<div style="position:absolute; bottom:' + (isTall ? 200 : 160) + 'px; right:70px; display:flex; gap:20px; opacity:0.08;">';
      draft.suggested_icons.forEach(function(ic) { html += '<img src="/social-templates/icons/' + esc(ic) + '.png" style="height:130px; width:130px; object-fit:contain;" onerror="this.style.display=\'none\'">'; });
      html += '</div>';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:16px; line-height:1.4;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div></div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: split-diagonal
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'split-diagonal') {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; position:relative;">';
    // Subtle diagonal red wash — very light accent layer
    html += '<div style="position:absolute; top:0; left:0; width:100%; height:100%; background:' + primaryColor + '; clip-path:polygon(0 0, 35% 0, 0 45%); z-index:1; opacity:0.06;"></div>';
    // Thin diagonal red line accent
    html += '<div style="position:absolute; top:0; left:0; width:100%; height:100%; background:' + primaryColor + '; clip-path:polygon(0 47%, 37% 0, 38% 0, 0 48.5%); z-index:1;"></div>';
    // Logo top-left
    html += '<div style="position:relative; z-index:2; padding:40px 80px 0;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain; object-position:left;" crossorigin="anonymous">';
    html += '</div>';
    // Content — generous spacing
    html += '<div style="position:relative; z-index:2; padding:' + (isTall ? '50px' : '35px') + ' 80px 0;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:0.98; letter-spacing:-0.5px; max-width:65%;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-top:18px; font-weight:500; max-width:58%;">' + esc(draft.subheadline) + '</div>';
    }
    html += '</div>';
    // Bottom content
    html += '<div style="position:absolute; bottom:0; left:0; right:0; z-index:2; padding:0 80px 55px;">';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.55; max-width:55%; margin-bottom:22px;">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-bottom:30px; background:' + primaryColor + '; display:inline-block; padding:10px 32px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:12px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; top:50%; right:75px; transform:translateY(-50%); width:260px; height:260px; object-fit:contain; z-index:3; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: accent-frame
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'accent-frame') {
    var borderW = 10;
    html += '<div style="background:' + primaryColor + '; width:100%; height:100%; padding:' + borderW + 'px; box-sizing:border-box;">';
    html += '<div style="background:#FFFFFF; width:100%; height:100%; box-sizing:border-box; padding:55px 70px; display:flex; flex-direction:column; position:relative;">';
    // Logo top-center
    html += '<div style="text-align:center; margin-bottom:' + (isTall ? '35px' : '25px') + ';">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px; margin-bottom:14px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-bottom:24px; font-weight:500;">' + esc(draft.subheadline) + '</div>';
    }
    // Thin red divider
    html += '<div style="width:50px; height:3px; background:' + primaryColor + '; margin-bottom:24px;"></div>';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:' + (photoUrl ? '52%' : '78%') + ';">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:28px; background:' + primaryColor + '; display:inline-block; padding:10px 32px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 120 : 85) + 'px; right:60px; width:250px; height:' + (isTall ? 220 : 180) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 6px 20px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px; text-align:center;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div></div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: photo-dominant
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'photo-dominant' && photoUrl) {
    // Inspired by @chickfila_larambla: logo top-center, big red headline, product centered with drop-shadow
    html += '<div style="background:#FFFFFF; width:100%; height:100%; display:flex; flex-direction:column; position:relative;">';
    // Logo centered at top
    html += '<div style="padding:40px 80px 16px; text-align:center;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    // Headline — big red, centered
    html += '<div style="padding:0 80px; text-align:center;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:0.98; letter-spacing:-0.5px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      // Dot-separated style subtext like the real posts
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + (subSize - 2) + 'px; color:#888; margin-top:12px; font-weight:400; letter-spacing:1px;">' + esc(draft.subheadline) + '</div>';
    }
    html += '</div>';
    // Product photo — centered, moderate size with elegant drop-shadow
    html += '<div style="flex:1; display:flex; align-items:center; justify-content:center; padding:20px 80px;">';
    html += '<img src="' + photoUrl + '" style="max-width:48%; max-height:78%; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    html += '</div>';
    // Body + CTA at bottom
    html += '<div style="padding:0 80px 40px; text-align:center;">';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + (bodySize - 4) + 'px; color:' + textColor + '; line-height:1.45; max-width:75%; margin:0 auto 14px;">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; background:' + primaryColor + '; display:inline-block; padding:11px 34px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (draft.disclaimer) { html += '<div style="font-size:' + (disclaimerSize - 1) + 'px; color:#aaa; margin-top:14px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: bold-type
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'bold-type') {
    var bigSize = isTall ? 120 : 108;
    html += '<div style="background:#FFFFFF; width:100%; height:100%; padding:65px 80px; box-sizing:border-box; display:flex; flex-direction:column; position:relative;">';
    // Logo top-left small
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 8) + 'px; width:180px; object-fit:contain; object-position:left; margin-bottom:' + (isTall ? '40px' : '30px') + ';" crossorigin="anonymous">';
    // Massive headline — editorial impact
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + bigSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:0.92; letter-spacing:-2px; flex:0 0 auto;">' + esc(draft.headline) + '</div>';
    // Thin red line
    html += '<div style="width:60px; height:3px; background:' + primaryColor + '; margin:30px 0;"></div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + (subSize + 2) + 'px; color:' + navyColor + '; font-weight:500; margin-bottom:20px; line-height:1.35;">' + esc(draft.subheadline) + '</div>';
    }
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:75%;">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:30px; background:' + primaryColor + '; display:inline-block; padding:12px 36px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    // Ghost icons as watermark texture
    if (draft.suggested_icons && draft.suggested_icons.length > 0) {
      html += '<div style="position:absolute; bottom:' + (isTall ? 160 : 120) + 'px; right:65px; display:flex; gap:20px; opacity:0.06;">';
      draft.suggested_icons.forEach(function(ic) { html += '<img src="/social-templates/icons/' + esc(ic) + '.png" style="height:160px; width:160px; object-fit:contain;" onerror="this.style.display=\'none\'">'; });
      html += '</div>';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: icon-showcase
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'icon-showcase') {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; padding:60px 80px; box-sizing:border-box; display:flex; flex-direction:column; position:relative;">';
    // Logo top-center
    html += '<div style="text-align:center; margin-bottom:' + (isTall ? '30px' : '22px') + ';">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px; text-align:center;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-top:16px; font-weight:500; text-align:center;">' + esc(draft.subheadline) + '</div>';
    }
    // Icon strip — clean display with thin red borders
    if (draft.suggested_icons && draft.suggested_icons.length > 0) {
      html += '<div style="display:flex; gap:28px; justify-content:center; margin:35px 0; padding:28px 0; border-top:2px solid ' + primaryColor + '; border-bottom:2px solid ' + primaryColor + ';">';
      draft.suggested_icons.forEach(function(ic) { html += '<img src="/social-templates/icons/' + esc(ic) + '.png" style="height:110px; width:110px; object-fit:contain;" onerror="this.style.display=\'none\'">'; });
      html += '</div>';
    }
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:78%; text-align:center; margin:0 auto;">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="text-align:center; margin-top:28px;">';
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; background:' + primaryColor + '; display:inline-block; padding:11px 34px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
      html += '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 130 : 95) + 'px; right:65px; width:220px; height:180px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 6px 18px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px; text-align:center;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: navy-elegance
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'navy-elegance') {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; display:flex; flex-direction:column; position:relative;">';
    // Slim navy accent strip at top
    html += '<div style="position:absolute; top:0; left:0; right:0; height:8px; background:' + navyColor + ';"></div>';
    // Thin red accent line below navy
    html += '<div style="position:absolute; top:8px; left:0; right:0; height:4px; background:' + primaryColor + ';"></div>';
    // Logo top-center
    html += '<div style="position:relative; z-index:2; padding:40px 80px 0; text-align:center;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    // Content on white
    html += '<div style="position:relative; z-index:2; padding:' + (isTall ? '45px' : '32px') + ' 80px 50px; flex:1; display:flex; flex-direction:column;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + navyColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + primaryColor + '; margin-top:16px; font-weight:500;">' + esc(draft.subheadline) + '</div>';
    }
    // Thin red divider
    html += '<div style="width:50px; height:3px; background:' + primaryColor + '; margin:26px 0;"></div>';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:' + (photoUrl ? '52%' : '78%') + ';">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:28px; background:' + navyColor + '; display:inline-block; padding:11px 34px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 110 : 75) + 'px; right:70px; width:250px; height:' + (isTall ? 220 : 180) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div></div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: minimal-red
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'minimal-red') {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; position:relative; display:flex;">';
    // Thin vertical red accent bar on left
    html += '<div style="width:8px; background:' + primaryColor + '; flex:0 0 8px;"></div>';
    // Content — ultra clean
    html += '<div style="flex:1; padding:55px 75px 50px 65px; display:flex; flex-direction:column;">';
    // Logo top-left small
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 8) + 'px; width:180px; object-fit:contain; object-position:left; margin-bottom:' + (isTall ? '35px' : '25px') + ';" crossorigin="anonymous">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-top:18px; font-weight:500; line-height:1.35;">' + esc(draft.subheadline) + '</div>';
    }
    // Thin horizontal red line
    html += '<div style="width:50px; height:3px; background:' + primaryColor + '; margin:28px 0;"></div>';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:' + (photoUrl ? '52%' : '72%') + ';">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:30px; background:' + primaryColor + '; display:inline-block; padding:10px 32px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 130 : 95) + 'px; right:70px; width:250px; height:' + (isTall ? 210 : 175) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div></div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: warm-product (inspired by @chickfila official style)
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'warm-product') {
    // Inspired by @chickfila_larambla "Strawberry Hibiscus" & "El Combo Perfecto" style
    html += '<div style="background:#FFFFFF; width:100%; height:100%; display:flex; flex-direction:column; position:relative;">';
    // CFA logo centered at top
    html += '<div style="padding:40px 80px 16px; text-align:center;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    // Headline — big red, centered, editorial
    html += '<div style="padding:0 80px; text-align:center;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + (headlineSize + 6) + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:0.95; letter-spacing:-1px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      // Gray dot-separated subtext — like the real IG posts
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + (subSize - 2) + 'px; color:#999; margin-top:14px; font-weight:400; letter-spacing:1.5px;">' + esc(draft.subheadline) + '</div>';
    }
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + (bodySize - 4) + 'px; color:' + textColor + '; line-height:1.45; margin-top:14px; max-width:72%; margin-left:auto; margin-right:auto;">' + esc(draft.body_copy) + '</div>';
    }
    html += '</div>';
    // Product photo — centered, moderate with elegant shadow
    if (photoUrl) {
      html += '<div style="flex:1; display:flex; align-items:center; justify-content:center; padding:16px 80px;">';
      html += '<img src="' + photoUrl + '" style="max-width:48%; max-height:80%; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
      html += '</div>';
    } else {
      html += '<div style="flex:1;"></div>';
    }
    // Hand-drawn style "POR TIEMPO LIMITADO" circular stamp — tilted, like the real IG posts
    html += '<div style="position:absolute; top:' + (isTall ? 175 : 155) + 'px; right:55px; width:120px; height:120px; border-radius:50%; border:4px solid ' + primaryColor + '; display:flex; align-items:center; justify-content:center; transform:rotate(-15deg);">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:15px; font-weight:700; color:' + primaryColor + '; text-align:center; text-transform:uppercase; line-height:1.15; padding:8px;">POR<br>TIEMPO<br>LIMITADO</div>';
    html += '</div>';
    // Red tagline bar + CTA at bottom
    html += '<div style="padding:0 80px 35px; text-align:center;">';
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; background:' + primaryColor + '; display:inline-block; padding:12px 38px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // LAYOUT: event-calendar (inspired by @chickfila_larambla style)
  // ────────────────────────────────────────────────────────────────
  } else if (layout === 'event-calendar') {
    // Inspired by @chickfila_larambla "Calendario de Eventos" style
    html += '<div style="background:#FFFFFF; width:100%; height:100%; display:flex; flex-direction:column;">';
    // Logo centered at top
    html += '<div style="padding:38px 80px 18px; text-align:center;">';
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain;" crossorigin="anonymous">';
    html += '</div>';
    // Thin navy line + red line — clean separator
    html += '<div style="margin:0 80px; height:3px; background:' + navyColor + ';"></div>';
    html += '<div style="margin:0 80px; height:2px; background:' + primaryColor + ';"></div>';
    // Headline — navy, centered
    html += '<div style="padding:30px 80px 8px; text-align:center;">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + (headlineSize - 6) + 'px; font-weight:700; color:' + navyColor + '; text-transform:uppercase; line-height:0.98; letter-spacing:-0.5px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + primaryColor + '; margin-top:12px; font-weight:500;">' + esc(draft.subheadline) + '</div>';
    }
    html += '</div>';
    // Thin red divider centered
    html += '<div style="width:50px; height:2px; background:' + primaryColor + '; margin:14px auto 22px;"></div>';
    // Body — structured with small red dots, generous spacing
    html += '<div style="padding:0 80px; flex:1;">';
    if (draft.body_copy) {
      var bodyParts = draft.body_copy.split(/[.|\n]+/).filter(function(p) { return p.trim().length > 0; });
      if (bodyParts.length > 1) {
        bodyParts.forEach(function(part) {
          html += '<div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:16px;">';
          html += '<div style="width:8px; height:8px; border-radius:50%; background:' + primaryColor + '; flex:0 0 8px; margin-top:8px;"></div>';
          html += '<div style="font-family:Apercu,sans-serif; font-size:' + (bodySize - 2) + 'px; color:' + textColor + '; line-height:1.5;">' + esc(part.trim()) + '</div>';
          html += '</div>';
        });
      } else {
        html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.55; text-align:center; max-width:82%; margin:0 auto;">' + esc(draft.body_copy) + '</div>';
      }
    }
    html += '</div>';
    // Photo if available — small, centered
    if (photoUrl) {
      html += '<div style="padding:8px 80px; text-align:center;">';
      html += '<img src="' + photoUrl + '" style="max-width:35%; max-height:' + (isTall ? 200 : 165) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 6px 18px rgba(0,0,0,0.08));" crossorigin="anonymous">';
      html += '</div>';
    }
    // CTA pill + disclaimer
    html += '<div style="padding:18px 80px 32px; text-align:center;">';
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; background:' + primaryColor + '; display:inline-block; padding:11px 34px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:12px;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';
    html += '</div>';

  // ────────────────────────────────────────────────────────────────
  // FALLBACK: default layout
  // ────────────────────────────────────────────────────────────────
  } else {
    html += '<div style="background:#FFFFFF; width:100%; height:100%; padding:60px 80px; box-sizing:border-box; display:flex; flex-direction:column; position:relative;">';
    // Logo top-left
    html += '<img src="/img/cfa-logo-red.png" style="height:' + (logoH - 6) + 'px; width:200px; object-fit:contain; object-position:left; margin-bottom:' + (isTall ? '30px' : '22px') + ';" crossorigin="anonymous">';
    html += '<div style="font-family:Apercu Bold,Apercu,sans-serif; font-size:' + headlineSize + 'px; font-weight:700; color:' + primaryColor + '; text-transform:uppercase; line-height:1.0; letter-spacing:-0.5px; margin-bottom:14px;">' + esc(draft.headline) + '</div>';
    if (draft.subheadline) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + subSize + 'px; color:' + navyColor + '; margin-bottom:24px; font-weight:500;">' + esc(draft.subheadline) + '</div>';
    }
    html += '<div style="width:50px; height:3px; background:' + primaryColor + '; margin-bottom:24px;"></div>';
    if (draft.body_copy) {
      html += '<div style="font-family:Apercu,sans-serif; font-size:' + bodySize + 'px; color:' + textColor + '; line-height:1.6; max-width:' + (photoUrl ? '52%' : '78%') + ';">' + esc(draft.body_copy) + '</div>';
    }
    if (draft.cta_text) {
      html += '<div style="font-family:Apercu Medium,Apercu,sans-serif; font-size:' + ctaSize + 'px; color:#FFFFFF; font-weight:600; margin-top:28px; background:' + primaryColor + '; display:inline-block; padding:10px 32px; border-radius:50px;">' + esc(draft.cta_text) + '</div>';
    }
    if (photoUrl) {
      html += '<img src="' + photoUrl + '" style="position:absolute; bottom:' + (isTall ? 130 : 95) + 'px; right:70px; width:250px; height:' + (isTall ? 210 : 175) + 'px; object-fit:contain; mix-blend-mode:multiply; filter:drop-shadow(0 8px 24px rgba(0,0,0,0.10));" crossorigin="anonymous">';
    }
    html += '<div style="flex:1;"></div>';
    if (draft.disclaimer) { html += '<div style="font-size:' + disclaimerSize + 'px; color:#aaa; margin-top:14px; text-align:center;">' + esc(draft.disclaimer) + '</div>'; }
    html += '</div>';
  }

  html += '</div>'; // end canvas

  // Wrapper for scaled preview
  return '<div style="width:' + sw + 'px; height:' + sh + 'px; overflow:hidden; border-radius:8px; box-shadow:0 2px 12px rgba(0,0,0,0.12);">' + html + '</div>';
}

// ── Full Preview Modal ──────────────────────────────────────────────
function spFullPreview() {
  var canvas = document.getElementById('spCanvas_instagram');
  if (!canvas) return;

  var modal = document.getElementById('spFullModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'spFullModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); z-index:10000; display:flex; align-items:center; justify-content:center; cursor:pointer;';
    modal.onclick = function() { modal.style.display = 'none'; };
    modal.innerHTML = '<div id="spFullModalContent" style="max-width:90vw; max-height:90vh; overflow:auto; background:white; border-radius:8px;" onclick="event.stopPropagation()"></div>';
    document.body.appendChild(modal);
  }

  var content = document.getElementById('spFullModalContent');
  // Clone at 50% scale for viewability
  var clone = canvas.cloneNode(true);
  clone.style.transform = 'scale(0.55)';
  clone.style.transformOrigin = 'top left';
  var w = parseInt(canvas.style.width) * 0.55;
  var h = parseInt(canvas.style.height) * 0.55;
  content.style.width = w + 'px';
  content.style.height = h + 'px';
  content.style.overflow = 'hidden';
  content.innerHTML = '';
  content.appendChild(clone);
  modal.style.display = 'flex';
}

// ── Variant Selection ────────────────────────────────────────────────
function spSelectVariant(idx) {
  if (!SP.aiVariants || !SP.aiVariants[idx]) return;
  SP.selectedVariantIndex = idx;
  SP.useTemplate = false;
  SP.selectedPhoto.temp_url = SP.aiVariants[idx].temp_url;
  SP.selectedPhoto.filename = SP.aiVariants[idx].filename;
  SP.currentPost.photo_url = SP.aiVariants[idx].temp_url;
  spRenderPreviews();
}

function spSelectTemplate() {
  SP.useTemplate = true;
  // Keep selectedPhoto for data but switch main canvas to CSS template
  spRenderPreviews();
}

// ── Full Preview & Export for AI Graphics ────────────────────────────
function spFullPreviewAI() {
  if (!SP.selectedPhoto || !SP.selectedPhoto.temp_url) return;
  var modal = document.getElementById('spFullModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'spFullModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); z-index:10000; display:flex; align-items:center; justify-content:center; cursor:pointer;';
    modal.onclick = function() { modal.style.display = 'none'; };
    modal.innerHTML = '<div id="spFullModalContent" style="max-width:90vw; max-height:90vh; overflow:auto; background:white; border-radius:8px;" onclick="event.stopPropagation()"></div>';
    document.body.appendChild(modal);
  }
  var content = document.getElementById('spFullModalContent');
  content.style.width = 'auto';
  content.style.height = 'auto';
  content.innerHTML = '<img src="' + SP.selectedPhoto.temp_url + '" style="max-width:85vw; max-height:85vh; display:block;" crossorigin="anonymous">';
  modal.style.display = 'flex';
}

function spExportAI() {
  if (!SP.selectedPhoto || !SP.selectedPhoto.temp_url) { alert('No hay imagen para exportar'); return; }

  // Download the AI image directly
  var link = document.createElement('a');
  var postType = document.getElementById('spPostType') ? document.getElementById('spPostType').value : 'post';
  var now = new Date();
  var dateStr = now.toISOString().slice(0, 10);
  var fmt = document.getElementById('spIGFormat').value || 'square';
  link.download = postType + '_ai_' + fmt + '_' + dateStr + '.png';
  link.href = SP.selectedPhoto.temp_url;
  link.click();

  // Log export
  if (SP.currentPost) {
    fetch('/api/social-posts/export-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: SP.currentPost.id })
    }).catch(function() {});
  }
}

// ── Export PNG ───────────────────────────────────────────────────────
async function spExport() {
  var canvas = document.getElementById('spCanvas_instagram');
  if (!canvas) { alert('No hay preview para exportar'); return; }

  // Reset transform for full-res capture
  var origTransform = canvas.style.transform;
  canvas.style.transform = 'none';

  try {
    // Use html2canvas if available, otherwise try dom-to-image approach
    if (typeof html2canvas !== 'undefined') {
      var exportCanvas = await html2canvas(canvas, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff'
      });

      var link = document.createElement('a');
      var postType = document.getElementById('spPostType') ? document.getElementById('spPostType').value : 'post';
      var now = new Date();
      var dateStr = now.toISOString().slice(0, 10);
      var timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
      var fmt = document.getElementById('spIGFormat').value || 'square';
      link.download = postType + '_instagram_' + fmt + '_' + dateStr + '_' + timeStr + '.png';
      link.href = exportCanvas.toDataURL('image/png');
      link.click();

      // Log export
      if (SP.currentPost) {
        fetch('/api/social-posts/export-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ post_id: SP.currentPost.id })
        }).catch(function() {});
      }
    } else {
      alert('Biblioteca de exportación no cargada. Recarga la página.');
    }
  } catch (e) {
    alert('Error exportando: ' + e.message);
  } finally {
    canvas.style.transform = origTransform;
  }
}

// ── Post History ────────────────────────────────────────────────────
async function spLoadHistory(page) {
  page = page || 1;
  try {
    var res = await fetch('/api/social-posts/history?page=' + page);
    var data = await res.json();
    spRenderHistory(data);
  } catch (e) { console.error('History load error:', e); }
}

function spRenderHistory(data) {
  var container = document.getElementById('spHistoryList');
  if (!container) return;

  if (!data.posts || !data.posts.length) {
    container.innerHTML = '<p style="color:var(--text-light); text-align:center; padding:2rem;">No hay posts creados aún.</p>';
    return;
  }

  var typeLabels = {
    'weekly-special': 'Especial Semanal',
    'lto': 'Oferta Limitada',
    'community-event': 'Evento Comunitario',
    'seasonal': 'Temporada',
    'brand-moment': 'Momento de Marca'
  };

  var html = '<table class="responsive-table"><thead><tr>';
  html += '<th>Fecha</th><th>Tipo</th><th>Headline</th><th>Exportado</th><th>Creado por</th><th></th>';
  html += '</tr></thead><tbody>';

  data.posts.forEach(function(p) {
    var date = new Date(p.created_at).toLocaleDateString('es-PR', { month: 'short', day: 'numeric', year: 'numeric' });
    html += '<tr>';
    html += '<td>' + date + '</td>';
    html += '<td><span class="badge">' + (typeLabels[p.post_type] || p.post_type) + '</span></td>';
    html += '<td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(p.ig_headline || p.headline) + '</td>';
    html += '<td>' + (p.ig_exported ? '<span style="color:var(--brand-green);">Exportado</span>' : '<span style="color:var(--text-light);">\u2014</span>') + '</td>';
    html += '<td>' + esc(p.created_by) + '</td>';
    html += '<td><button class="btn btn-sm" onclick="spViewPost(' + p.id + ')">Ver</button></td>';
    html += '</tr>';
  });

  html += '</tbody></table>';

  // Pagination
  if (data.pages > 1) {
    html += '<div style="display:flex; gap:0.5rem; justify-content:center; margin-top:1rem;">';
    for (var i = 1; i <= data.pages; i++) {
      html += '<button class="btn btn-sm' + (i === data.page ? ' btn-primary' : '') + '" onclick="spLoadHistory(' + i + ')">' + i + '</button>';
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

async function spViewPost(id) {
  try {
    var res = await fetch('/api/social-posts/post/' + id);
    var post = await res.json();

    SP.currentPost = {
      id: post.id,
      instagram_draft: {
        headline: post.ig_headline,
        subheadline: post.ig_subheadline,
        body_copy: post.ig_body,
        cta_text: post.ig_cta,
        suggested_icons: JSON.parse(post.ig_icons || '[]'),
        disclaimer: ''
      },
      brand: {
        primary_color: SP.brandConfig.primary_color || '#DD0033',
        secondary_color: SP.brandConfig.secondary_color || '#004F71',
        accent_color: SP.brandConfig.accent_color || '#E52216',
        bg_color: SP.brandConfig.bg_color || '#FFFFFF',
        text_color: SP.brandConfig.text_color || '#333333',
        brand_name: SP.brandConfig.brand_name || 'Chick-fil-A La Rambla'
      },
      photo_url: post.photo_url
    };

    SP.editedIG = Object.assign({}, SP.currentPost.instagram_draft);

    // Set form values for regeneration
    if (document.getElementById('spPostType')) document.getElementById('spPostType').value = post.post_type;
    if (document.getElementById('spIGFormat')) document.getElementById('spIGFormat').value = post.ig_format;
    if (document.getElementById('spHeadline')) document.getElementById('spHeadline').value = post.headline;
    if (document.getElementById('spKeyDetail')) document.getElementById('spKeyDetail').value = post.key_detail || '';
    if (document.getElementById('spContext')) document.getElementById('spContext').value = post.context || '';

    spRenderPreviews();
  } catch (e) {
    alert('Error cargando post: ' + e.message);
  }
}
