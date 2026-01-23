# 1. Usar a imagem oficial do Node.js
FROM node:22

# 2. Instalar a biblioteca de áudio que o Linux precisa para rodar o Piper
RUN apt-get update && apt-get install -y libasound2

# 3. Definir a pasta de trabalho dentro do servidor
WORKDIR /app

# 4. Copiar e instalar as dependências
COPY package*.json ./
RUN npm install

# 5. Copiar o restante do código
COPY . .

# 6. Dar permissão para o arquivo do Piper Linux ser executado
RUN chmod +x ./bin/piper_linux/piper

# 7. Abrir a porta do servidor
EXPOSE 3001

# 8. Comando para ligar o Jarvis
CMD ["node", "index.js"]