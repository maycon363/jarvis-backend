# Imagem base do Node
FROM node:20-slim

# Instalar dependências necessárias para o Piper
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Definir diretório da aplicação
WORKDIR /app

# Copiar arquivos do Node
COPY package*.json ./ 

# Instalar dependências
RUN npm install

# Copiar todo o restante do código
COPY . .

# Criar pasta do Piper
RUN mkdir -p /app/piper

# Baixar o Piper
RUN curl -L -o /app/piper/piper.tar.gz \
    https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz \
    && tar -xzf /app/piper/piper.tar.gz -C /app/piper \
    && rm /app/piper/piper.tar.gz

# Baixar modelo pt-BR
RUN curl -L -o /app/piper/pt_BR-faber-low.onnx \
    https://github.com/rhasspy/piper/releases/download/v0.0.2/pt_BR-faber-low.onnx

# Permissão para o binário
RUN chmod +x /app/piper/piper

# Expor a porta do backend
EXPOSE 3001

# Start do servidor
CMD ["npm", "start"]
