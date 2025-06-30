import { Bot } from "grammy";

const bot = new Bot("");

let cachedPositionData: any[] | null = null;
let cachedRouteData: any[] | null = null;
let cachedScheduleData: any[] | null = null;

const userPreferences = new Map<number, any>();
const userUpdateCounters = new Map<number, number>();
const userIntervals = new Map<number, NodeJS.Timeout>();

const APIS = {
    POSITION: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AUltima%20Posicao%20Transmitida&outputFormat=application%2Fjson",
    ROUTES: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AParadas%20de%20onibus&outputFormat=application%2Fjson",
    SCHEDULE: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AHor%C3%A1rios%20das%20Linhas&outputFormat=application%2Fjson"
};

const CONSTANTS = {
    MAX_DATA_AGE_MINUTES: 15,
    MIN_SPEED_KMH: 8,
    MAX_SPEED_KMH: 60,
    DEFAULT_SPEED_KMH: 15,
    MAX_SEARCH_RADIUS_M: 5000,
    TRAFFIC_FACTOR: 1.3,
    MAX_AUTO_UPDATES: 10
};

async function searchBuses(ctx: any, userPref: any, isAutoUpdate: boolean = false) {
    const { latitude: userLat, longitude: userLon, direction, busLine } = userPref;

    if (!cachedPositionData || !cachedRouteData) {
        await ctx.reply("⏳ Carregando dados dos ônibus, tente novamente em alguns segundos.");
        return;
    }

    // Buscar paradas próximas
    const nearbyStops = findNearbyStops(userLat, userLon, 800);
    
    // Buscar ônibus diretamente se não há paradas próximas
    if (nearbyStops.length === 0) {
        await searchBusesDirectly(ctx, userPref, isAutoUpdate);
        return;
    }
    
    // Buscar ônibus nas paradas próximas
    const results = findBusesNearStops(nearbyStops, busLine, userLat, userLon);
    
    if (results.length === 0) {
        await ctx.reply(
            `🚏 Encontrei ${nearbyStops.length} parada(s) próxima(s), mas nenhum ônibus ${busLine === 'ALL' ? '' : `da linha ${busLine} `}está passando por elas no momento.`,
            { reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard() }
        );
        return;
    }
    
    // Formatar e enviar resultados
    await sendBusResults(ctx, results, nearbyStops.length, isAutoUpdate);

    const userId = ctx.from?.id;
    if (userId && !isAutoUpdate) {
        startAutoUpdates(ctx, userPref, userId);
    }
}

async function searchBusesDirectly(ctx: any, userPref: any, isAutoUpdate: boolean) {
    const { latitude: userLat, longitude: userLon, direction, busLine } = userPref;
    const nearbyBuses = [];

    for (const vehicle of cachedPositionData) {
        if (!isVehicleValid(vehicle)) continue;

        const props = vehicle.properties;
        
        if (busLine !== "ALL" && !isLineMatch(props.numerolinha, busLine)) continue;

        const distance = calculateDistance(userLat, userLon, props.latitude, props.longitude);
        if (distance > CONSTANTS.MAX_SEARCH_RADIUS_M) continue;
            
        const arrivalTime = calculateArrivalTime(distance, props.velocidade);
        const schedules = getNextSchedules(props.numerolinha, direction);

        nearbyBuses.push({
            linha: props.numerolinha || "Sem linha",
            distance: Math.round(distance),
            arrivalTime,
            schedules: schedules.map(s => s.time).join(', ') || 'Sem horários'
        });
    }

    if (nearbyBuses.length === 0) {
        await ctx.reply(
            `🚌 Nenhum ônibus encontrado em até ${CONSTANTS.MAX_SEARCH_RADIUS_M/1000} km`,
            { reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard() }
        );
        return;
    }

    // Agrupar por linha e enviar resultados
    const results = groupBusesByLine(nearbyBuses);
    await sendDirectBusResults(ctx, results, isAutoUpdate);
}

function findNearbyStops(userLat: number, userLon: number, maxDistance: number): any[] {
    if (!cachedRouteData) return [];
    
    const nearbyStops = [];
    
    for (const stop of cachedRouteData) {
        const props = stop.properties;
        if (props?.situacao !== 'ATIVA') continue;
        
        const coords = stop.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        
        const { lat: stopLat, lon: stopLon } = utmToWgs84(coords[0], coords[1]);
        
        // Validar coordenadas para Brasília
        if (stopLat < -16.2 || stopLat > -15.3 || stopLon < -48.3 || stopLon > -47.2) continue;
        
        const distance = calculateDistance(userLat, userLon, stopLat, stopLon);
        
        if (distance <= maxDistance) {
            nearbyStops.push({
                id: props.parada,
                description: props.descricao || `Parada ${props.parada}`,
                distance: Math.round(distance),
                latitude: stopLat,
                longitude: stopLon
            });
        }
    }
    
    return nearbyStops.sort((a, b) => a.distance - b.distance);
}

