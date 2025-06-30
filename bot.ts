import { Bot } from "grammy";

const bot = new Bot("");

let cachedPositionData: any[] | null = null;
let cachedRouteData: any[] | null = null;
let cachedScheduleData: any[] | null = null;

const userPreferences = new Map<number, any>();
const userUpdateCounters = new Map<number, number>();
const userIntervals = new Map<number, NodeJS.Timeout>();
let organizedStops: Map<string, any[]> = new Map();
let allStopsById: Map<string, any> = new Map();

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
    MAX_AUTO_UPDATES: 10
};

function organizeStopsByLine() {
    if (!cachedRouteData) return;
    
    organizedStops.clear();
    allStopsById.clear();
    
    // Primeiro, criar mapa de todas as paradas por ID
    for (const stop of cachedRouteData) {
        const props = stop.properties;
        if (props?.situacao !== 'ATIVA' || !props?.parada) continue;
        
        const coords = stop.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        
        const { lat: stopLat, lon: stopLon } = utmToWgs84(coords[0], coords[1]);
        
        // Verificar se as coordenadas são válidas para Brasília
        if (stopLat < -16.2 || stopLat > -15.3 || stopLon < -48.3 || stopLon > -47.2) continue;
        
        const stopData = {
            id: props.parada,
            description: props.descricao || `Parada ${props.parada}`,
            latitude: stopLat,
            longitude: stopLon,
            type: props.tipo || 'Habitual',
            lines: [] as string[] // Linhas que passam por esta parada
        };
        
        allStopsById.set(props.parada, stopData);
    }
    
    // Aqui precisaríamos de dados de itinerário das linhas para ordenar as paradas
    // Como não temos essa informação diretamente, vamos usar uma abordagem baseada em proximidade geográfica
    console.log(`Organizadas ${allStopsById.size} paradas ativas`);
}

async function searchBusesDirectly(ctx: any, userPref: any, isAutoUpdate: boolean = false) {
    const { latitude: userLat, longitude: userLon, direction, busLine } = userPref;

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

        if (!isVehicleDataValid(vehicle)) continue;
        stats.validData++;

        if (!isVehicleInOperation(vehicle)) continue;
        stats.operating++;

        const props = vehicle.properties;
        
        if (busLine !== "ALL") {
            const vehicleLine = (props.numerolinha || "").trim().toUpperCase();
            const searchLine = busLine.trim().toUpperCase();
            if (vehicleLine !== searchLine) continue;
        }

        const distance = haversineImproved(userLat, userLon, props.latitude, props.longitude);
        if (distance > PRECISION_CONSTANTS.MAX_SEARCH_RADIUS_M) continue;
        stats.inRadius++;
            
        const arrivalData = calculateArrivalTime(userLat, userLon, vehicle);
        const nextSchedules = getNextSchedules(props.numerolinha, direction);

        nearbyBuses.push({
            linha: props.numerolinha || "Sem linha",
            distance: Math.round(distance),
            arrivalTime: arrivalData.timeMinutes,
            nextSchedules: nextSchedules,
            dataAge: Math.round((Date.now() - new Date(props.datalocal).getTime()) / 60000)
        });
    }

    const filteredBuses = filterAndSortBuses(nearbyBuses);
    stats.filtered = filteredBuses.length;

    if (filteredBuses.length === 0) {
        await ctx.reply(
            `🚌 Nenhum ônibus encontrado diretamente em até ${PRECISION_CONSTANTS.MAX_SEARCH_RADIUS_M/1000} km`,
            { reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard() }
        );
        return;
    }

    // Agrupar ônibus por linha
    const busesByLine: Record<string, any> = {};
    filteredBuses.forEach(bus => {
        const line = bus.linha;
        if (!busesByLine[line]) {
            busesByLine[line] = {
                minDistance: bus.distance,
                schedules: bus.nextSchedules.map((s: any) => s.time).join(', ')
            };
        } else {
            if (bus.distance < busesByLine[line].minDistance) {
                busesByLine[line].minDistance = bus.distance;
            }
        }
    });

    // Formatar resultados
    const results = [];
    for (const [line, data] of Object.entries(busesByLine)) {
        results.push(`${line} - ${data.minDistance}m - 🕒 ${data.schedules || 'Sem horários'}`);
    }

    const maxLines = 10;
    const displayedResults = results.slice(0, maxLines);
    
    let message = "🚌 Ônibus próximos (busca direta):\n\n";
    message += displayedResults.join("\n");
    
    if (results.length > maxLines) {
        message += `\n\n➕ Mais ${results.length - maxLines} linhas...`;
    }

    await ctx.reply(message, {
        reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard(),
    });
}

