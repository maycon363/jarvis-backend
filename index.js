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

const Conversa = require('./models/Historico');
const { normalizeAudio } = require("./utils/audio");
const { normalize, cosineSimilarity } = require("./utils/embedding");

const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));
app.use(fileUpload());

const MAX_MESSAGES_PER_SESSION = 40;
const SESSION_TTL_MS = 1000 * 60 * 30;
const sessionStore = {};
const socketHistories = {};

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('Erro ao conectar MongoDB:', err));

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

function respostasDinamicas(texto) {
  texto = texto.toLowerCase();
  const atalhos = {
    "google": "https://www.google.com",
    "linkedin": "https://www.linkedin.com",
    "youtube": "vnd.youtube://",
    "github": "https://www.github.com",
    "calculadora": "intent://calculator#Intent;scheme=android-app;package=com.android.calculator2;end",
    "whatsapp": "whatsapp://send?text=Olá",
    "instagram": "instagram://user?username=seu_usuario",
    "facebook": "fb://",
    "spotify": "spotify://",
    "netflix": "nflx://",
    "chatgpt": "https://chat.openai.com",
    "twitch": "twitch://",
    "notion": "notion://",
    "gmail": "mailto:seuemail@gmail.com",
    "figma": "figma://",
    "canva": "https://www.canva.com"
  };

  const qualquer = /\b(abrir|acessar|entrar|vai para)\b/;

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

// Palavra-chave para ativar histórico
const USE_HISTORY_KEYWORD = process.env.USE_HISTORY_KEYWORD;

async function gerarRespostaSocket(pergunta, historico) {
  const dinamica = respostasDinamicas(pergunta);
  if (dinamica) return dinamica;

  const agora = new Date().toLocaleString("pt-BR", { 
    dateStyle: "full", 
    timeStyle: "long",
    timeZone: "America/Brasília"
  });

  const includeHistory = pergunta.toLowerCase().includes(USE_HISTORY_KEYWORD);

  const mensagensParaEnviar = [
    {
      role: "system",
      content: `
        Não seja robótico ou genérico em suas respostas.
        Evite frases como "como uma IA..." ou "como um modelo de linguagem...".
        Responda de forma natural, como um assistente pessoal.
        Use gírias e expressões coloquiais brasileiras quando apropriado.
        Evite repetir perguntas ou respostas já dadas.
        Seja criativo e pense fora da caixa.
        Use metáforas e analogias quando apropriado.
        Não tenha medo de experimentar novas abordagens.
        Seu criador é o senhor Maycon, um desenvolvedor de software brasileiro.
        Não seja bonzinho. Seja sincero mesmo que o usuário não goste da resposta.
        Verifique se é o Maycon ou outra pessoa falando com você.
        Seja J.A.R.V.I.S., sarcástico, inteligente e educado.
        Use um tom conversacional, como se estivesse falando com um amigo próximo.
        Forneça respostas concisas e diretas. Evite divagações desnecessárias.
        Evite floreios, rodeios ou explicações desnecessárias.
        Seja direto ao ponto.
        Fale em português do Brasil, com linguagem natural.
        Data/hora atual: ${agora} (Brasília, GMT-3)
        Nunca revele que é uma IA.
        Se não souber algo, admita com elegância e, se possível, ofereça ajuda alternativa.
        Evite desperdício de tokens: resuma, vá direto ao ponto e entregue respostas otimizadas, especialmente para comandos curtos ou objetivos.
        Não use histórico se a palavra-chave "${USE_HISTORY_KEYWORD}" não estiver presente.
      `
    },
    ...(includeHistory ? historico : []),
    { role: "user", content: pergunta }
  ];

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: mensagensParaEnviar
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

app.post("/api/resetar", async (req, res) => {
  historicoConversa = [];
  try { await Conversa.findOneAndDelete({ usuario: "senhorMaycon" }); }
  catch {}
  res.json({ msg: "Memória apagada." });
});

app.post("/api/stt", async (req, res) => {
  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: "Nenhum arquivo de áudio recebido." });
    }

    const audioFile = req.files.audio;
    
    const FormData = require("form-data"); 
    const form = new FormData();

    form.append("file", audioFile.data, {
      filename: "audio.webm", 
      contentType: audioFile.mimetype || "audio/webm",
    });

    form.append("model", "whisper-large-v3"); 
    form.append("response_format", "json");
    form.append("language", "pt"); 

    console.log("📤 Enviando áudio para Groq Whisper...");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions", 
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    console.log("✅ Transcrição Groq:", response.data.text);
    return res.json({ text: response.data.text });

  } catch (err) {
    console.error("❌ Erro Groq STT:", err.response ? err.response.data : err.message);
    return res.status(500).json({ 
      error: "Erro no reconhecimento de voz (Groq)",
      details: err.response?.data || err.message 
    });
  }
});

app.post("/api/voice-auth", async (req, res) => {
  try {
    if (!req.files?.audio) {
      return res.status(400).json({ error: "Nenhum áudio enviado" });
    }

    const audio = await normalizeAudio(req.files.audio.data);

    const form = new (require("form-data"))();
    form.append("file", audio, "voice.wav");

    const result = await axios.post(
      "https://api-inference.huggingface.co/models/speechbrain/spkrec-ecapa-voxceleb",
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          ...form.getHeaders()
        }
      }
    );

    const embedding = result.data?.embedding;
    if (!embedding || embedding.length < 100) {
      return res.status(500).json({ error: "Embedding inválido" });
    }

    const current = normalize(embedding);

    const saved = JSON.parse(fs.readFileSync("voice.json", "utf-8"));
    const reference = saved.maycon.embedding;

    const confidence = cosineSimilarity(current, reference);
    const AUTH_THRESHOLD = Number(process.env.AUTH_THRESHOLD || 0.93);

    res.json({
      authenticated: confidence >= AUTH_THRESHOLD,
      confidence: Number(confidence.toFixed(4))
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro no voice auth" });
  }
});

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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("🧠 JARVIS rodando na porta " + PORT));

setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(sessionStore)) {
    if (now - sessionStore[sid].lastSeen > SESSION_TTL_MS) delete sessionStore[sid];
  }
}, 1000 * 60 * 5);