function findBusesNearStops(stops: any[], busLine: string, userLat: number, userLon: number): any[] {
    const results = [];
    
    for (const stop of stops.slice(0, 3)) {
        const busesAtStop = [];
        
        for (const vehicle of cachedPositionData) {
            if (!isVehicleValid(vehicle)) continue;
            
            const props = vehicle.properties;
            if (busLine !== "ALL" && !isLineMatch(props.numerolinha, busLine)) continue;
            
            const distance = calculateDistance(stop.latitude, stop.longitude, props.latitude, props.longitude);
            if (distance > 2000) continue;
            
            const arrivalTime = calculateArrivalTime(distance, props.velocidade);
            
            busesAtStop.push({
                linha: props.numerolinha || "Sem linha",
                stopName: stop.description,
                stopDistance: stop.distance,
                arrivalTime,
                distance: Math.round(distance)
            });
        }
        
        results.push(...busesAtStop);
    }
    
    return results.sort((a, b) => a.arrivalTime - b.arrivalTime);
}

function isVehicleValid(vehicle: any): boolean {
    const props = vehicle.properties;
    
    // Validar coordenadas
    if (!props?.latitude || !props?.longitude || isNaN(props.latitude) || isNaN(props.longitude)) {
        return false;
    }
    
    // Validar área de Brasília
    if (props.latitude < -16.2 || props.latitude > -15.3 || props.longitude < -48.3 || props.longitude > -47.2) {
        return false;
    }
    
    // Validar idade dos dados
    if (props.datalocal) {
        const timeDiff = Date.now() - new Date(props.datalocal).getTime();
        const maxAge = CONSTANTS.MAX_DATA_AGE_MINUTES * 60 * 1000;
        if (timeDiff > maxAge || timeDiff < 0) return false;
    }
    
    // Validar linha
    if (!props?.numerolinha || props.numerolinha.trim() === "") {
        return false;
    }
    
    return true;
}