async function searchBuses(ctx: any, userPref: any, isAutoUpdate: boolean = false) {
    const { latitude: userLat, longitude: userLon, direction, busLine } = userPref;

    if (!cachedPositionData || !cachedRouteData) {
        await ctx.reply("⏳ Carregando dados dos ônibus e paradas, tente novamente em alguns segundos.");
        return;
    }

    // Organizar paradas se ainda não foi feito
    if (allStopsById.size === 0) {
        organizeStopsByLine();
    }

    // Encontrar paradas próximas
    const nearbyStops = findNearbyStops(userLat, userLon, 800);
    
    if (nearbyStops.length === 0) {
        await searchBusesDirectly(ctx, userPref, isAutoUpdate);
        return;
    }
    
    // Buscar ônibus nas paradas mais próximas
    const results = [];
    const processedLines = new Set();
    
    for (const stop of nearbyStops.slice(0, 3)) {
        const busesAtStop = findBusesNearStop(stop.latitude, stop.longitude, busLine, direction);
        
        for (const bus of busesAtStop) {
            const lineKey = `${bus.linha}-${stop.id}`;
            if (processedLines.has(lineKey)) continue;
            
            processedLines.add(lineKey);
            
            const scheduleText = bus.nextSchedules.length > 0 
                ? bus.nextSchedules.map((s: any) => s.time).slice(0, 3).join(', ')
                : 'Sem horários';
            
            results.push({
                linha: bus.linha,
                stopName: stop.description,
                stopDistance: stop.distance,
                busDistance: bus.distance,
                arrivalTime: bus.arrivalTime,
                confidence: bus.confidence,
                schedules: scheduleText,
                stopsToDestination: bus.stopsToDestination,
                stopsConfidence: bus.stopsConfidence,
                nearestBusStop: bus.nearestBusStop
            });
        }
    }
    
    if (results.length === 0) {
        await ctx.reply(
            `🚏 Encontrei ${nearbyStops.length} parada(s) próxima(s), mas nenhum ônibus ${busLine === 'ALL' ? '' : `da linha ${busLine} `}está passando por elas no momento.`,
            { reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard() }
        );
        return;
    }
    
    // Agrupar por linha e pegar o melhor resultado
    const busesByLine: Record<string, any> = {};
    results.forEach(result => {
        const line = result.linha;
        if (!busesByLine[line] || result.stopsToDestination < busesByLine[line].stopsToDestination) {
            busesByLine[line] = result;
        }
    });
    
    // Formatar resultados
    let message = `🚏 Ônibus nas paradas próximas:\n\n`;
    
    const sortedResults = Object.values(busesByLine)
        .sort((a: any, b: any) => {
            if (a.stopsToDestination !== b.stopsToDestination) {
                return a.stopsToDestination - b.stopsToDestination;
            }
            return a.stopDistance - b.stopDistance;
        })
        .slice(0, 8);
    
    for (const result of sortedResults) {
        const confidenceIcon = result.confidence === 'high' ? '🟢' : 
                              result.confidence === 'medium' ? '🟡' : '🔴';
        
        const stopsIcon = result.stopsConfidence === 'high' ? '🎯' : 
                         result.stopsConfidence === 'medium' ? '📍' : '❓';
        
        message += `${confidenceIcon} **${result.linha}** - ${result.arrivalTime}min\n`;
        message += `📍 ${result.stopName} (${result.stopDistance}m)\n`;
        
        if (result.stopsToDestination >= 0) {
            if (result.stopsToDestination === 0) {
                message += `🚏 Ônibus já está na parada!\n`;
            } else {
                message += `${stopsIcon} ${result.stopsToDestination} parada(s) restante(s)\n`;
            }
        }
        
        message += `🕒 ${result.schedules}\n\n`;
    }
    
    message += `💡 Encontradas ${nearbyStops.length} paradas em até 800m`;

    await ctx.reply(message, {
        reply_markup: isAutoUpdate ? undefined : createUpdateKeyboard(),
        parse_mode: 'Markdown'
    });

    const userId = ctx.from?.id;
    if (userId && !isAutoUpdate) {
        startAutoUpdates(ctx, userPref, userId);
    }
}

