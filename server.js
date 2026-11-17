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
  if (u.pathname === '/desenhos.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, 'desenhos.js')).pipe(res); }
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
wss.on('connection', ws => {
  ws.on('message', m => { try { const d = JSON.parse(m);   // comandos de teste só funcionam com a variável TESTE_SENHA
    if (d.t !== 'teste' || !process.env.TESTE_SENHA || d.senha !== process.env.TESTE_SENHA) return;
    if (d.acao === 'chat') chat(String(d.id || 'teste'), '', String(d.text || ''));
    if (d.acao === 'like') curtir(Number(d.n) || 1);
    if (d.acao === 'presente') presente(String(d.id || 'teste'), '', Number(d.d) || 1);
    if (d.acao === 'proximo') novaRodada(); } catch {} });
  ws.send(JSON.stringify(snapObj())); if (SP_ON) ws.send(JSON.stringify(estadoObj()));
});
const enviar = o => wss.clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(o)));

const estado = () => enviar(estadoObj()), aviso = text => enviar({ t: 'aviso', text });

// ---------- Jogo (o servidor manda; todas as telas mostram a mesma coisa) ----------
const DR = require('./desenhos.js');
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const agora = () => Date.now() / 1000, users = {};
const G = { fase: 1, recorde: 1, likes: 0, bag: [], ultimo: -1, r: 0, idx: 0, st: 'idle', te: 0, tempo: 40, fast: false, turboAte: 0, certos: [], erros: {}, rev: new Set(), janelaFim: 0, fimDesenho: 0, resFim: 0, t0: 0, res: null };
const mult = () => G.fast ? 30 : agora() < G.turboAte ? 3.5 : 1;
let ultSnap = 0, ultMult = 1;
const toast = text => enviar({ t: 'toast', text });
function snapObj() {
  return { t: 'estado', r: G.r, idx: G.idx, st: G.st, te: G.te, m: mult(), fase: G.fase, recorde: G.recorde, likes: G.likes, certos: G.certos.length, rev: [...G.rev], res: G.res,
    vip: Object.values(users).filter(u => u.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(u => ({ id: u.id, foto: u.foto })) };
}
function snap() { ultSnap = Date.now(); ultMult = mult(); enviar(snapObj()); }
function pessoa(id, foto) { id = String(id || 'anonimo').slice(0, 16); const u = users[id] || (users[id] = { id, foto: '', score: 0 }); if (foto) u.foto = foto; return u; }
function novaRodada() {
  if (!G.bag.length) { G.bag = DR.map((_, i) => i).sort(() => Math.random() - .5); if (G.bag.length > 1 && G.bag[G.bag.length - 1] === G.ultimo) G.bag.unshift(G.bag.pop()); }
  G.idx = G.ultimo = G.bag.pop(); G.r++; G.st = 'draw'; G.te = 0; G.tempo = Math.min(60, 28 + 2.2 * DR[G.idx].s.length); G.fast = false; G.turboAte = 0;
  G.certos = []; G.erros = {}; G.rev = new Set(); G.fimDesenho = 0; G.res = null; G.t0 = agora();
  snap(); toast(['Olha o que eu vou desenhar!', 'Quem adivinha primeiro?', 'Prestem atenção, chat!'][Math.random() * 3 | 0]);
}
function dica() {
  const w = DR[G.idx].w; if (G.rev.size >= w.length - 1) return;
  const livres = [...w].map((_, i) => i).filter(i => !G.rev.has(i)); G.rev.add(livres[Math.random() * livres.length | 0]); snap();
}
function curtir(n) { G.likes += n; while (G.likes >= 90) { G.likes -= 90; dica(); toast('❤ Dica liberada!'); } snap(); }
function chat(id, foto, text) {
  const u = pessoa(id, foto); if (G.st !== 'draw' && G.st !== 'janela') return;
  const g = norm(text); if (!g) return; const cur = DR[G.idx], resp = [cur.w, ...(cur.x || [])].map(norm);
  if (resp.includes(g) || g.split(' ').some(w => resp.includes(w))) {
    if (G.certos.some(c => c.u === u)) return;
    const pts = [10, 7, 5, 3][G.certos.length] || 2; G.certos.push({ u, t: agora() - G.t0, pts }); u.score += pts;
    if (G.certos.length === 1) { G.st = 'janela'; G.fast = true; G.janelaFim = agora() + 6; }
    snap();
  } else G.erros[u.id] = Math.min(2, (G.erros[u.id] || 0) + 1);
}
function presente(id, foto, d) {
  const u = pessoa(id, foto); if (G.st !== 'draw') return;
  if (d >= 30) { G.fast = true; toast(`@${u.id} mandou DESENHO PRONTO!`); }
  else if (d >= 5) { G.turboAte = agora() + 10; toast(`@${u.id} ativou o PINCEL TURBO!`); }
  else { dica(); toast(`@${u.id} liberou uma LETRA!`); }
  snap();
}
function terminar(ok) {
  G.st = 'result'; G.resFim = agora() + 8; G.fast = false; const cur = DR[G.idx];
  if (!ok) { G.fase = 1; G.res = { ok: false, palavra: cur.w, fase: 1 }; toast('Ihh... ninguém acertou!'); return snap(); }
  const rec0 = G.recorde; G.fase++; const novoRec = G.fase > rec0; if (novoRec) G.recorde = G.fase;
  const aj = Object.entries(G.erros).filter(([id]) => !G.certos.some(c => c.u.id === id)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  aj.forEach(([id, n]) => users[id].score += n);
  const p = G.certos[0], todos = [...G.certos.map(c => c.u), ...aj.map(([id]) => users[id])];
  G.res = { ok: true, palavra: cur.w, fase: G.fase, novoRec, n: G.certos.length, p: { id: p.u.id, foto: p.u.foto, t: Math.round(p.t), pts: p.pts },
    aj: aj.map(([id, n]) => ({ id, foto: users[id].foto, n })), todos: todos.slice(0, 10).map(u => ({ id: u.id, foto: u.foto })), nTodos: todos.length };
  snap(); enviar({ t: 'confete' }); toast(`Arrasou, @${p.u.id}!`);
}
function tick() {
  const now = Date.now(), dt = Math.min(1, (now - (tick.u || now)) / 1000); tick.u = now; const s = agora();
  if (G.st === 'draw' || G.st === 'janela') {
    G.te = Math.min(G.tempo, G.te + dt * mult());
    if (G.te >= G.tempo) { G.fast = false; if (!G.fimDesenho) G.fimDesenho = s; }
    if (G.st === 'draw' && G.fimDesenho && s > G.fimDesenho + 15) return terminar(false);
    if (G.st === 'janela' && s > G.janelaFim) return terminar(true);
  } else if (G.st === 'result' && s > G.resFim) return novaRodada();
  if (now - ultSnap >= 1000 || mult() !== ultMult) snap();
}
novaRodada(); setInterval(tick, 200);

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
    { const q = quem(d); chat(q.id, q.foto, txt.slice(0, 100)); }
  });
  let likesTotal = 0, likeLogs = 0;
  c.on('like', d => {   // usa o total de curtidas da live para não perder nenhuma
    const cont = d.likeCount ?? d.count ?? 1, tot = d.totalLikeCount ?? d.total ?? 0;
    if (likeLogs++ < 3) console.log('like:', cont, 'total:', tot);
    const n = Math.max(cont, tot && likesTotal ? tot - likesTotal : 0); if (tot) likesTotal = tot; curtir(n);
  });
  c.on('gift', d => {
    const gt = d.giftType ?? d.giftDetails?.giftType;
    if (gt === 1 && !d.repeatEnd) return;      // espera o combo terminar
    const q = quem(d); presente(q.id, q.foto, (d.diamondCount || d.giftDetails?.diamondCount || 1) * (d.repeatCount || 1));
  });
  c.on('disconnected', () => { console.log('Desconectou, tentando de novo...'); setTimeout(conectar, 10000); });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT} (modo teste: /?teste=1)`);
  if (SP.id && !SP.refresh) console.log('🎵 Spotify: falta autorizar. Abra /spotify/login no site e siga as instruções.');
  if (!TIKTOK_USER) console.log('⚠️  Falta a variável TIKTOK_USER: só modo teste');
  else conectar();
});
