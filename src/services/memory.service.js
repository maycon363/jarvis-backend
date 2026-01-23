// src/services/memory.service.js
const pgClient = require("./database");

async function salvarNoHistorico(role, content) {
  const query =
    "INSERT INTO historico (role, content, timestamp) VALUES ($1, $2, NOW())";

  try {
    await pgClient.query(query, [role, content]);
  } catch (err) {
    console.error("Erro ao gravar memória:", err);
  }
}

async function obterHistorico(limit = 8) {
  const query = `
    SELECT role, content
    FROM historico
    ORDER BY timestamp DESC
    LIMIT $1
  `;

  const res = await pgClient.query(query, [limit]);
  return res.rows.reverse(); // ordem cronológica
}

async function salvarCompromisso(
  titulo,
  conteudo,
  data_evento = null,
  categoria = "geral"
) {
  const query = `
    INSERT INTO compromissos
    (titulo, descricao, data_evento, categoria)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;

  const values = [titulo, conteudo, data_evento, categoria];
  const res = await pgClient.query(query, values);
  return res.rows[0];

}

async function listarCompromissos() {
  const query = `
    SELECT titulo, descricao, data_evento, criado_em
    FROM compromissos
    WHERE concluido = false
    ORDER BY criado_em DESC
    LIMIT 10
  `;

  try {
    const res = await pgClient.query(query);

    return res.rows.map(row => ({
      ...row,
      data_evento: row.data_evento
        ? new Date(row.data_evento).toISOString()
        : null
    }));

  } catch (err) {
    console.error("Erro ao ler compromissos:", err);
    return [];
  }
}

module.exports = {
  salvarNoHistorico,
  salvarCompromisso,
  listarCompromissos,
  obterHistorico
};