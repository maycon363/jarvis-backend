# Imagem base do Node
FROM node:20-slim

# Instalar dependências necessárias para rodar o Piper
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Criar diretório da aplicação
WORKDIR /app

# Copiar arquivos do backend
COPY package*.json ./

# Instalar dependências do Node
RUN npm install

# Copiar o restante do projeto
COPY . .

# Criar diretório do Piper
RUN mkdir -p /app/piper

# Baixar o Piper para Linux
RUN curl -L -o /app/piper/piper.tar.gz https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz \
    && tar -xzf /app/piper/piper.tar.gz -C /app/piper \
    && rm /app/piper/piper.tar.gz

# Baixar o modelo pt_BR
RUN curl
