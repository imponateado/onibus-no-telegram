import { Bot } from "grammy";

const bot = new Bot(""); //pegue o token de um BOT no @BotFather

let cachedPositionData: any[] | null = null;
let cachedRouteData: any[] | null = null;
let cachedScheduleData: any[] | null = null;

const userPreferences = new Map();

const APIS = {
    POSITION: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AUltima%20Posicao%20Transmitida&outputFormat=application%2Fjson",
    ROUTES: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AParadas%20de%20onibus&outputFormat=application%2Fjson",
    SCHEDULE: "https://geoserver.semob.df.gov.br/geoserver/semob/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=semob%3AHor%C3%A1rios%20das%20Linhas&outputFormat=application%2Fjson"
};

const PRECISION_CONSTANTS = {
    MAX_DATA_AGE_MINUTES: 15,
    
    MIN_SPEED_KMH: 8,
    MAX_SPEED_KMH: 60,
    DEFAULT_SPEED_KMH: 15,
    
    MAX_SEARCH_RADIUS_M: 5000,
    STOP_PROXIMITY_M: 100,
    
    TRAFFIC_FACTOR: 1.3,
    ACCELERATION_FACTOR: 1.2,
    
    PEAK_HOURS: [[7, 9], [17, 19]],
    NIGHT_HOURS: [22, 6],
};

function haversineImproved(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

function getTrafficFactor(): number {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return 1.1;
    }
    
    for (const [start, end] of PRECISION_CONSTANTS.PEAK_HOURS) {
        if (hour >= start && hour <= end) {
            return 1.6;
        }
    }
    
    const [nightStart, nightEnd] = PRECISION_CONSTANTS.NIGHT_HOURS;
    if (hour >= nightStart || hour <= nightEnd) {
        return 0.8;
    }
    
    return PRECISION_CONSTANTS.TRAFFIC_FACTOR;
}

function isVehicleDataValid(vehicle: any): boolean {
    const props = vehicle.properties;
    
    if (!props?.latitude || !props?.longitude || 
        isNaN(props.latitude) || isNaN(props.longitude)) {
        return false;
    }

    const lat = props.latitude;
    const lon = props.longitude;
    
    if (lat < -16.2 || lat > -15.3 || lon < -48.3 || lon > -47.2) {
        return false;
    }

    if (props.datalocal) {
        const now = Date.now();
        const vehicleTime = new Date(props.datalocal).getTime();
        const timeDiff = now - vehicleTime;
        const maxAge = PRECISION_CONSTANTS.MAX_DATA_AGE_MINUTES * 60 * 1000;
        
        if (timeDiff > maxAge || timeDiff < 0) {
            return false;
        }
    } else {
        return false;
    }

    if (props.velocidade !== undefined) {
        const speed = props.velocidade;
        if (speed < 0 || speed > PRECISION_CONSTANTS.MAX_SPEED_KMH) {
            return false;
        }
    }

    return true;
}

function isVehicleInOperation(vehicle: any): boolean {
    const props = vehicle.properties;
    
    if (!props?.numerolinha || props.numerolinha.trim() === "") {
        return false;
    }

    if (props.velocidade !== undefined && props.velocidade < 2) {
        return true;
    }

    return true;
}

function calculateArrivalTime(userLat: number, userLon: number, vehicle: any): {
    timeMinutes: number;
    confidence: 'high' | 'medium' | 'low';
    factors: string[];
} {
    const props = vehicle.properties;
    const distance = haversineImproved(userLat, userLon, props.latitude, props.longitude);
    
    let factors: string[] = [];
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    
    let speedKmh = PRECISION_CONSTANTS.DEFAULT_SPEED_KMH;
    
    if (props.velocidade > 0) {
        speedKmh = props.velocidade;
        confidence = 'high';
        factors.push('velocidade real');
    } else {
        confidence = 'medium';
        factors.push('velocidade estimada');
    }
    
    if (distance < 500) {
        speedKmh = Math.min(speedKmh, 12);
        factors.push('proximidade');
    } else if (distance > 2000) {
        speedKmh = Math.min(speedKmh, 25);
        factors.push('distância');
    }
    
    const trafficFactor = getTrafficFactor();
    speedKmh = speedKmh / trafficFactor;
    factors.push(`trânsito ${trafficFactor.toFixed(1)}x`);

    const speedMs = speedKmh * 1000 / 3600;
    let timeSeconds = distance / speedMs;
    
    timeSeconds *= PRECISION_CONSTANTS.ACCELERATION_FACTOR;
    factors.push('aceleração/frenagem');
    
    const timeMinutes = Math.max(1, Math.round(timeSeconds / 60));
    
    if (factors.includes('velocidade real') && distance < 2000) {
        confidence = 'high';
    } else if (distance > 3000 || !factors.includes('velocidade real')) {
        confidence = 'low';
    }
    
    return { timeMinutes, confidence, factors };
}