function getLineStopsSequence(lineNumber: string): any[] {
    // Esta função seria idealmente alimentada por dados de itinerário
    // Por enquanto, retornamos todas as paradas conhecidas para a linha
    const lineStops: any[] = [];
    
    // Buscar paradas que esta linha utiliza (baseado em horários ou outras fontes)
    if (cachedScheduleData) {
        const lineSchedules = cachedScheduleData.filter(schedule => 
            schedule.properties?.cd_linha === lineNumber
        );
        
        // Extrair paradas únicas dos horários (se houver informação de parada)
        const stopIds = new Set<string>();
        lineSchedules.forEach(schedule => {
            if (schedule.properties?.parada_id) {
                stopIds.add(schedule.properties.parada_id);
            }
        });
        
        stopIds.forEach(stopId => {
            const stopData = allStopsById.get(stopId);
            if (stopData) {
                lineStops.push(stopData);
            }
        });
    }
    
    return lineStops;
}

function calculateStopsToDestination(
    busLat: number, 
    busLon: number, 
    userLat: number, 
    userLon: number, 
    lineNumber: string
): {
    stopsCount: number;
    confidence: 'high' | 'medium' | 'low';
    method: string;
    nearestUserStop?: any;
    nearestBusStop?: any;
} {
    // Encontrar a parada mais próxima do usuário
    const userNearbyStops = findNearbyStops(userLat, userLon, 500);
    if (userNearbyStops.length === 0) {
        return {
            stopsCount: -1,
            confidence: 'low',
            method: 'no_nearby_stops'
        };
    }
    
    const nearestUserStop = userNearbyStops[0];
    
    // Encontrar a parada mais próxima do ônibus
    const busNearbyStops = findNearbyStops(busLat, busLon, 300);
    if (busNearbyStops.length === 0) {
        return {
            stopsCount: -1,
            confidence: 'low',
            method: 'bus_not_near_stop'
        };
    }
    
    const nearestBusStop = busNearbyStops[0];
    
    // Se for a mesma parada, o ônibus já chegou
    if (nearestBusStop.id === nearestUserStop.id) {
        return {
            stopsCount: 0,
            confidence: 'high',
            method: 'same_stop',
            nearestUserStop,
            nearestBusStop
        };
    }
    
    // Tentar calcular baseado na sequência de paradas da linha
    const lineStops = getLineStopsSequence(lineNumber);
    if (lineStops.length > 0) {
        const busStopIndex = lineStops.findIndex(stop => stop.id === nearestBusStop.id);
        const userStopIndex = lineStops.findIndex(stop => stop.id === nearestUserStop.id);
        
        if (busStopIndex !== -1 && userStopIndex !== -1) {
            let stopsCount;
            if (userStopIndex > busStopIndex) {
                stopsCount = userStopIndex - busStopIndex;
            } else {
                // Considerando linha circular ou volta
                stopsCount = (lineStops.length - busStopIndex) + userStopIndex;
            }
            
            return {
                stopsCount: Math.max(0, stopsCount),
                confidence: 'high',
                method: 'line_sequence',
                nearestUserStop,
                nearestBusStop
            };
        }
    }
    
    // Fallback: estimativa baseada em distância
    const distanceBetweenStops = haversineImproved(
        nearestBusStop.latitude, 
        nearestBusStop.longitude,
        nearestUserStop.latitude, 
        nearestUserStop.longitude
    );
    
    // Estimativa: paradas a cada 400m em média
    const estimatedStops = Math.round(distanceBetweenStops / 400);
    
    return {
        stopsCount: Math.max(1, estimatedStops),
        confidence: 'medium',
        method: 'distance_estimation',
        nearestUserStop,
        nearestBusStop
    };
}



function utmToWgs84(easting: number, northing: number): { lat: number, lon: number } {
    // Conversão aproximada para UTM Zone 23S (Brasília)
    const zone = 23;
    const hemisphere = 'S';
    
    // Constantes para conversão
    const a = 6378137.0; // Semi-major axis
    const e = 0.0818191908426; // Eccentricity
    const e1sq = 0.00673949674228; // e'^2
    const k0 = 0.9996; // Scale factor
    
    const x = easting - 500000.0; // Remove false easting
    const y = hemisphere === 'S' ? northing - 10000000.0 : northing; // Remove false northing for Southern hemisphere
    
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
    
    const lonCentralMeridian = (zone - 1) * 6 - 180 + 3; // Central meridian for the zone
    const lon = lonCentralMeridian + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 +
               (5 - 2 * C1 + 28 * T1 - 3 * Math.pow(C1, 2) + 8 * e1sq + 24 * Math.pow(T1, 2)) * Math.pow(D, 5) / 120) / Math.cos(phi1Rad);
    
    return {
        lat: lat * 180 / Math.PI,
        lon: lon * 180 / Math.PI
    };
}

