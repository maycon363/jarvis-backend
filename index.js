// backend/index.js
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
require('dotenv').config();

// Model
const Conversa = require('./models/Historico');

const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';

// --- Inicialização do app ---
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));
app.use(fileUpload());

// --- Configurações ---
const MAX_MESSAGES_PER_SESSION = 40;
const SESSION_TTL_MS = 1000 * 60 * 30;
const sessionStore = {};
const socketHistories = {};

// --- MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('Erro ao conectar MongoDB:', err));

// --- Respostas automáticas ---
let respostas = JSON.parse(fs.readFileSync('respostas.json', 'utf-8'));
let historicoConversa = [];

async function carregarHistorico() {
  try {
    const c = await Conversa.findOne({ usuario: 'senhorMaycon' });
    if (c) {
      historicoConversa = c.mensagens.map(m => ({
        role: m.role,
        content: m.content
      }));
      console.log("📁 Histórico carregado:", historicoConversa.length, "mensagens");
    }
  } catch (err) {
    console.warn("MongoDB indisponível, seguindo sem histórico persistente.");
  }
}

carregarHistorico();

// Função de atalhos
function respostasDinamicas(texto) {
  texto = texto.toLowerCase();
  const atalhos = {
    google: "https://www.google.com",
    youtube: "https://youtube.com",
    linkedin: "https://linkedin.com",
    github: "https://github.com",
    whatsapp: "whatsapp://send?text=Olá"
  };

  const qualquer = /\b(abrir|acessar|entrar|abrir|vai para)\b/;

  for (const chave in atalhos) {
    if (texto.includes(chave) && qualquer.test(texto)) {
      return JSON.stringify({
        action: "openLink",
        url: atalhos[chave]
      });
    }
  }

  return null;
}

// Geração de resposta
async function gerarRespostaSocket(pergunta, historico) {
  const dinamica = respostasDinamicas(pergunta);
  if (dinamica) return dinamica;

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "Você é JARVIS, direto, inteligente e com leve sarcasmo."
          },
          ...historico,
          { role: "user", content: pergunta }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("Erro Groq:", err.response?.data || err.message);
    return "Erro ao pensar, senhor Maycon.";
  }
}

// --- Rotas ---
// CHAT
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ reply: 'Mensagem inválida.' });

  try {
    let sid = sessionId;
    let reply = "";

    if (PUBLIC_MODE) {
      sid = sessionId || `anon_${Date.now()}`;
      if (!sessionStore[sid]) sessionStore[sid] = { messages: [], lastSeen: Date.now() };

      const sess = sessionStore[sid];
      sess.messages.push({ role: 'user', content: message });

      reply = await gerarRespostaSocket(message, sess.messages);
      sess.messages.push({ role: 'assistant', content: reply });
      sess.lastSeen = Date.now();
    } else {
      historicoConversa.push({ role: "user", content: message });
      reply = await gerarRespostaSocket(message, historicoConversa);
      historicoConversa.push({ role: "assistant", content: reply });
    }

    res.json({ reply, sessionId: sid });

  } catch (err) {
    console.error("Erro no /api/chat:", err);
    res.status(500).json({ reply: "Erro interno." });
  }
});

// RESET
app.post("/api/resetar", async (req, res) => {
  historicoConversa = [];
  try { await Conversa.findOneAndDelete({ usuario: "senhorMaycon" }); }
  catch {}
  res.json({ msg: "Memória apagada." });
});

// --- 🚀 STT CORRIGIDO (SEM FFMPEG) ---
app.post("/api/stt", async (req, res) => {
  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: "Nenhum arquivo de áudio recebido." });
    }

    const audioFile = req.files.audio;
    
    // Importante: form-data deve ser importado aqui ou no topo
    const FormData = require("form-data"); 
    const form = new FormData();

    // 1. Anexar o Buffer do arquivo
    // O 3º parâmetro { filename: ... } é OBRIGATÓRIO para a OpenAI aceitar Buffer
    form.append("file", audioFile.data, {
      filename: "audio.webm", 
      contentType: audioFile.mimetype || "audio/webm",
    });

    // 2. Definir o modelo
    form.append("model", "whisper-1");
    // Opcional: language ajuda na precisão (pt para português)
    form.append("language", "pt"); 

    console.log("📤 Enviando áudio para OpenAI Whisper...");

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(), // CRUCIAL: Adiciona o Content-Type multipart correto
        },
        maxBodyLength: Infinity, // Previne erro com arquivos grandes
        maxContentLength: Infinity,
      }
    );

    console.log("✅ Transcrição concluída:", response.data.text);
    return res.json({ text: response.data.text });

  } catch (err) {
    // Log detalhado do erro da OpenAI para facilitar debug
    console.error("❌ Erro OpenAI STT:", err.response ? err.response.data : err.message);
    
    return res.status(500).json({ 
      error: "Erro ao processar áudio no servidor.",
      details: err.response?.data || err.message 
    });
  }
});

// Home
app.get("/", (_, res) => res.send("🧠 JARVIS API Online"));

// SOCKET
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on("connection", (socket) => {
  socketHistories[socket.id] = [];

  socket.on("mensagem", async (msg) => {
    socketHistories[socket.id].push({ role: "user", content: msg });
    const resposta = await gerarRespostaSocket(msg, socketHistories[socket.id]);
    socketHistories[socket.id].push({ role: "assistant", content: resposta });
    socket.emit("resposta", resposta);
  });

  socket.on("disconnect", () => delete socketHistories[socket.id]);
});

// Iniciar servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("🧠 JARVIS rodando na porta " + PORT));

// Limpeza
setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(sessionStore)) {
    if (now - sessionStore[sid].lastSeen > SESSION_TTL_MS) delete sessionStore[sid];
  }
}, 1000 * 60 * 5);