function isLineMatch(vehicleLine: string, searchLine: string): boolean {
    return vehicleLine?.trim().toUpperCase() === searchLine.trim().toUpperCase();
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const toRad = (deg: number) => deg * (Math.PI / 180);
    
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

function calculateArrivalTime(distance: number, vehicleSpeed?: number): number {
    let speedKmh = vehicleSpeed && vehicleSpeed > 0 ? vehicleSpeed : CONSTANTS.DEFAULT_SPEED_KMH;
    
    // Aplicar fator de trânsito
    speedKmh = speedKmh / CONSTANTS.TRAFFIC_FACTOR;
    
    const speedMs = speedKmh * 1000 / 3600;
    const timeSeconds = distance / speedMs;
    
    return Math.max(1, Math.round(timeSeconds / 60));
}

function getNextSchedules(lineCode: string, direction: string) {
    if (!cachedScheduleData) return [];
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    return cachedScheduleData
        .filter(schedule => {
            const props = schedule.properties;
            return props?.cd_linha === lineCode && 
                   (direction === "BOTH" || 
                    (direction === "IDA" && props.sentido === "I") ||
                    (direction === "VOLTA" && props.sentido === "V"));
        })
        .map(schedule => {
            const timeStr = schedule.properties.hr_prevista?.trim();
            if (!timeStr || !timeStr.match(/^\d{1,2}:\d{2}$/)) return null;
            
            const [hours, minutes] = timeStr.split(':').map(Number);
            const scheduleTime = hours * 60 + minutes;
            
            let minutesFromNow = scheduleTime > currentTime 
                ? scheduleTime - currentTime 
                : (24 * 60) - currentTime + scheduleTime;
            
            return { time: timeStr, minutesFromNow };
        })
        .filter(Boolean)
        .sort((a, b) => a.minutesFromNow - b.minutesFromNow)
        .slice(0, 3);
}

function groupBusesByLine(buses: any[]): any[] {
    const busesByLine: Record<string, any> = {};
    
    buses.forEach(bus => {
        const line = bus.linha;
        if (!busesByLine[line] || bus.distance < busesByLine[line].distance) {
            busesByLine[line] = bus;
        }
    });
    
    return Object.values(busesByLine).sort((a: any, b: any) => a.distance - b.distance);
}

async function sendBusResults(ctx: any, results: any[], stopsCount: number, isAutoUpdate: boolean) {
    let message = `🚏 Ônibus nas paradas próximas:\n\n`;
    
    for (const result of results.slice(0, 8)) {
        message += `🚌 **${result.linha}** - ${result.arrivalTime}min\n`;
        message += `📍 ${result.stopName} (${result.stopDistance}m)\n\n`;
    }
    
    message += `💡 Encontradas ${stopsCount} paradas em até 800m`;

    await ctx.reply(message, {
        reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard(),
        parse_mode: 'Markdown'
    });
}

async function sendDirectBusResults(ctx: any, results: any[], isAutoUpdate: boolean) {
    let message = "🚌 Ônibus próximos:\n\n";
    
    for (const result of results.slice(0, 10)) {
        message += `${result.linha} - ${result.distance}m - 🕒 ${result.schedules}\n`;
    }

    await ctx.reply(message, {
        reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard()
    });
}

// Função UTM mantida (necessária para conversão de coordenadas)
function utmToWgs84(easting: number, northing: number): { lat: number, lon: number } {
    // Conversão aproximada para UTM Zone 23S (Brasília)
    const zone = 23;
    const hemisphere = 'S';
    
    const a = 6378137.0;
    const e = 0.0818191908426;
    const e1sq = 0.00673949674228;
    const k0 = 0.9996;
    
    const x = easting - 500000.0;
    const y = hemisphere === 'S' ? northing - 10000000.0 : northing;
    
    const M = y / k0;
    const mu = M / (a * (1 - Math.pow(e, 2) / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256));
    
    const phi1Rad = mu + (3 * e1sq / 2 - 27 * Math.pow(e1sq, 3) / 32) * Math.sin(2 * mu) +
                   (21 * Math.pow(e1sq, 2) / 16 - 55 * Math.pow(e1sq, 4) / 32) * Math.sin(4 * mu) +
                   (151 * Math.pow(e1sq, 3) / 96) * Math.sin(6 * mu);
    
    const rho1 = a * (1 - Math.pow(e, 2)) / Math.pow(1 - Math.pow(e, 2) * Math.pow(Math.sin(phi1Rad), 2), 1.5);
    const nu1 = a / Math.sqrt(1 - Math.pow(e, 2) * Math.pow(Math.sin(phi1Rad), 2));
    
    const T1 = Math.pow(Math.tan(phi1Rad), 2);
    const C1 = e1sq * Math.pow(Math.cos(phi1Rad), 2);
    const R1 = a * (1 - Math.pow(e, 2)) / Math.pow(1 - Math.pow(e, 2) * Math.pow(Math.sin(phi1Rad), 2), 1.5);
    const D = x / (nu1 * k0);
    
    const lat = phi1Rad - (nu1 * Math.tan(phi1Rad) / R1) * 
               (Math.pow(D, 2) / 2 - (5 + 3 * T1 + 10 * C1 - 4 * Math.pow(C1, 2) - 9 * e1sq) * Math.pow(D, 4) / 24 +
               (61 + 90 * T1 + 298 * C1 + 45 * Math.pow(T1, 2) - 252 * e1sq - 3 * Math.pow(C1, 2)) * Math.pow(D, 6) / 720);
    
    const lonCentralMeridian = (zone - 1) * 6 - 180 + 3;
    const lon = lonCentralMeridian + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 +
               (5 - 2 * C1 + 28 * T1 - 3 * Math.pow(C1, 2) + 8 * e1sq + 24 * Math.pow(T1, 2)) * Math.pow(D, 5) / 120) / Math.cos(phi1Rad);
    
    return {
        lat: lat * 180 / Math.PI,
        lon: lon * 180 / Math.PI
    };
}

