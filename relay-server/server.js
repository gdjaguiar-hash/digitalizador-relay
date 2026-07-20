// Servidor de relay do "Enviar do Celular". Só existe pra resolver o problema
// de rede local (Wi-Fi privada/pública, firewall bloqueando conexão direta
// entre celular e PC): aqui, os dois lados só fazem conexões de SAÍDA pra
// este servidor, então nenhuma configuração de rede local atrapalha.
//
// Não há armazenamento em disco nem banco de dados — tudo fica em memória
// (RAM) só até o PC buscar (poll) e é descartado na hora. Se o processo
// reiniciar, tudo se perde, o que é esperado e aceitável aqui.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 40 * 1024 * 1024; // ~40MB por lote de fotos
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000; // limite absoluto de vida da sessão
const SWEEP_INTERVAL_MS = 30 * 1000;

// Pasta onde as versões publicadas do app ficam: o instalador (.exe) + o
// latest.yml gerados por `npm run dist:installer` no temp-app a cada release,
// publicados via a página /admin (ou manualmente). O electron-updater lê essa
// pasta via provider "generic" (ver temp-app/package.json -> build.publish).
const UPDATES_DIR = path.join(__dirname, 'updates');
const UPDATE_CONTENT_TYPES = { '.yml': 'text/yaml; charset=utf-8', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream' };
const UPDATE_FILENAME_RE = /^[A-Za-z0-9._-]+\.(exe|yml|blockmap)$/;
// Painel /admin: login com sessão (cookie) + lista de apps + publicação de
// novas versões. A senha vem de ADMIN_TOKEN nas env vars do Render — sem essa
// variável configurada, o login fica bloqueado por padrão. Sessões ficam em
// memória (Map), como as sessões de QR — some tudo se o processo reiniciar.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ADMIN_MAX_BODY_BYTES = 250 * 1024 * 1024; // instalador + blockmap + yml
const ADMIN_SESSION_COOKIE = 'digitalizador_admin_session';
const ADMIN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// sessionId -> expiresAt (ms)
const adminSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, expiresAt] of adminSessions) {
    if (now > expiresAt) adminSessions.delete(id);
  }
}, SWEEP_INTERVAL_MS);

// Apps disponíveis pra publicar no painel. Adicione outro item aqui quando
// tiver um segundo app — cada um ganha sua própria tela de publicação.
const APPS = [
  { id: 'digitalizador', name: 'Digitalizador', description: 'Digitalizador de documentos para desktop (Electron + Windows).' }
];

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function isAuthenticated(req) {
  const sid = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!sid) return false;
  const expiresAt = adminSessions.get(sid);
  if (!expiresAt || Date.now() > expiresAt) { adminSessions.delete(sid); return false; }
  return true;
}

function createAdminSession() {
  const id = crypto.randomBytes(24).toString('hex');
  adminSessions.set(id, Date.now() + ADMIN_SESSION_MAX_AGE_MS);
  return id;
}

function passwordMatches(candidate) {
  if (!ADMIN_TOKEN || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('corpo grande demais')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('corpo inválido')); }
    });
    req.on('error', reject);
  });
}

// sessionId -> { createdAt, lastTouch, phoneLastActivity, queue: [] }
const sessions = new Map();

function getOrCreateSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { createdAt: Date.now(), lastTouch: Date.now(), phoneLastActivity: null, queue: [] };
    sessions.set(id, s);
  }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastTouch > SESSION_MAX_AGE_MS) sessions.delete(id);
  }
}, SWEEP_INTERVAL_MS);
function paginaMobile(sessionId) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Digitalizador</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: #E5E5E5; color: #1A1A1A; font-family: -apple-system, "Segoe UI", Inter, sans-serif; }
  body { overflow: hidden; }

  /* --- Tela inicial (duas opções) --- */
  #telaInicial { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 4px; }
  p { color: #6B7280; font-size: 0.85rem; margin: 0 0 28px; }
  .opcoes { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 340px; }
  label.btn, button.btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: #1A1A1A; color: #FFFFFF; padding: 22px; font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer; border: none; font-family: inherit; }
  .btn.secundario { background: #FFFFFF; color: #1A1A1A; border: 1px solid #1A1A1A; }
  .btn svg { width: 28px; height: 28px; }
  input[type=file] { display: none; }
  .status { margin-top: 22px; font-size: 0.8rem; min-height: 1.2em; }
  .status.ok { color: #1A1A1A; font-weight: 600; }
  .status.erro { color: #B33A3A; font-weight: 600; }
  .contador { font-size: 0.7rem; color: #6B7280; margin-top: 4px; }
  /* --- Câmera ao vivo: tira várias fotos em sequência --- */
  #telaCamera { display: none; position: fixed; inset: 0; background: #000; flex-direction: column; }
  #video { flex: 1; width: 100%; object-fit: cover; background: #000; min-height: 0; }
  .camera-topbar { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: linear-gradient(rgba(0,0,0,0.55), transparent); }
  .icon-btn { width: 40px; height: 40px; border-radius: 999px; background: rgba(0,0,0,0.45); color: #fff; border: none; display: flex; align-items: center; justify-content: center; }
  .camera-counter { color: #fff; font-size: 0.75rem; font-weight: 600; background: rgba(0,0,0,0.45); padding: 6px 12px; }
  .thumbs-strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px; background: #000; }
  .thumbs-strip img { width: 52px; height: 52px; object-fit: cover; border: 2px solid #D4AF37; flex-shrink: 0; }
  .camera-controls { display: flex; align-items: center; justify-content: center; gap: 20px; padding: 18px 16px 28px; background: #000; }
  .shutter-btn { width: 68px; height: 68px; border-radius: 999px; background: #fff; border: 5px solid #1A1A1A; padding: 0; }
  .btn-concluir { background: #D4AF37; color: #1A1A1A; border: none; padding: 12px 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .btn-concluir:disabled { opacity: 0.35; }
  .erro-camera { color: #fff; text-align: center; padding: 24px; font-size: 0.85rem; }

    /* --- Revisão: escolher quais fotos capturadas vão ser enviadas ---
     position:fixed + inset:0 (em vez de min-height:100vh) porque no mobile
     100vh costuma incluir a área da barra de endereço do navegador; com
     overflow:hidden no body, isso empurrava o botão "Enviar Fotos" pra fora
     da área visível, só alcançável dando zoom-out. Fixed com inset:0 sempre
     bate certinho com a área visível de verdade, e só a grade rola por dentro. */
  #telaRevisao { display: none; position: fixed; inset: 0; flex-direction: column; padding: 20px; background: #E5E5E5; }
  #telaRevisao h2 { font-size: 1.1rem; margin: 4px 0 2px; }
  #telaRevisao .sub { color: #6B7280; font-size: 0.78rem; margin: 0 0 16px; }
  .review-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; overflow-y: auto; flex: 1; min-height: 0; }
  .review-item { position: relative; aspect-ratio: 1; }
  .review-item img { width: 100%; height: 100%; object-fit: cover; border: 1px solid #1A1A1A; }
  .review-item.removida img { opacity: 0.25; }
  .review-item button { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; border-radius: 999px; background: #1A1A1A; color: #fff; border: none; font-size: 0.9rem; line-height: 1; }
  .review-item.removida button { background: #FFFFFF; color: #1A1A1A; border: 1px solid #1A1A1A; }
  .review-actions { display: flex; gap: 10px; padding-top: 16px; }
  .review-actions .btn { flex: 1; padding: 16px; }
</style>
</head>
<body>

  <div id="telaInicial">
    <h1>Digitalizador</h1>
    <p>Envie fotos deste celular direto para o computador</p>
    <div class="opcoes">
      <button class="btn" id="btnAbrirCamera" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        Tirar Foto
      </button>
      <label class="btn secundario" for="galeria">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="0"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        Enviar da Galeria
        <input id="galeria" type="file" accept="image/*" multiple />
      </label>
    </div>
    <div id="status" class="status"></div>
    <div id="contador" class="contador"></div>
  </div>
  <div id="telaCamera">
    <video id="video" autoplay playsinline muted></video>
    <canvas id="captureCanvas" style="display:none;"></canvas>
    <div class="camera-topbar">
      <button class="icon-btn" id="btnFecharCamera" type="button" aria-label="Fechar">✕</button>
      <span class="camera-counter" id="contadorFotos">0 fotos</span>
    </div>
    <div id="erroCamera" class="erro-camera" style="display:none;"></div>
    <div class="thumbs-strip" id="thumbsStrip"></div>
    <div class="camera-controls">
      <button class="shutter-btn" id="btnCapturar" type="button" aria-label="Tirar foto"></button>
      <button class="btn-concluir" id="btnConcluirCaptura" type="button" disabled>Concluir</button>
    </div>
  </div>

  <div id="telaRevisao">
    <h2>Revisar Fotos</h2>
    <p class="sub">Toque no X pra excluir alguma antes de enviar</p>
    <div class="review-grid" id="reviewGrid"></div>
    <div class="review-actions">
      <button class="btn secundario" id="btnTirarMais" type="button">+ Tirar mais</button>
      <button class="btn" id="btnEnviarTodas" type="button">Enviar Fotos</button>
    </div>
  </div>
<script>
  const SESSION = ${JSON.stringify(sessionId)};
  const statusEl = document.getElementById('status');
  const contadorEl = document.getElementById('contador');
  let totalEnviadas = 0;

  // --- Envio (compartilhado pelas duas origens: câmera e galeria) ---
  function lerComoBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function enviarArquivos(files) {
    if (!files || !files.length) return;
    statusEl.textContent = 'Enviando ' + files.length + ' foto(s)...';
    statusEl.className = 'status';
    try {
      const payload = [];
      for (const file of files) {
        payload.push({ name: file.name, type: file.type || 'image/jpeg', dataBase64: await lerComoBase64(file) });
      }
      const res = await fetch('/api/upload/' + SESSION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: payload })
      });
      if (!res.ok) throw new Error('falhou');
      totalEnviadas += files.length;
      statusEl.textContent = 'Enviado! Já apareceu no computador.';
      statusEl.className = 'status ok';
      contadorEl.textContent = totalEnviadas + ' foto(s) enviada(s) nesta sessão';
    } catch (e) {
      statusEl.textContent = 'Link expirado ou sem conexão. Gere um novo QR no computador.';
      statusEl.className = 'status erro';
    }
  }

  document.getElementById('galeria').addEventListener('change', (e) => {
    enviarArquivos(Array.from(e.target.files));
    e.target.value = '';
  });
  // --- Câmera ao vivo: tira quantas fotos quiser antes de enviar ---
  const telaInicial = document.getElementById('telaInicial');
  const telaCamera = document.getElementById('telaCamera');
  const telaRevisao = document.getElementById('telaRevisao');
  const video = document.getElementById('video');
  const canvas = document.getElementById('captureCanvas');
  const thumbsStrip = document.getElementById('thumbsStrip');
  const contadorFotos = document.getElementById('contadorFotos');
  const btnConcluirCaptura = document.getElementById('btnConcluirCaptura');
  const erroCamera = document.getElementById('erroCamera');
  const reviewGrid = document.getElementById('reviewGrid');

  let stream = null;
  let imageCapture = null;
  let capturadas = []; // { dataUrl, blobUrl }

  async function abrirCamera() {
    telaInicial.style.display = 'none';
    telaCamera.style.display = 'flex';
    erroCamera.style.display = 'none';
    video.style.display = 'block';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 4096 },
          height: { ideal: 2160 }
        },
        audio: false
      });
      video.srcObject = stream;

      const track = stream.getVideoTracks()[0];
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : null;
        if (caps && caps.focusMode && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch (e) {
        // foco manual/capacidades indisponíveis (comum no iOS) — segue com o padrão do navegador
      }

      imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
    } catch (e) {
      video.style.display = 'none';
      erroCamera.style.display = 'block';
      erroCamera.textContent = 'Não foi possível acessar a câmera. Verifique a permissão do navegador e tente novamente.';
    }
  }

  function pararCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }
  function renderThumbsStrip() {
    thumbsStrip.innerHTML = '';
    capturadas.forEach(foto => {
      const img = document.createElement('img');
      img.src = foto.dataUrl;
      thumbsStrip.appendChild(img);
    });
    contadorFotos.textContent = capturadas.length + (capturadas.length === 1 ? ' foto' : ' fotos');
    btnConcluirCaptura.disabled = capturadas.length === 0;
    thumbsStrip.scrollLeft = thumbsStrip.scrollWidth;
  }

  function capturarViaCanvas() {
    if (!video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.95);
  }

  function blobParaDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  document.getElementById('btnCapturar').addEventListener('click', async () => {
    if (!stream) return;
    let dataUrl = null;
    if (imageCapture) {
      try {
        const blob = await imageCapture.takePhoto();
        dataUrl = await blobParaDataUrl(blob);
      } catch (e) {
        dataUrl = capturarViaCanvas();
      }
    } else {
      dataUrl = capturarViaCanvas();
    }
    if (!dataUrl) return;
    capturadas.push({ dataUrl, id: Date.now() + '-' + capturadas.length });
    renderThumbsStrip();
  });
  document.getElementById('btnFecharCamera').addEventListener('click', () => {
    pararCamera();
    if (capturadas.length > 0) { mostrarRevisao(); }
    else { telaCamera.style.display = 'none'; telaInicial.style.display = 'flex'; }
  });

  document.getElementById('btnAbrirCamera').addEventListener('click', abrirCamera);

  btnConcluirCaptura.addEventListener('click', () => {
    pararCamera();
    mostrarRevisao();
  });

  function mostrarRevisao() {
    telaCamera.style.display = 'none';
    telaRevisao.style.display = 'flex';
    renderReviewGrid();
  }

  function renderReviewGrid() {
    reviewGrid.innerHTML = '';
    capturadas.forEach(foto => {
      const item = document.createElement('div');
      item.className = 'review-item' + (foto.removida ? ' removida' : '');
      const img = document.createElement('img');
      img.src = foto.dataUrl;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = foto.removida ? '↺' : '✕';
      btn.addEventListener('click', () => { foto.removida = !foto.removida; renderReviewGrid(); });
      item.appendChild(img); item.appendChild(btn);
      reviewGrid.appendChild(item);
    });
  }
  document.getElementById('btnTirarMais').addEventListener('click', () => {
    telaRevisao.style.display = 'none';
    abrirCamera();
    renderThumbsStrip();
  });

  document.getElementById('btnEnviarTodas').addEventListener('click', async () => {
    const restantes = capturadas.filter(f => !f.removida);
    if (!restantes.length) return;
    const files = restantes.map((foto, i) => {
      const bin = atob(foto.dataUrl.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      return new File([bytes], 'foto-camera-' + Date.now() + '-' + i + '.jpg', { type: 'image/jpeg' });
    });
    telaRevisao.style.display = 'none';
    telaInicial.style.display = 'flex';
    capturadas = [];
    await enviarArquivos(files);
  });
</script>
</body>
</html>`;
}

function paginaExpirada() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Digitalizador</title>
<style>body{margin:0;min-height:100vh;background:#E5E5E5;color:#1A1A1A;font-family:-apple-system,"Segoe UI",Inter,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;}</style>
</head><body><div><h1 style="font-size:1.2rem;">Link expirado</h1><p style="color:#6B7280;font-size:0.85rem;">Gere um novo QR Code no computador e escaneie novamente.</p></div></body></html>`;
}
const ADMIN_ESTILO_BASE = `
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #E5E5E5; color: #1A1A1A; font-family: -apple-system, "Segoe UI", Inter, sans-serif; }
  a { color: inherit; }
  .status { margin-top: 16px; font-size: 0.82rem; min-height: 1.2em; }
  .status.ok { color: #1A7A3A; font-weight: 600; }
  .status.erro { color: #B33A3A; font-weight: 600; }
`;

function paginaLogin(erro) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Digitalizador — Painel</title>
<style>
${ADMIN_ESTILO_BASE}
  body { display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 1px solid #1A1A1A; padding: 32px; width: 100%; max-width: 380px; }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  p { color: #6B7280; font-size: 0.82rem; margin: 0 0 24px; }
  label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin: 16px 0 6px; }
  input[type=password] { width: 100%; padding: 10px; border: 1px solid #1A1A1A; font-size: 0.85rem; background: #fff; }
  button { margin-top: 24px; width: 100%; padding: 12px; background: #1A1A1A; color: #fff; border: none; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; cursor: pointer; }
  button:disabled { opacity: 0.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Painel Digitalizador</h1>
    <p>Entre com a senha de administrador.</p>
    <form id="f">
      <label for="senha">Senha</label>
      <input type="password" id="senha" autocomplete="current-password" autofocus required />
      <button type="submit" id="btn">Entrar</button>
      <div id="status" class="status">${erro ? `<span class="erro">${erro}</span>` : ''}</div>
    </form>
  </div>
<script>
  const form = document.getElementById('f');
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    statusEl.textContent = 'Entrando...';
    statusEl.className = 'status';
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: document.getElementById('senha').value })
      });
      if (!res.ok) throw new Error('Senha incorreta.');
      window.location.href = '/admin';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status erro';
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
function paginaDashboard() {
  const cards = APPS.map((app) => `
    <a class="app-card" href="/admin/apps/${app.id}">
      <h2>${app.name}</h2>
      <p>${app.description}</p>
    </a>`).join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Digitalizador — Painel</title>
<style>
${ADMIN_ESTILO_BASE}
  body { padding: 24px; }
  header { display: flex; justify-content: space-between; align-items: center; max-width: 720px; margin: 0 auto 24px; }
  h1 { font-size: 1.2rem; margin: 0; }
  button.sair { background: none; border: 1px solid #1A1A1A; padding: 8px 14px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; }
  .apps { max-width: 720px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .app-card { display: block; background: #fff; border: 1px solid #1A1A1A; padding: 20px; text-decoration: none; }
  .app-card h2 { font-size: 1rem; margin: 0 0 6px; }
  .app-card p { color: #6B7280; font-size: 0.78rem; margin: 0; }
</style>
</head>
<body>
  <header>
    <h1>Painel Digitalizador</h1>
    <button class="sair" id="sair">Sair</button>
  </header>
  <div class="apps">${cards}</div>
<script>
  document.getElementById('sair').addEventListener('click', async () => {
    await fetch('/admin/logout', { method: 'POST' });
    window.location.href = '/admin';
  });
</script>
</body>
</html>`;
}
function paginaPublicarApp(app) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${app.name} — Publicar versão</title>
<style>
${ADMIN_ESTILO_BASE}
  body { display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 1px solid #1A1A1A; padding: 32px; width: 100%; max-width: 440px; }
  .voltar { display: inline-block; font-size: 0.75rem; text-decoration: none; color: #6B7280; margin-bottom: 16px; }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  p { color: #6B7280; font-size: 0.82rem; margin: 0 0 24px; }
  label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin: 16px 0 6px; }
  input[type=file] { width: 100%; padding: 10px; border: 1px solid #1A1A1A; font-size: 0.85rem; background: #fff; }
  button { margin-top: 24px; width: 100%; padding: 12px; background: #1A1A1A; color: #fff; border: none; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  .hint { font-size: 0.72rem; color: #6B7280; margin-top: 6px; }
  .barra-fundo { margin-top: 16px; height: 8px; background: #E5E5E5; border: 1px solid #1A1A1A; display: none; }
  .barra-fundo.ativa { display: block; }
  .barra-progresso { height: 100%; width: 0%; background: #1A1A1A; transition: width 0.1s linear; }
  .porcentagem { font-size: 0.75rem; color: #6B7280; margin-top: 4px; text-align: right; }
</style>
</head>
<body>
  <div class="card">
    <a class="voltar" href="/admin">&larr; Painel</a>
    <h1>${app.name}</h1>
    <p>Envie o instalador (.exe) e o latest.yml gerados por "npm run dist:installer".</p>
    <form id="f">
      <label for="files">Arquivos (.exe, .yml, .blockmap)</label>
      <input type="file" id="files" multiple accept=".exe,.yml,.blockmap" required />
      <div class="hint">Selecione o Digitalizador-Setup-X.Y.Z.exe, o latest.yml e (se existir) o .blockmap juntos.</div>

      <div class="barra-fundo" id="barraFundo"><div class="barra-progresso" id="barraProgresso"></div></div>
      <div class="porcentagem" id="porcentagem"></div>

      <button type="submit" id="btn">Publicar</button>
      <div id="status" class="status"></div>
    </form>
  </div>
<script>
  const form = document.getElementById('f');
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('btn');
  const barraFundo = document.getElementById('barraFundo');
  const barraProgresso = document.getElementById('barraProgresso');
  const porcentagemEl = document.getElementById('porcentagem');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const files = document.getElementById('files').files;
    if (!files.length) return;
    const fd = new FormData();
    for (const file of files) fd.append('files', file, file.name);

    btn.disabled = true;
    statusEl.textContent = '';
    statusEl.className = 'status';
    barraFundo.classList.add('ativa');
    barraProgresso.style.width = '0%';
    porcentagemEl.textContent = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/admin/upload/${app.id}');
    xhr.upload.addEventListener('progress', (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      barraProgresso.style.width = pct + '%';
      porcentagemEl.textContent = pct + '%';
    });
    xhr.onload = () => {
      btn.disabled = false;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        statusEl.textContent = 'Publicado! ' + (data.arquivos || []).join(', ');
        statusEl.className = 'status ok';
        porcentagemEl.textContent = '100%';
      } else {
        statusEl.textContent = 'Erro: ' + (data.erro || 'falhou');
        statusEl.className = 'status erro';
      }
    };
    xhr.onerror = () => {
      btn.disabled = false;
      statusEl.textContent = 'Erro de conexão.';
      statusEl.className = 'status erro';
    };
    xhr.send(fd);
  });
</script>
</body>
</html>`;
}
function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Parser de multipart/form-data simples e sem dependências — suficiente pra
// receber os poucos arquivos (.exe/.yml/.blockmap) da página /admin. Assume
// partes bem formadas (é sempre o browser, via FormData, gerando o corpo).
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    let partBuf = buffer.slice(start + boundaryBuf.length, next);
    if (partBuf.slice(0, 2).toString('latin1') === '\r\n') partBuf = partBuf.slice(2);
    if (partBuf.slice(-2).toString('latin1') === '\r\n') partBuf = partBuf.slice(0, -2);
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
      const data = partBuf.slice(headerEnd + 4);
      const dispositionMatch = headerStr.match(/name="([^"]*)"(?:; filename="([^"]*)")?/i);
      if (dispositionMatch) {
        parts.push({ name: dispositionMatch[1], filename: dispositionMatch[2] || null, data });
      }
    }
    start = next;
  }
  return parts;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // ex.: ['s', 'ID'] ou ['api','upload','ID']

  // GET /updates/:arquivo -> serve latest.yml e os instaladores publicados
  // (auto-update do app desktop via electron-updater, provider "generic")
  if (req.method === 'GET' && parts[0] === 'updates' && parts.length === 2) {
    const nome = parts[1];
    if (!/^[A-Za-z0-9._-]+$/.test(nome)) { res.writeHead(400); res.end('nome inválido'); return; }
    const filePath = path.join(UPDATES_DIR, nome);
    if (!filePath.startsWith(UPDATES_DIR)) { res.writeHead(400); res.end('nome inválido'); return; }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('não encontrado'); return; }
      const type = UPDATE_CONTENT_TYPES[path.extname(nome).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }
  // GET /admin -> painel (login se não autenticado, dashboard se autenticado)
  if (req.method === 'GET' && parts[0] === 'admin' && parts.length === 1) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(isAuthenticated(req) ? paginaDashboard() : paginaLogin());
    return;
  }

  // POST /admin/login -> confere a senha e abre sessão (cookie httpOnly)
  if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'login' && parts.length === 2) {
    readJsonBody(req, 10 * 1024).then((body) => {
      if (!passwordMatches(body.senha)) { jsonResponse(res, 401, { erro: 'senha incorreta' }); return; }
      const sessionId = createAdminSession();
      res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_MAX_AGE_MS / 1000)}`);
      jsonResponse(res, 200, { ok: true });
    }).catch(() => jsonResponse(res, 400, { erro: 'corpo inválido' }));
    return;
  }

  // POST /admin/logout -> encerra a sessão
  if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'logout' && parts.length === 2) {
    const sid = parseCookies(req)[ADMIN_SESSION_COOKIE];
    if (sid) adminSessions.delete(sid);
    res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    jsonResponse(res, 200, { ok: true });
    return;
  }
  // GET /admin/apps/:id -> tela de publicação de um app específico
  if (req.method === 'GET' && parts[0] === 'admin' && parts[1] === 'apps' && parts.length === 3) {
    if (!isAuthenticated(req)) { res.writeHead(302, { Location: '/admin' }); res.end(); return; }
    const app = APPS.find((a) => a.id === parts[2]);
    if (!app) { res.writeHead(404); res.end('app não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paginaPublicarApp(app));
    return;
  }

  // POST /admin/upload/:appId -> recebe o instalador + latest.yml (multipart/form-data)
  if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'upload' && parts.length === 3) {
    if (!isAuthenticated(req)) { jsonResponse(res, 401, { erro: 'não autorizado — faça login novamente' }); return; }
    if (!APPS.some((a) => a.id === parts[2])) { jsonResponse(res, 404, { erro: 'app não encontrado' }); return; }
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) { jsonResponse(res, 400, { erro: 'content-type inválido' }); return; }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    let size = 0; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > ADMIN_MAX_BODY_BYTES) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (!fs.existsSync(UPDATES_DIR)) fs.mkdirSync(UPDATES_DIR, { recursive: true });
        const partes = parseMultipart(Buffer.concat(chunks), boundary);
        const salvos = [];
        for (const p of partes) {
          if (!p.filename) continue;
          if (!UPDATE_FILENAME_RE.test(p.filename)) {
            jsonResponse(res, 400, { erro: `nome de arquivo não permitido: ${p.filename}` });
            return;
          }
          fs.writeFileSync(path.join(UPDATES_DIR, p.filename), p.data);
          salvos.push(p.filename);
        }
        if (!salvos.length) { jsonResponse(res, 400, { erro: 'nenhum arquivo recebido' }); return; }
        jsonResponse(res, 200, { ok: true, arquivos: salvos });
      } catch (e) {
        jsonResponse(res, 500, { erro: 'falha ao salvar arquivos' });
      }
    });
    return;
  }
  // GET /s/:id -> página mobile
  if (req.method === 'GET' && parts[0] === 's' && parts.length === 2) {
    const id = parts[1];
    if (!SESSION_ID_RE.test(id)) { res.writeHead(400); res.end('id inválido'); return; }
    const s = getOrCreateSession(id);
    s.lastTouch = Date.now();
    s.phoneLastActivity = Date.now();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paginaMobile(id));
    return;
  }

  // POST /api/upload/:id -> celular envia fotos
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'upload' && parts.length === 3) {
    const id = parts[2];
    if (!SESSION_ID_RE.test(id)) { jsonResponse(res, 400, { erro: 'id inválido' }); return; }
    let size = 0; const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const files = Array.isArray(body.files) ? body.files : [];
        const s = getOrCreateSession(id);
        s.lastTouch = Date.now();
        s.phoneLastActivity = Date.now();
        s.queue.push(...files);
        jsonResponse(res, 200, { ok: true, recebidas: files.length });
      } catch (e) {
        jsonResponse(res, 400, { erro: 'corpo inválido' });
      }
    });
    return;
  }
  // GET /api/poll/:id -> PC busca fotos pendentes (e esvazia a fila)
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'poll' && parts.length === 3) {
    const id = parts[2];
    if (!SESSION_ID_RE.test(id)) { jsonResponse(res, 400, { erro: 'id inválido' }); return; }
    const s = sessions.get(id);
    if (!s) { jsonResponse(res, 200, { existe: false, phoneLastActivity: null, photos: [] }); return; }
    s.lastTouch = Date.now();
    const photos = s.queue;
    s.queue = [];
    jsonResponse(res, 200, { existe: true, phoneLastActivity: s.phoneLastActivity, photos });
    return;
  }

  // DELETE /api/session/:id -> PC libera a sessão ao fechar o painel
  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'session' && parts.length === 3) {
    sessions.delete(parts[2]);
    jsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && parts.length === 0) {
    jsonResponse(res, 200, { servico: 'digitalizador-relay', status: 'ok' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(paginaExpirada());
});

server.listen(PORT, () => {
  console.log(`Relay do Digitalizador ouvindo na porta ${PORT}`);
});
