const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const TL = require('tiktok-live-connector');
const Conn = TL.WebcastPushConnection || TL.TikTokLiveConnection;
const TIKTOK_USER = process.env.TIKTOK_USER || 'www.souza7k', PORT = process.env.PORT || 8080;

const SP = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SPOTIFY_CLIENT_SECRET, redirect: process.env.SPOTIFY_REDIRECT_URI, refresh: process.env.SPOTIFY_REFRESH_TOKEN };
const SP_ON = !!(SP.id && SP.secret && SP.refresh);
const basic = () => 'Basic ' + Buffer.from(SP.id + ':' + SP.secret).toString('base64');
const esc = t => String(t).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const setupOk = () => SP.id && SP.secret && SP.redirect && !SP.refresh;   // rotas de autorização só existem até você pegar o token

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (u.pathname === '/spotify/login' && setupOk()) {
    res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ response_type: 'code', client_id: SP.id,
      scope: 'user-modify-playback-state user-read-playback-state user-read-currently-playing', redirect_uri: SP.redirect }) });
    return res.end();
  }
  if (u.pathname === '/callback' && setupOk()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic() },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code') || '', redirect_uri: SP.redirect }) });
      const j = await r.json();
      return res.end(j.refresh_token
        ? `<meta name=viewport content="width=device-width"><body style="font:18px sans-serif;padding:16px"><h3>Deu certo!</h3><p>Copie o código abaixo e coloque no Render, na variável <b>SPOTIFY_REFRESH_TOKEN</b>:</p><textarea style="width:100%;height:140px" readonly>${esc(j.refresh_token)}</textarea>`
        : `<body style="font:18px sans-serif;padding:16px">Erro do Spotify: ${esc(j.error_description || j.error || 'desconhecido')}`);
    } catch (e) { return res.end('Erro: ' + esc(e.message)); }
  }
  res.writeHead(404); res.end('404');
});
process.on('uncaughtException', e => console.error('Erro:', e.message));
process.on('unhandledRejection', e => console.error('Erro:', e && e.message || e));
const wss = new WebSocketServer({ server });
let fila = [], tocando = null; const pedidos = {};
const estadoObj = () => ({ t: 'musica', tocando, fila });
wss.on('connection', ws => { ws.on('message', () => {}); if (SP_ON) ws.send(JSON.stringify(estadoObj())); });   // o "ping" da página mantém o site acordado
const enviar = o => wss.clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(o)));

const estado = () => enviar(estadoObj()), aviso = text => enviar({ t: 'aviso', text });

// ---------- Spotify ----------
let acc = { tok: '', exp: 0 };
async function token() {
  if (acc.tok && Date.now() < acc.exp) return acc.tok;
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic() },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: SP.refresh }) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error), { status: 401 });
  acc = { tok: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  if (j.refresh_token) SP.refresh = j.refresh_token;
  return acc.tok;
}
async function sp(method, url) {
  const r = await fetch('https://api.spotify.com/v1' + url, { method, headers: { Authorization: 'Bearer ' + await token() } });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || r.status), { status: r.status });
  return j;
}
async function pedirMusica(user, termo) {
  termo = termo.trim().slice(0, 80);
  if (!termo || Date.now() - (pedidos[user] || 0) < 30000) return;     // 1 pedido a cada 30s por pessoa
  if (fila.length >= 10) return aviso('Fila cheia! Espere uma música tocar.');
  pedidos[user] = Date.now();
  try {
    const j = await sp('GET', '/search?type=track&limit=10&q=' + encodeURIComponent(termo));
    const t = (j.tracks?.items || []).find(t => !t.explicit && t.duration_ms <= 480000);
    if (!t) return aviso(`@${user}: não achei "${termo}"`);
    if (fila.some(f => f.uri === t.uri)) return aviso('Essa música já está na fila!');
    await sp('POST', '/me/player/queue?uri=' + encodeURIComponent(t.uri));
    fila.push({ uri: t.uri, nome: t.name, artista: (t.artists || []).map(a => a.name).join(', '), user });
    estado();
  } catch (e) {
    console.error('Spotify:', e.status, e.message);
    aviso(e.status === 404 ? 'Abra o Spotify no celular e dê play numa música!' : 'Não consegui pedir essa música agora.');
  }
}
async function poll() {
  try {
    const it = (await sp('GET', '/me/player/currently-playing')).item;
    const novo = it ? { uri: it.uri, nome: it.name, artista: (it.artists || []).map(a => a.name).join(', ') } : null;
    if (novo?.uri !== tocando?.uri) { tocando = novo; if (novo) { const i = fila.findIndex(f => f.uri === novo.uri); if (i >= 0) fila.splice(i, 1); } estado(); }
  } catch {}
}
setInterval(() => { if (SP_ON && wss.clients.size) poll(); }, 6000);

const foto = d => d.profilePictureUrl || d.user?.profilePicture?.url?.[0] || d.user?.profilePicture?.urls?.[0] || '';
const quem = d => ({ id: d.uniqueId || d.user?.uniqueId || 'anonimo', name: d.nickname || d.user?.nickname || '', foto: foto(d) });

function conectar() {
  let c;
  try { c = new Conn(TIKTOK_USER.replace('@', '').trim(), {}); }
  catch (e) { console.error('Erro ao iniciar a conexão com o TikTok:', e.message); return setTimeout(conectar, 15000); }
  c.connect().then(() => console.log('✅ Conectado na live de', TIKTOK_USER))
    .catch(e => { console.error('❌ Não conectou (a live precisa estar AO VIVO):', e.message || e); setTimeout(conectar, 15000); });
  c.on('chat', d => {
    const txt = String(d.comment || ''), m = txt.match(/^\s*!mp\s+(.+)/i);
    if (m) { if (SP_ON) pedirMusica(quem(d).id, m[1]); return; }   // comando de música não vale como palpite
    enviar({ t: 'chat', ...quem(d), text: txt.slice(0, 100) });
  });
  c.on('like', d => enviar({ t: 'like', n: d.likeCount || 1 }));
  c.on('gift', d => {
    const gt = d.giftType ?? d.giftDetails?.giftType;
    if (gt === 1 && !d.repeatEnd) return;      // espera o combo terminar
    enviar({ t: 'gift', ...quem(d), gift: d.giftName || d.giftDetails?.giftName || 'presente',
      d: (d.diamondCount || d.giftDetails?.diamondCount || 1) * (d.repeatCount || 1) });
  });
  c.on('disconnected', () => { console.log('Desconectou, tentando de novo...'); setTimeout(conectar, 10000); });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT} (modo teste: /?teste=1)`);
  if (SP.id && !SP.refresh) console.log('🎵 Spotify: falta autorizar. Abra /spotify/login no site e siga as instruções.');
  if (!TIKTOK_USER) console.log('⚠️  Falta a variável TIKTOK_USER: só modo teste');
  else conectar();
});
