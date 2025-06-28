# 🚌 Bot de Rastreamento de Ônibus DF

Um bot do Telegram inteligente que fornece informações precisas e em tempo real sobre ônibus públicos do Distrito Federal, utilizando dados oficiais da SEMOB-DF.

## ✨ Funcionalidades

- 📍 **Localização em tempo real** dos ônibus próximos
- ⏱️ **Previsão de chegada** com algoritmos avançados de precisão
- 🎯 **Múltiplos níveis de confiança** (alto, médio, baixo)
- 🚦 **Análise de trânsito** com fatores de horário de pico
- 📊 **Horários programados** das linhas
- 🔄 **Atualizações automáticas** a cada 20 segundos
- 🎛️ **Filtros personalizáveis** por linha e direção
- 📱 **Interface intuitiva** com teclados personalizados

## 🛠️ Tecnologias

- **Node.js** com TypeScript
- **Grammy** - Framework para bots do Telegram
- **APIs da SEMOB-DF** - Dados oficiais de transporte público
- **Algoritmos geoespaciais** - Cálculos de distância Haversine

## 🚀 Como usar

1. **Inicie uma conversa** com o bot enviando `/start` ou "oi"
2. **Compartilhe sua localização** usando o botão "📍 Enviar localização"
3. **Escolha a direção** desejada (IDA, VOLTA ou ambas)
4. **Selecione a linha** específica ou "TODAS" para ver todas as opções
5. **Receba informações precisas** sobre os ônibus próximos

### Comandos disponíveis

- `oi`, `olá`, `/start` - Inicia uma nova busca
- `🔄 Atualizar busca` - Atualiza os dados com informações mais recentes
- `📍 Nova localização` - Define uma nova localização

## 📊 Algoritmo de Precisão

O bot utiliza algoritmos avançados que consideram:

- **Velocidade real** do veículo (quando disponível)
- **Fatores de trânsito** baseados no horário e dia da semana
- **Proximidade** e densidade urbana
- **Idade dos dados** para garantir informações atuais
- **Aceleração e frenagem** em paradas

### Níveis de Confiança

- 🎯 **Alto**: Dados em tempo real com velocidade conhecida
- 📍 **Médio**: Estimativas baseadas em padrões de tráfego
- ⚠️ **Baixo**: Projeções com maior margem de incerteza

## ⚙️ Configuração

### Pré-requisitos

- Node.js 18+ 
- npm ou yarn
- Token do bot do Telegram

### Instalação

```bash
# Clone o repositório
git clone [url-do-repositorio]
cd bus-tracker-bot

# Instale as dependências
npm install

# Configure o token do bot
# Edite o arquivo bot.ts e substitua o token

# Execute o bot
npm run start
```

### Variáveis de Ambiente

```env
BOT_TOKEN=seu_token_do_telegram_aqui
```

## 📡 APIs Utilizadas

O bot consome dados em tempo real das seguintes APIs da SEMOB-DF:

- **Posições dos Veículos**: Localização atual de todos os ônibus
- **Paradas de Ônibus**: Informações sobre rotas e paradas
- **Horários das Linhas**: Programação oficial dos ônibus

## 🔧 Configurações Avançadas

### Constantes de Precisão

```typescript
const PRECISION_CONSTANTS = {
    MAX_DATA_AGE_MINUTES: 15,    // Idade máxima dos dados
    MIN_SPEED_KMH: 8,            // Velocidade mínima considerada
    MAX_SPEED_KMH: 60,           // Velocidade máxima considerada
    DEFAULT_SPEED_KMH: 15,       // Velocidade padrão estimada
    MAX_SEARCH_RADIUS_M: 5000,   // Raio máximo de busca (metros)
    TRAFFIC_FACTOR: 1.3,         // Fator de correção para trânsito
    PEAK_HOURS: [[7, 9], [17, 19]], // Horários de pico
}
```

## 📈 Monitoramento

O bot inclui logs detalhados para monitoramento:

- Atualizações de dados das APIs
- Estatísticas de veículos processados
- Erros de conexão e timeout
- Performance dos algoritmos de cálculo

## 🤝 Contribuição

Contribuições são bem-vindas! Por favor:

1. Faça um fork do projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 🙏 Créditos

- **Desenvolvido com assistência de**: Claude (Anthropic) - Claude Sonnet 4
- **Dados fornecidos por**: SEMOB-DF (Secretaria de Mobilidade do Distrito Federal)
- **Framework de bot**: Grammy (Telegram Bot Framework)

## 📞 Suporte

Para dúvidas, sugestões ou problemas:

- Abra uma issue no GitHub
- Entre em contato através do próprio bot

---

**Nota**: Este é um projeto independente e não possui afiliação oficial com a SEMOB-DF ou Governo do Distrito Federal. Os dados são consumidos através de APIs públicas disponibilizadas pela SEMOB.