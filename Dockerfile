# 1. Usar a imagem oficial do Node.js
FROM node:22

# 2. Definir a pasta de trabalho dentro do servidor
WORKDIR /app

# 3. Copiar e instalar as dependências
COPY package*.json ./
RUN npm install

# 4. Copiar o restante do código
COPY . .

# 5. Abrir a porta do servidor
EXPOSE 3001

# 6. Comando para ligar o Jarvis
CMD ["node", "index.js"]