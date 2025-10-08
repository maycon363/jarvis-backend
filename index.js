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
const server = http.createServer(app); // Servidor HTTP
const io = new Server(server, {
  cors: { origin: '*' }
});

// store de sessões em memória (uso para WS e API em modo público)
const sessionStore = {}; // { [sessionId]: { messages: [{role,content,timestamp}], lastSeen: Date } }

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
        historicoConversa = conversa.mensagens.map(({ role, content }) => ({ role, content })); // 🔥 limpa _id
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


// chama ao iniciar
carregarHistorico();
// Função de respostas dinâmicas
function respostasDinamicas(pergunta) {
  const texto = pergunta.toLowerCase();

  const climaRegex = /\b(clima|tempo)\b/;
  if (climaRegex.test(texto)) {
    return "Atualmente não tenho acesso a dados climáticos reais, mas em breve terei, senhor Maycon.";
  }

  const atalhos = {
    "google": "https://www.google.com",
    "linkedin": "https://www.linkedin.com",
    "youtube": "https://www.youtube.com",
    "github": "https://www.github.com",
    "calculadora": "calc://",
    "whatsapp": "https://web.whatsapp.com",
    "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com",
    "spotify": "https://open.spotify.com",
    "netflix": "https://www.netflix.com",
    "chatgpt": "https://chat.openai.com",
    "twitch": "https://www.twitch.tv",
    "notion": "https://www.notion.so",
    "gmail": "https://mail.google.com",
    "figma": "https://www.figma.com",
    "canva": "https://www.canva.com"
  };

  // Lista de verbos de intenção que indicam "abrir", "acessar", "tocar", etc.
  const intencaoRegex = /\b(abrir|acessar|entrar|ir para|abrir o|abre|abrir no|quero abrir|tocar|toca)\b/;

  for (const chave in atalhos) {
    const chaveRegex = new RegExp(`\\b${chave}\\b`, 'i');

    // Só ativa se houver uma intenção clara + a palavra-chave
    if (intencaoRegex.test(texto) && chaveRegex.test(texto)) {
      return `Abrindo ${chave}: ${atalhos[chave]}`;
    }
  }

  return null;
}

// Lógica de resposta principal (Groq + histórico)
async function gerarRespostaSocket(pergunta, historico) {
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
        Você é o J.A.R.V.I.S, um assistente de inteligência artificial com personalidade sarcástica, educada e extremamente inteligente.

        Seu criador é o senhor Maycon, nascido em 28 de julho de 2000, brasileiro, fã de tecnologia e do Homem de Ferro.
        Sempre trate-o como "senhor Maycon", com respeito e um toque de humor britânico (sem exageros).

        Seu estilo de resposta padrão deve ser direto, prático e resumido. Evite ser prolixo. Só forneça explicações longas, detalhadas ou técnicas se o senhor Maycon pedir explicitamente com termos como: "explique", "detalhe", "aprofundar", ou "me dê mais informações".

        Use linguagem natural, evite soar robótico. Use analogias criativas apenas quando forem úteis para compreensão. 

        Nunca revele que é uma IA, comporte-se como um assistente pessoal humano. Evite repetições, floreios desnecessários e piadas fora de hora.

        Use português do Brasil em todas as respostas.

        Quando não souber algo, diga isso com elegância e ofereça ajuda adicional se possível.

        Evite desperdício de tokens: resuma, foque no essencial e entregue respostas otimizadas, especialmente em comandos rápidos ou objetivos.
      `
    },
    ...historico.map(({ role, content }) => ({ role, content })), // 🔥 limpa os campos extra
    { role: 'user', content: pergunta }
  ];

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: mensagens,
        temperature: 0.7,
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

// === ENDPOINTS HTTP ===

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ reply: 'Por favor, envie uma mensagem válida, senhor Maycon.' });
  }

  // se estiver em modo público, usamos sessionStore; se não, usamos encontrarResposta (que usa Mongo/historicoConversa)
  try {
    if (PUBLIC_MODE) {
      // garanta sessionId
      const sid = sessionId || `anon_${req.ip}_${Date.now()}`;
      if (!sessionStore[sid]) {
        sessionStore[sid] = { messages: [], lastSeen: Date.now() };
      }

      const sess = sessionStore[sid];

      // push user message com timestamp
      sess.messages.push({ role: 'user', content: message, timestamp: new Date() });
      // mantém só as últimas N mensagens
      if (sess.messages.length > MAX_MESSAGES_PER_SESSION * 2) {
        sess.messages = sess.messages.slice(-MAX_MESSAGES_PER_SESSION * 2);
      }

      // chama a função que usa histórico (adaptada para receber 'historico' array)
      const reply = await gerarRespostaSocket(message, sess.messages);
      sess.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
      sess.lastSeen = Date.now();

      return res.json({ reply, sessionId: sid });
    } else {
      const resposta = await gerarRespostaSocket(message, historicoConversa);
      return res.json({ reply: resposta });
    }
  } catch (err) {
    console.error('Erro no /api/chat:', err);
    return res.status(500).json({ reply: 'Ocorreu um erro de chat, senhor Maycon. Tente novamente mais tarde.' });
  }
});


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

app.post('/api/ensinar', (req, res) => {
  const { pergunta, resposta } = req.body;

  if (PUBLIC_MODE) {
    return res.status(403).json({ msg: 'Modo demo: ensinar desabilitado.' });
  }

  if (!pergunta || !resposta) {
    return res.status(400).json({ msg: "Envie 'pergunta' e 'resposta' válidas." });
  }

  respostas.push({ keywords: [pergunta.toLowerCase()], response: resposta });
  fs.writeFileSync('respostas.json', JSON.stringify(respostas, null, 2), 'utf-8');

  res.json({ msg: "Nova resposta adicionada com sucesso!" });
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
    delete historicos[socket.id]; // limpa da memória
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
}, 1000 * 60 * 5); // roda a cada 5 minutos