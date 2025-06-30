# Contextualização - APIs do Sistema de Mobilidade do DF (SEMOB)

## Endpoints Disponíveis

### 1. API de Última Posição Transmitida dos Veículos
**URL:** `https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AUltima%20Posicao%20Transmitida&outputFormat=application%2Fjson`

**Descrição:** Retorna as últimas posições GPS transmitidas pelos veículos do transporte público do Distrito Federal.

**Estrutura do JSON:**
- **Tipo:** FeatureCollection (GeoJSON)
- **Coordenadas:** Em longitude/latitude (WGS84)
- **Campos principais:**
  - `imei`: Identificador único do dispositivo de rastreamento
  - `datalocal`: Timestamp da coleta dos dados GPS (formato ISO 8601)
  - `dataregistro`: Timestamp do registro no sistema (formato ISO 8601)
  - `velocidade`: Velocidade do veículo em km/h
  - `latitude`/`longitude`: Coordenadas geográficas
  - `numerolinha`: Número da linha de ônibus (pode estar vazio)

**Exemplo de feature:**
```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [-47.954749, -15.821211]
  },
  "properties": {
    "imei": 710245,
    "datalocal": "2022-08-25T03:34:38Z",
    "dataregistro": "2022-08-25T03:34:43.306Z",
    "velocidade": 0,
    "latitude": -15.821211,
    "longitude": -47.954749,
    "numerolinha": ""
  }
}
```

### 2. API de Paradas de Ônibus
**URL:** `https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AParadas%20de%20onibus&outputFormat=application%2Fjson`

**Descrição:** Retorna informações sobre todas as paradas de ônibus cadastradas no sistema de transporte público do DF.

**Estrutura do JSON:**
- **Tipo:** FeatureCollection (GeoJSON)
- **Coordenadas:** Em projeção UTM (necessária conversão para lat/lng se necessário)
- **Campos principais:**
  - `parada`: Código/ID único da parada
  - `descricao`: Nome/descrição da localização da parada
  - `situacao`: Status da parada ("ATIVA", "DESATIVADA")
  - `estrutura_de_paragem`: Tipo de infraestrutura da parada
  - `tipo`: Categoria da parada (ex: "Habitual", "Cemusa", "Placa", "Tipo C")

**Exemplo de feature:**
```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [203579.70332991, 8239213.73351402]
  },
  "properties": {
    "parada": "6827",
    "descricao": "Residencial Vitoria",
    "situacao": "DESATIVADA",
    "estrutura_de_paragem": "SEM ESTRUTURA",
    "tipo": "Habitual"
  }
}
```

## Observações Importantes

### Sistemas de Coordenadas
- **Última Posição:** Coordenadas em WGS84 (longitude, latitude)
- **Paradas:** Coordenadas em UTM (necessária conversão para visualização em mapas web)

### Qualidade dos Dados
- Nem todos os veículos possuem `numerolinha` preenchido
- Algumas paradas estão com situação "DESATIVADA"
- Os timestamps podem apresentar defasagem entre `datalocal` e `dataregistro`
- Alguns campos podem estar nulos ou vazios

### Casos de Uso Típicos
- Monitoramento em tempo real da frota
- Análise de cobertura do transporte público
- Otimização de rotas e horários
- Planejamento urbano e mobilidade
- Aplicações de informação ao usuário

### Limitações Conhecidas
- Os dados podem não estar em tempo real absoluto
- Nem todos os veículos transmitem dados constantemente
- Algumas paradas podem estar geograficamente imprecisas
- A qualidade da informação varia conforme a manutenção dos equipamentos

### Sugestões de Processamento
- Filtrar veículos por timestamp recente para dados "atuais"
- Considerar apenas paradas com situação "ATIVA" para análises operacionais
- Implementar conversão de coordenadas UTM para WGS84 nas paradas
- Tratar campos nulos/vazios adequadamente nas análises