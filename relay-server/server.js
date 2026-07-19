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

const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 40 * 1024 * 1024; // ~40MB por lote de fotos
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000; // limite absoluto de vida da sessão
const SWEEP_INTERVAL_MS = 30 * 1000;

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
  body { margin: 0; min-height: 100vh; background: #E5E5E5; color: #1A1A1A; font-family: -apple-system, "Segoe UI", Inter, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 4px; }
  p { color: #6B7280; font-size: 0.85rem; margin: 0 0 28px; }
  .opcoes { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 340px; }
  label.btn { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; background: #1A1A1A; color: #FFFFFF; padding: 22px; font-size: 0.8rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer; border: none; }
  label.btn.secundario { background: #FFFFFF; color: #1A1A1A; border: 1px solid #1A1A1A; }
  label.btn svg { width: 28px; height: 28px; }
  input[type=file] { display: none; }
  .status { margin-top: 22px; font-size: 0.8rem; min-height: 1.2em; }
  .status.ok { color: #1A1A1A; font-weight: 600; }
  .status.erro { color: #B33A3A; font-weight: 600; }
  .contador { font-size: 0.7rem; color: #6B7280; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Digitalizador</h1>
  <p>Envie fotos deste celular direto para o computador</p>
  <div class="opcoes">
    <label class="btn" for="camera">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      Tirar Foto
      <input id="camera" type="file" accept="image/*" capture="environment" multiple />
    </label>
    <label class="btn secundario" for="galeria">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="0"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
      Enviar da Galeria
      <input id="galeria" type="file" accept="image/*" multiple />
    </label>
  </div>
  <div id="status" class="status"></div>
  <div id="contador" class="contador"></div>
<script>
  const SESSION = ${JSON.stringify(sessionId)};
  const statusEl = document.getElementById('status');
  const contadorEl = document.getElementById('contador');
  let totalEnviadas = 0;

  function lerComoBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function enviar(files) {
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

  document.getElementById('camera').addEventListener('change', (e) => { enviar(e.target.files); e.target.value = ''; });
  document.getElementById('galeria').addEventListener('change', (e) => { enviar(e.target.files); e.target.value = ''; });
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

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // ex.: ['s', 'ID'] ou ['api','upload','ID']

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
