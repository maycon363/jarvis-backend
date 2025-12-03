// backend/index.js
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Conversa = require('./models/Historico');
require('dotenv').config();

// --- Inicialização do app ---
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// --- Para upload de áudio (STT) ---
const fileUpload = require('express-fileupload');
app.use(fileUpload());

// --- Servidor HTTP + WebSocket ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Configurações ---
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';
const MAX_MESSAGES_PER_SESSION = 40;
const SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutos
const sessionStore = {}; // Sessões públicas em memória
const socketHistories = {}; // Histórico por socket

// --- Conexão com MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch((err) => console.error('Erro ao conectar MongoDB:', err));

// --- Carregar respostas fixas ---
let respostas = JSON.parse(fs.readFileSync('respostas.json', 'utf-8'));
let historicoConversa = [];

async function carregarHistorico() {
  try {
    if (process.env.MONGO_URI) {
      const conversa = await Conversa.findOne({ usuario: 'senhorMaycon' });
      if (conversa) {
        historicoConversa = conversa.mensagens.map(({ role, content }) => ({ role, content }));
        console.log('📁 Histórico carregado do MongoDB com', historicoConversa.length, 'mensagens');
      }
    }
  } catch (err) {
    console.warn('🔌 MongoDB não disponível, rodando em modo anônimo.');
  }
}

carregarHistorico();

// --- Funções auxiliares ---
function respostasDinamicas(pergunta) {
  const texto = pergunta.toLowerCase();

  const atalhos = {
    google: "https://www.google.com",
    linkedin: "https://www.linkedin.com",
    youtube: "vnd.youtube://",
    github: "https://www.github.com",
    calculadora: "intent://calculator#Intent;scheme=android-app;package=com.android.calculator2;end",
    whatsapp: "whatsapp://send?text=Olá",
    instagram: "instagram://user?username=seu_usuario",
    facebook: "fb://",
    spotify: "spotify://",
    netflix: "nflx://",
    chatgpt: "https://chat.openai.com",
    twitch: "twitch://",
    notion: "notion://",
    gmail: "mailto:seuemail@gmail.com",
    figma: "figma://",
    canva: "https://www.canva.com"
  };

  const intencaoRegex = /\b(abrir|acessar|entrar|abre|ir para|tocar|play|iniciar)\b/;

  for (const chave in atalhos) {
    const chaveRegex = new RegExp(`\\b${chave}\\b`, 'i');
    if (intencaoRegex.test(texto) && chaveRegex.test(texto)) {
      return JSON.stringify({
        action: "openLink",
        app: chave,
        url: atalhos[chave]
      });
    }
  }

  return null;
}

async function gerarRespostaSocket(pergunta, historico) {
  const texto = pergunta.toLowerCase();
  const dinamica = respostasDinamicas(texto);

  const agora = new Date().toLocaleString("pt-BR", { dateStyle: "full", timeStyle: "long", timeZone: "America/Sao_Paulo" });
  if (dinamica) return dinamica;

  for (const item of respostas) {
    const todasPresentes = item.keywords.every((k) => texto.includes(k));
    if (todasPresentes) return item.response;
  }

  const sistemaContent = `
    ⚠️ A data e hora atual é: ${agora}
    Você é J.A.R.V.I.S., assistente pessoal com personalidade sarcástica (sem ser rude), educado e inteligente.
    Criador: senhor Maycon, fã do Homem de Ferro e da Marvel.
    Estilo: direto, prático e conciso; humor britânico sutil; linguagem natural em português do Brasil.
    Não revele que é uma IA; responda elegantemente se não souber algo.
    Evite desperdício de tokens: resuma, vá direto ao ponto.
  `;

  const mensagens = [
    { role: 'system', content: sistemaContent },
    ...historico.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: pergunta }
  ];

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: mensagens, temperature: 0.9, max_tokens: 600 },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` } }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error('Erro ao chamar Groq (socket):', err.response?.data || err.message);
    return "Tive um problema técnico ao acessar minha base de conhecimento, senhor Maycon.";
  }
}

// --- Rotas ---
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ reply: 'Por favor, envie uma mensagem válida, senhor Maycon.' });
  }

  try {
    let reply = '';
    let sid = sessionId;

    if (PUBLIC_MODE) {
      sid = sessionId || `anon_${req.ip}_${Date.now()}`;
      if (!sessionStore[sid]) sessionStore[sid] = { messages: [], lastSeen: Date.now() };

      const sess = sessionStore[sid];
      sess.messages.push({ role: 'user', content: message, timestamp: new Date() });
      if (sess.messages.length > MAX_MESSAGES_PER_SESSION * 2) sess.messages = sess.messages.slice(-MAX_MESSAGES_PER_SESSION * 2);

      reply = await gerarRespostaSocket(message, sess.messages);
      sess.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      sess.lastSeen = Date.now();
    } else {
      reply = await gerarRespostaSocket(message, historicoConversa);
    }

    return res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('Erro no /api/chat:', err);
    return res.status(500).json({ reply: 'Ocorreu um erro de chat, senhor Maycon. Tente novamente mais tarde.' });
  }
});

app.post('/api/resetar', async (req, res) => {
  historicoConversa = [];
  if (process.env.MONGO_URI) {
    try { await Conversa.findOneAndDelete({ usuario: 'senhorMaycon' }); } 
    catch (err) { console.warn('❌ Não foi possível limpar no MongoDB. Continuando mesmo assim...'); }
  }
  res.json({ msg: 'Memória de curto prazo apagada com sucesso, senhor Maycon.' });
});

// --- Rota STT (voz → texto) ---
app.post('/api/stt', async (req, res) => {
  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: "Áudio não enviado" });
    }

    const audioFile = req.files.audio;
    const FormData = require("form-data");
    const formData = new FormData();
    formData.append("file", audioFile.data, audioFile.name);
    formData.append("model", "whisper-1");

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      formData,
      { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...formData.getHeaders() } }
    );

    res.json({ text: response.data.text });
  } catch (err) {
    console.error("Erro STT:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro no reconhecimento de voz" });
  }
});

app.get('/', (req, res) => res.send('🧠 API do J.A.R.V.I.S está online e funcionando perfeitamente, senhor Maycon.'));

// --- WebSocket ---
io.on('connection', (socket) => {
  socketHistories[socket.id] = [];

  socket.on('mensagem', async (mensagem) => {
    socketHistories[socket.id].push({ role: 'user', content: mensagem });
    const resposta = await gerarRespostaSocket(mensagem, socketHistories[socket.id]);
    socketHistories[socket.id].push({ role: 'assistant', content: resposta });
    socket.emit('resposta', resposta);
  });

  socket.on('disconnect', () => delete socketHistories[socket.id]);
});

// --- Iniciar servidor ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🧠 J.A.R.V.I.S rodando na porta ${PORT} com WebSocket ativo`));

// --- Limpeza de sessões antigas ---
setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(sessionStore)) {
    if (now - sessionStore[sid].lastSeen > SESSION_TTL_MS) delete sessionStore[sid];
  }
}, 1000 * 60 * 5);
