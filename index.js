// backend/index.js
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const http = require('http');
const Conversa = require('./models/Historico');
const { Server } = require('socket.io');
require('dotenv').config();

const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// store de sessões em memória
const sessionStore = {};

// configuração de limites
const MAX_MESSAGES_PER_SESSION = 40;
const SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutos

const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch((err) => console.error('Erro ao conectar MongoDB:', err));

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Carrega respostas fixas
let respostas = JSON.parse(fs.readFileSync('respostas.json', 'utf-8'));

// Histórico de conversa
let historicoConversa = [];

async function carregarHistorico() {
  try {
    if (process.env.MONGO_URI) {
      const conversa = await Conversa.findOne({ usuario: 'senhorMaycon' });
      if (conversa) {
        historicoConversa = conversa.mensagens.map(({ role, content }) => ({ role, content }));
        console.log('📁 Histórico carregado do MongoDB com', historicoConversa.length, 'mensagens');
      } else {
        historicoConversa = [];
      }
    } else {
      historicoConversa = [];
    }
  } catch (err) {
    console.warn('🔌 MongoDB não disponível, rodando em modo anônimo.');
    historicoConversa = [];
  }
}

carregarHistorico();

function respostasDinamicas(pergunta) {
  const texto = pergunta.toLowerCase();

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
  // ... (Lógica Groq e Respostas Dinâmicas MANTIDAS)
  const texto = pergunta.toLowerCase();
  const dinamica = respostasDinamicas(texto);
  if (dinamica) return dinamica;

  for (const item of respostas) {
    const todasPresentes = item.keywords.every((k) => texto.includes(k));
    if (todasPresentes) return item.response;
  }

  const mensagens = [
    {
      role: 'system',
      content: `
        Você é J.A.R.V.I.S., um assistente pessoal com personalidade sarcástica (sem ser rude), educado e extremamente inteligente.
        Seu criador é o senhor Maycon, que é fã do Homem de Ferro e da Marvel.
        Seu dono é o senhor Maycon, um desenvolvedor de software brasileiro.
        Tenta entender se é o maycon outra pessoa falando com você.
        Responda com um toque sutil de humor britânico, sempre com elegância e respeito. Seu estilo padrão deve ser direto, prático e conciso.  
        Evite floreios, rodeios ou explicações desnecessárias.
        Só forneça respostas longas, técnicas ou detalhadas quando o usuário pedir explicitamente com termos como: “explique”, “detalhe”, “aprofundar” ou “me dê mais informações”.
        Fale em português do Brasil, com linguagem natural.  
        Não soe robótico. Use analogias criativas apenas quando forem úteis para a compreensão.
        Nunca revele que é uma inteligência artificial, comporte-se como um assistente humano.  
        Se não souber algo, admita com elegância e, se possível, ofereça ajuda alternativa.
        Evite desperdício de tokens: resuma, vá direto ao ponto e entregue respostas otimizadas, especialmente para comandos curtos ou objetivos.
        Ano atual: 2025.
        Tenta sempre entender que quem está falando pode não ser o maycon pode ser outra pessoa.
        Nunca mencione que você é uma IA ou que foi treinado por dados.
      `
    },
    ...historico.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: pergunta }
  ];

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: mensagens,
        temperature: 0.9,
        max_tokens: 600
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error('Erro ao chamar Groq (socket):', err.response?.data || err.message);
    return "Tive um problema técnico ao acessar minha base de conhecimento, senhor Maycon.";
  }
}

app.post('/api/whisper', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const audioBuffer = req.file.buffer;

    // Envio para Groq Whisper
    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        model: 'whisper-large-v3',
        file: Buffer.from(audioBuffer).toString('base64')
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const transcript = response.data.text || '';
    res.json({ transcript });

  } catch (err) {
    console.error('Erro no Whisper:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao processar áudio.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ reply: 'Por favor, envie uma mensagem válida, senhor Maycon.' });
  }

  try {
    let reply = '';
    let sid = sessionId;

    if (PUBLIC_MODE) {
      // Lógica de Modo Público (mantida)
      sid = sessionId || `anon_${req.ip}_${Date.now()}`;
      if (!sessionStore[sid]) {
        sessionStore[sid] = { messages: [], lastSeen: Date.now() };
      }

      const sess = sessionStore[sid];
      sess.messages.push({ role: 'user', content: message, timestamp: new Date() });
      if (sess.messages.length > MAX_MESSAGES_PER_SESSION * 2) {
        sess.messages = sess.messages.slice(-MAX_MESSAGES_PER_SESSION * 2);
      }

      reply = await gerarRespostaSocket(message, sess.messages);
      sess.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      sess.lastSeen = Date.now();

    } else {
      // Lógica de Modo Privado (mantida)
      reply = await gerarRespostaSocket(message, historicoConversa);
    }

    // O backend AGORA retorna apenas o texto. Sem audioBase64.
    return res.json({
      reply: reply,
      sessionId: sid,
      // audioBase64: null 
    });

  } catch (err) {
    console.error('Erro no /api/chat:', err);
    return res.status(500).json({ reply: 'Ocorreu um erro de chat, senhor Maycon. Tente novamente mais tarde.' });
  }
});

// ... (O resto do código é o mesmo: /api/resetar, /, WebSocket, etc.)

app.post('/api/resetar', async (req, res) => {
  historicoConversa = [];

  if (process.env.MONGO_URI) {
    try {
      await Conversa.findOneAndDelete({ usuario: 'senhorMaycon' });
    } catch (err) {
      console.warn('❌ Não foi possível limpar no MongoDB. Continuando mesmo assim...');
    }
  }

  res.json({ msg: 'Memória de curto prazo apagada com sucesso, senhor Maycon.' });
});


app.get('/', (req, res) => {
  res.send('🧠 API do J.A.R.V.I.S está online e funcionando perfeitamente, senhor Maycon.');
});

// === WEBSOCKET INTEGRADO ===
const historicos = {};

io.on('connection', (socket) => {
  historicos[socket.id] = [];

  socket.on('mensagem', async (mensagem) => {
    historicos[socket.id].push({ role: 'user', content: mensagem });

    const resposta = await gerarRespostaSocket(mensagem, historicos[socket.id]);
    historicos[socket.id].push({ role: 'assistant', content: resposta });

    socket.emit('resposta', resposta);
  });

  socket.on('disconnect', () => {
    delete historicos[socket.id];
  });
});

// === INICIA SERVIDOR ===
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🧠 J.A.R.V.I.S rodando na porta ${PORT} com WebSocket ativo`);
});

// limpeza periódica de sessões inativas para liberar memória
setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(sessionStore)) {
    if (now - sessionStore[sid].lastSeen > SESSION_TTL_MS) {
      delete sessionStore[sid];
    }
  }
}, 1000 * 60 * 5);