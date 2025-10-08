const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const axios = require('axios');
const http = require('http');
const Conversa = require('./models/Historico');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app); // Servidor HTTP
const io = new Server(server, {
  cors: { origin: '*' }
});

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
        historicoConversa = conversa.mensagens;
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
    ...historico,
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
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ reply: 'Por favor, envie uma mensagem válida, pois essa mensagem não consigo responder, senhor Maycon.' });
  }

  try {
    const resposta = await encontrarResposta(message);
    res.json({ reply: resposta });
  } catch (error) {
    console.error('Erro no /api/chat:', error);
    res.status(500).json({ reply: 'Ocorreu um erro de chat, senhor Maycon. Tente novamente mais tarde.' });
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