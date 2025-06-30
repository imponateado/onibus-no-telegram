# 🚌 Bot de Rastreamento de Ônibus DF

Um bot do Telegram que fornece informações precisas e em tempo real sobre ônibus públicos do Distrito Federal, utilizando dados oficiais da SEMOB-DF.

## ✨ Funcionalidades

- 📍 **Localização em tempo real** dos ônibus próximos
- 🚦 **Análise de trânsito** com fatores de horário de pico
- 📊 **Horários programados** das linha
- 🎛️ **Filtros personalizáveis** por linha e direção

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
- 

## ⚙️ Configuração

### Pré-requisitos

- Deno
- pnpm
- Token do bot do Telegram (pegar com o [@BotFather](https://t.me/@BotFather))

### Instalação

```bash
# Clone o repositório
git clone https://github.com/imponateado/onibus-no-telegram
cd onibus-no-telegram

# Configure o token do bot
# Edite o arquivo bot.ts e substitua o token

# Execute o bot
deno -IN --allow-env --unsafely-ignore-certificate-errors bot.ts
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

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 🙏 Créditos

- **Desenvolvido com assistência de**: Claude (Anthropic) - Claude Sonnet 4
- **Dados fornecidos por**: SEMOB-DF (Secretaria de Mobilidade do Distrito Federal)
- **Framework de bot**: Grammy (Telegram Bot Framework)

---

**Nota**: Este é um projeto independente e não possui afiliação oficial com a SEMOB-DF ou Governo do Distrito Federal. Os dados são consumidos através de APIs públicas disponibilizadas pela SEMOB.
