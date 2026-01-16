const { Client } = require("pg");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

client.on("error", (err) => {
  console.error("❌ Erro inesperado no cliente Postgres:", err);
});

client.connect()
  .then(() => console.log("✅ PostgreSQL Conectado (Sistemas de Memória Online)"))
  .catch(err => console.error("❌ Erro inicial no Postgres:", err));

module.exports = client;