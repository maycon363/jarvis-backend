const mongoose = require('mongoose');

const MensagemSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: () => new Date() } // força nova data a cada insert
});

const ConversaSchema = new mongoose.Schema({
  usuario: { type: String, default: 'senhorMaycon' },
  mensagens: [MensagemSchema]
});

module.exports = mongoose.model('Conversa', ConversaSchema);