function findNearbyStops(userLat: number, userLon: number, maxDistance: number = 1000): any[] {
    if (!cachedRouteData) return [];
    
    const nearbyStops = [];
    
    for (const stop of cachedRouteData) {
        const props = stop.properties;
        
        // Verificar se a parada está ativa
        if (props?.situacao !== 'ATIVA') continue;
        
        // Converter coordenadas UTM para WGS84
        const coords = stop.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        
        const { lat: stopLat, lon: stopLon } = utmToWgs84(coords[0], coords[1]);
        
        // Verificar se as coordenadas convertidas são válidas para Brasília
        if (stopLat < -16.2 || stopLat > -15.3 || stopLon < -48.3 || stopLon > -47.2) continue;
        
        const distance = haversineImproved(userLat, userLon, stopLat, stopLon);
        
        if (distance <= maxDistance) {
            nearbyStops.push({
                id: props.parada,
                description: props.descricao || `Parada ${props.parada}`,
                distance: Math.round(distance),
                latitude: stopLat,
                longitude: stopLon,
                type: props.tipo || 'Habitual'
            });
        }
    }
    
    return nearbyStops.sort((a, b) => a.distance - b.distance);
}

function findBusesNearStop(stopLat: number, stopLon: number, busLine: string, direction: string): any[] {
    if (!cachedPositionData) return [];
    
    const nearbyBuses = [];
    
    for (const vehicle of cachedPositionData) {
        if (!isVehicleDataValid(vehicle) || !isVehicleInOperation(vehicle)) continue;
        
        const props = vehicle.properties;
        
        // Filtrar por linha se especificado
        if (busLine !== "ALL") {
            const vehicleLine = (props.numerolinha || "").trim().toUpperCase();
            const searchLine = busLine.trim().toUpperCase();
            if (vehicleLine !== searchLine) continue;
        }
        
        const distance = haversineImproved(stopLat, stopLon, props.latitude, props.longitude);
        
        // Buscar em um raio maior ao redor da parada
        if (distance > 2000) continue;
        
        const arrivalData = calculateArrivalTime(stopLat, stopLon, vehicle);
        const nextSchedules = getNextSchedules(props.numerolinha, direction);
        
        // Calcular quantas paradas faltam
        const stopsInfo = calculateStopsToDestination(
            props.latitude,
            props.longitude,
            stopLat,
            stopLon,
            props.numerolinha
        );
        
        nearbyBuses.push({
            linha: props.numerolinha || "Sem linha",
            distance: Math.round(distance),
            arrivalTime: arrivalData.timeMinutes,
            confidence: arrivalData.confidence,
            nextSchedules: nextSchedules,
            dataAge: Math.round((Date.now() - new Date(props.datalocal).getTime()) / 60000),
            stopsToDestination: stopsInfo.stopsCount,
            stopsConfidence: stopsInfo.confidence,
            stopsMethod: stopsInfo.method,
            nearestBusStop: stopsInfo.nearestBusStop,
            vehiclePosition: { lat: props.latitude, lon: props.longitude }
        });
    }
    
    return nearbyBuses.sort((a, b) => {
        // Priorizar por número de paradas, depois por tempo de chegada
        if (a.stopsToDestination !== b.stopsToDestination) {
            return a.stopsToDestination - b.stopsToDestination;
        }
        return a.arrivalTime - b.arrivalTime;
    });
}

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
        .sort((a, b) => a.distance - b.distance);
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
        } else {
            console.error("Erro ao atualizar posições SEMOB:", response.status);
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
        } else {
            console.error("Erro ao atualizar rotas SEMOB:", response.status);
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
organizeStopsByLine();

setInterval(updatePositionData, 40000);
setInterval(() => {
    updateRouteData().then(() => {
        organizeStopsByLine();
    });
}, 172800);
setInterval(updateScheduleData, 172800);

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

function startAutoUpdates(ctx: any, userPref: any, userId: number) {
    stopAutoUpdates(userId);
    
    userUpdateCounters.set(userId, 0);
    
    const intervalId = setInterval(async () => {
        const count = userUpdateCounters.get(userId) || 0;
        
        if (count >= PRECISION_CONSTANTS.MAX_AUTO_UPDATES) {
            stopAutoUpdates(userId);
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
    
    userIntervals.set(userId, intervalId);
}

function stopAutoUpdates(userId: number) {
    const intervalId = userIntervals.get(userId);
    if (intervalId) {
        clearInterval(intervalId);
        userIntervals.delete(userId);
    }
    userUpdateCounters.delete(userId);
}

bot.hears(["oi", "Oi", "OI", "olá", "Olá", "OLÁ", "start", "/start"], (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        stopAutoUpdates(userId);
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