function filterAndSortBuses(nearbyBuses: any[]): any[] {
    return nearbyBuses
        .filter(bus => {
            return bus.confidence !== 'low' || bus.distance < 1000;
        })
        .sort((a, b) => {
            const scoreA = a.timeMinutes + (a.confidence === 'low' ? 10 : 0);
            const scoreB = b.timeMinutes + (b.confidence === 'low' ? 10 : 0);
            return scoreA - scoreB;
        });
}

function getNextSchedules(lineCode: string, direction: string) {
    if (!cachedScheduleData) return [];
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute;
    
    return cachedScheduleData
        .filter(schedule => {
            const props = schedule.properties;
            return props?.cd_linha === lineCode && 
                   (direction === "BOTH" || 
                    (direction === "IDA" && props.sentido === "I") ||
                    (direction === "VOLTA" && props.sentido === "V") ||
                    (direction === "CIRCULAR" && props.sentido === "C"));
        })
        .map(schedule => {
            const timeStr = schedule.properties.hr_prevista?.trim();
            if (!timeStr || !timeStr.match(/^\d{1,2}:\d{2}$/)) return null;
            
            const [hours, minutes] = timeStr.split(':').map(Number);
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
            
            const scheduleTime = hours * 60 + minutes;
            let minutesFromNow;
            
            if (scheduleTime > currentTime) {
                minutesFromNow = scheduleTime - currentTime;
            } else {
                minutesFromNow = (24 * 60) - currentTime + scheduleTime;
            }
            
            return {
                time: timeStr,
                minutesFromNow: minutesFromNow
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.minutesFromNow - b.minutesFromNow)
        .slice(0, 3);
}

async function updatePositionData() {
    try {
        console.log("Atualizando dados de posição...");
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
            console.log(`Dados de posição atualizados: ${cachedPositionData.length} veículos`);
        } else {
            console.error("Erro ao atualizar posições SEMOB:", response.status);
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB posições:", error);
    }
}

async function updateRouteData() {
    try {
        console.log("Atualizando dados de rotas...");
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
            console.log(`Dados de rotas atualizados: ${cachedRouteData.length} linhas`);
        } else {
            console.error("Erro ao atualizar rotas SEMOB:", response.status);
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB rotas:", error);
    }
}

async function updateScheduleData() {
    try {
        console.log("Atualizando dados de horários...");
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
            console.log(`Dados de horários atualizados: ${cachedScheduleData.length} horários`);
        } else {
            console.error("Erro ao atualizar horários SEMOB:", response.status);
        }
    } catch (error) {
        console.error("Erro na requisição SEMOB horários:", error);
    }
}

updatePositionData();
updateRouteData();
updateScheduleData();

// Atualizar dados com frequência otimizada para precisão
setInterval(updatePositionData, 40000); // 20s para posições (mais frequente)
setInterval(updateRouteData, 172800);   // 5min para rotas
setInterval(updateScheduleData, 172800); // 5min para horários

function getLineInfo(lineCode: string) {
    if (!cachedRouteData) return null;
    
    return cachedRouteData.find(route => 
        route.properties?.linha === lineCode
    );
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

bot.hears(["oi", "Oi", "OI", "olá", "Olá", "OLÁ", "start", "/start"], (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        userPreferences.delete(userId);
    }
    
    return ctx.reply(
        "🚌 Olá! Vou te ajudar a encontrar ônibus próximos com máxima precisão usando dados oficiais da SEMOB.\n\n" +
        "Primeiro, me envie sua localização:",
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
        await ctx.reply("❌ Não encontrei suas preferências salvas. Digite 'oi' para começar uma nova busca.");
        return;
    }

    await ctx.reply("🔄 Atualizando busca com dados mais recentes...");
    await searchBuses(ctx, userPref);
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
        "📍 Localização recebida com precisão!\n\n" +
        "Agora escolha o sentido dos ônibus:",
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
        await ctx.reply("❌ Por favor, envie sua localização primeiro digitando 'oi'.");
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
        "🚌 Agora escolha qual linha você quer:\n\n" +
        "• Digite o número/código da linha (ex: 0.123, W3, etc.)\n" +
        "• Ou digite 'TODAS' para ver todas as linhas",
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

    await searchBuses(ctx, userPref);
});

async function searchBuses(ctx: any, userPref: any) {
    const { latitude: userLat, longitude: userLon, direction, busLine } = userPref;

    if (!cachedPositionData) {
        await ctx.reply(
            "⏳ Ainda estou carregando os dados dos ônibus da SEMOB, tente novamente em alguns segundos.",
        );
        return;
    }

    const nearbyBuses = [];
    let stats = {
        total: 0,
        validData: 0,
        operating: 0,
        inRadius: 0,
        filtered: 0
    };

    for (const vehicle of cachedPositionData) {
        stats.total++;

        if (!isVehicleDataValid(vehicle)) {
            continue;
        }
        stats.validData++;

        if (!isVehicleInOperation(vehicle)) {
            continue;
        }
        stats.operating++;

        const props = vehicle.properties;
        
        if (busLine !== "ALL") {
            const vehicleLine = (props.numerolinha || "").trim().toUpperCase();
            const searchLine = busLine.trim().toUpperCase();
            
            if (vehicleLine !== searchLine) {
                continue;
            }
        }

        const distance = haversineImproved(userLat, userLon, props.latitude, props.longitude);

        if (distance <= PRECISION_CONSTANTS.MAX_SEARCH_RADIUS_M) {
            stats.inRadius++;
            
            const arrivalData = calculateArrivalTime(userLat, userLon, vehicle);
            
            const lineInfo = getLineInfo(props.numerolinha);
            const nextSchedules = getNextSchedules(props.numerolinha, direction);

            nearbyBuses.push({
                imei: props.imei,
                linha: props.numerolinha || "Sem linha",
                lineName: lineInfo?.properties?.nome || "Nome não disponível",
                distance: Math.round(distance),
                timeMinutes: arrivalData.timeMinutes,
                confidence: arrivalData.confidence,
                factors: arrivalData.factors,
                speedKmh: props.velocidade || 0,
                isEstimatedSpeed: props.velocidade === 0,
                lastUpdate: props.datalocal,
                nextSchedules: nextSchedules,
                tarifa: lineInfo?.properties?.tarifa || "Não informada",
                dataAge: Math.round((Date.now() - new Date(props.datalocal).getTime()) / 60000) // idade em minutos
            });
        }
    }

    const filteredBuses = filterAndSortBuses(nearbyBuses);
    stats.filtered = filteredBuses.length;

    console.log(`Stats SEMOB: ${stats.total} total, ${stats.validData} válidos, ${stats.operating} operando, ${stats.inRadius} no raio, ${stats.filtered} após filtros`);

    let filterInfo = "";
    if (direction !== "BOTH") {
        filterInfo += `Direção: ${direction}\n`;
    }
    if (busLine !== "ALL") {
        filterInfo += `Linha: ${busLine}\n`;
    }

    const trafficFactor = getTrafficFactor();
    const configInfo = `📋 Configuração atual:\n${filterInfo}📍 Localização: Salva\n🚦 Fator trânsito: ${trafficFactor.toFixed(1)}x\n\n`;

    if (filteredBuses.length === 0) {
        await ctx.reply(
            `🚌 Não encontrei ônibus em operação a até ${PRECISION_CONSTANTS.MAX_SEARCH_RADIUS_M/1000} km da sua localização.\n\n` +
            `${configInfo}` +
            `📊 Análise dos dados:\n` +
            `• ${stats.validData} veículos com dados válidos (${stats.total} total)\n` +
            `• ${stats.operating} em operação\n` +
            `• ${stats.inRadius} no raio de busca\n` +
            `• Dados atualizados a cada 20s`,
            {
                reply_markup: createUpdateKeyboard(),
            }
        );
        return;
    }

    const maxBusesToShow = 15;
    const lines = filteredBuses.slice(0, maxBusesToShow).map((bus) => {
        const confidenceIcon = {
            'high': '🎯',
            'medium': '📍', 
            'low': '⚠️'
        }[bus.confidence];
        
        let line = `${confidenceIcon} **${bus.linha}** - ${bus.timeMinutes} min`;
        
        if (bus.confidence === 'high') {
            line += ` (preciso)`;
        } else if (bus.confidence === 'low') {
            line += ` (estimado)`;
        }
        
        if (bus.dataAge <= 1) {
            line += ` • 🔴 ao vivo`;
        } else if (bus.dataAge <= 5) {
            line += ` • 🟡 ${bus.dataAge}min`;
        } else {
            line += ` • 🟠 ${bus.dataAge}min`;
        }
        
        if (bus.lineName !== "Nome não disponível") {
            line += `\n   📍 ${bus.lineName}`;
        }
        
        line += `\n   📏 ${bus.distance}m`;
        if (bus.speedKmh > 0) {
            line += ` • 🚌 ${bus.speedKmh}km/h`;
        }
        
        if (bus.nextSchedules.length > 0) {
            const nextTimes = bus.nextSchedules.slice(0, 2).map(s => s.time).join(', ');
            line += `\n   ⏰ Próximos: ${nextTimes}`;
        }
        
        return line;
    });

    const message = `🚌 **Ônibus próximos (precisão otimizada):**\n\n` +
        `${configInfo}` +
        `${lines.join("\n\n")}` +
        (filteredBuses.length > maxBusesToShow
            ? `\n\n➕ E mais ${filteredBuses.length - maxBusesToShow} ônibus...`
            : "") +
        `\n\n📊 Dados: ${stats.filtered} ônibus de ${stats.operating} em operação`;

    await ctx.reply(message, {
        reply_markup: createUpdateKeyboard(),
    });
}

bot.catch((err) => {
    console.error("Erro no middleware:", err);
});

bot.start();