// Funções de atualização de dados (mantidas)
async function updatePositionData() {
    try {
        const response = await fetch(APIS.POSITION, {
            method: "GET",
            headers: {
                "accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)",
            },
            signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
            const data = await response.json();
            cachedPositionData = data.features || [];
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB posições:", error);
    }
}

async function updateRouteData() {
    try {
        const response = await fetch(APIS.ROUTES, {
            method: "GET",
            headers: {
                "accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)",
            },
            signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
            const data = await response.json();
            cachedRouteData = data.features || [];
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB rotas:", error);
    }
}

async function updateScheduleData() {
    try {
        const response = await fetch(APIS.SCHEDULE, {
            method: "GET",
            headers: {
                "accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)",
            },
            signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
            const data = await response.json();
            cachedScheduleData = data.features || [];
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB horários:", error);
    }
}

function createUpdateKeyboard() {
    return {
        keyboard: [
            [{ text: "🔄 Atualizar busca" }],
            [{ text: "📍 Nova localização" }],
        ],
        resize_keyboard: true,
    };
}

function startAutoUpdates(ctx: any, userPref: any, userId: number) {
    const intervalId = userIntervals.get(userId);
    if (intervalId) clearInterval(intervalId);
    
    userUpdateCounters.set(userId, 0);
    
    const newIntervalId = setInterval(async () => {
        const count = userUpdateCounters.get(userId) || 0;
        
        if (count >= CONSTANTS.MAX_AUTO_UPDATES) {
            clearInterval(newIntervalId);
            userIntervals.delete(userId);
            await ctx.reply("🔴 Atualizações automáticas encerradas. Envie 'oi' para nova busca.");
            return;
        }
        
        try {
            await searchBuses(ctx, userPref, true);
            userUpdateCounters.set(userId, count + 1);
        } catch (error) {
            console.error("Erro na atualização automática:", error);
        }
    }, 60000);
    
    userIntervals.set(userId, newIntervalId);
}

// Inicialização
updatePositionData();
updateRouteData();
updateScheduleData();

setInterval(updatePositionData, 40000);
setInterval(updateRouteData, 172800);
setInterval(updateScheduleData, 172800);

// Handlers do bot (mantidos como estão)
bot.hears(["oi", "Oi", "OI", "olá", "Olá", "OLÁ", "start", "/start"], (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        const intervalId = userIntervals.get(userId);
        if (intervalId) clearInterval(intervalId);
        userPreferences.delete(userId);
    }
    
    return ctx.reply(
        "🚌 Olá! Encontrarei ônibus próximos usando dados da SEMOB.\n\n" +
        "Por favor, envie sua localização:",
        {
            reply_markup: {
                keyboard: [
                    [
                        {
                            text: "📍 Enviar localização",
                            request_location: true,
                        },
                    ],
                ],
                one_time_keyboard: true,
                resize_keyboard: true,
            },
        }
    );
});

bot.hears("📍 Nova localização", (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        const userPref = userPreferences.get(userId);
        if (userPref) {
            userPref.step = 'awaiting_location';
            userPreferences.set(userId, userPref);
        }
    }
    
    return ctx.reply(
        "📍 Envie sua nova localização:",
        {
            reply_markup: {
                keyboard: [
                    [
                        {
                            text: "📍 Enviar localização",
                            request_location: true,
                        },
                    ],
                ],
                one_time_keyboard: true,
                resize_keyboard: true,
            },
        }
    );
});

bot.hears("🔄 Atualizar busca", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userPref = userPreferences.get(userId);
    if (!userPref || !userPref.latitude || !userPref.direction || !userPref.busLine) {
        await ctx.reply("❌ Preferências não encontradas. Digite 'oi' para nova busca.");
        return;
    }

    await ctx.reply("🔄 Atualizando busca...");
    await searchBuses(ctx, userPref, false);
});

bot.on("message:location", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userLat = ctx.message.location.latitude;
    const userLon = ctx.message.location.longitude;

    let userPref = userPreferences.get(userId) || {};
    
    userPref.latitude = userLat;
    userPref.longitude = userLon;
    userPref.step = 'location_received';
    
    userPreferences.set(userId, userPref);

    await ctx.reply(
        "📍 Localização recebida!\n\n" +
        "Escolha o sentido dos ônibus:",
        {
            reply_markup: {
                keyboard: [
                    [{ text: "🔄 IDA e VOLTA" }],
                    [{ text: "➡️ Apenas IDA" }, { text: "⬅️ Apenas VOLTA" }],
                ],
                one_time_keyboard: true,
                resize_keyboard: true,
            },
        }
    );
});

bot.hears(["🔄 IDA e VOLTA", "➡️ Apenas IDA", "⬅️ Apenas VOLTA"], async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userPref = userPreferences.get(userId);
    if (!userPref || userPref.step !== 'location_received') {
        await ctx.reply("❌ Envie sua localização primeiro digitando 'oi'.");
        return;
    }

    let direction;
    if (ctx.message?.text === "🔄 IDA e VOLTA") {
        direction = "BOTH";
    } else if (ctx.message?.text === "➡️ Apenas IDA") {
        direction = "IDA";
    } else {
        direction = "VOLTA";
    }

    userPref.direction = direction;
    userPref.step = 'direction_received';
    userPreferences.set(userId, userPref);

    await ctx.reply(
        "🚌 Escolha a linha:\n\n" +
        "• Digite o número da linha (ex: 0.123, W3)\n" +
        "• Ou digite 'TODAS' para todas as linhas",
        {
            reply_markup: {
                keyboard: [
                    [{ text: "🚌 TODAS as linhas" }],
                ],
                one_time_keyboard: true,
                resize_keyboard: true,
            },
        }
    );
});

bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userPref = userPreferences.get(userId);
    if (!userPref || userPref.step !== 'direction_received') {
        return;
    }

    const text = ctx.message.text.trim();
    let busLine = null;
    
    if (text === "🚌 TODAS as linhas" || text.toUpperCase() === "TODAS") {
        busLine = "ALL";
    } else {
        busLine = text;
    }

    userPref.busLine = busLine;
    userPref.step = 'completed';
    userPreferences.set(userId, userPref);

    await searchBuses(ctx, userPref, false);
});

bot.catch((err) => {
    console.error("Erro no middleware:", err);
});

bot.start();
