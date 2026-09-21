// ============================================
// SISTEMA DE IRRIGAÇÃO - JAVASCRIPT
// ============================================

// ============================================
// CONSTANTES / CHAVES DE ARMAZENAMENTO
// ============================================

const STORAGE_KEYS = {
    settings: 'irrigacao_settings',
    history: 'irrigacao_history',
};

const MAX_HISTORY_ITEMS = 30;
const SENSOR_POLL_INTERVAL_MS = 5000;
const WEATHER_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos

// ============================================
// ESTADO GLOBAL
// ============================================

let sensorData = {
    humidity: 60,
    temperature: 24,
    pumpStatus: false,
    lastUpdate: '--',
    isOnline: false,
    isSimulated: true,
};

let weatherState = {
    temperature: null,
    humidity: null,
    locationLabel: 'não configurada',
    updatedAt: null,
};

let settings = loadSettings();
let historyLog = loadHistory();
let humidityHistory = [];
let temperatureHistory = [];
let pumpActionInFlight = false;

// ============================================
// PERSISTÊNCIA (localStorage)
// ============================================

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.settings);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                esp32Url: parsed.esp32Url || '',
                city: parsed.city || '',
            };
        }
    } catch (err) {
        console.warn('Não foi possível ler configurações salvas:', err);
    }
    return { esp32Url: '', city: '' };
}

function saveSettings(newSettings) {
    settings = newSettings;
    try {
        localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch (err) {
        console.warn('Não foi possível salvar configurações:', err);
    }
}

function loadHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.history);
        if (raw) {
            return JSON.parse(raw);
        }
    } catch (err) {
        console.warn('Não foi possível ler histórico salvo:', err);
    }
    return [];
}

function saveHistory() {
    try {
        localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(historyLog.slice(0, MAX_HISTORY_ITEMS)));
    } catch (err) {
        console.warn('Não foi possível salvar histórico:', err);
    }
}

function addHistoryEvent(action, source) {
    historyLog.unshift({
        action,
        source,
        timestamp: getCurrentTime(),
    });
    historyLog = historyLog.slice(0, MAX_HISTORY_ITEMS);
    saveHistory();
    renderHistory();
}

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================

function getCurrentTime() {
    return new Date().toLocaleTimeString('pt-BR');
}

function getHumidityStatus(humidity) {
    if (humidity < 40) {
        return { label: 'Seco', className: 'seco' };
    } else if (humidity < 60) {
        return { label: 'Moderado', className: 'moderado' };
    } else {
        return { label: 'Úmido', className: 'umido' };
    }
}

function buildBaseUrl() {
    const url = settings.esp32Url.trim();
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url.replace(/\/$/, '');
    }
    return `http://${url}`.replace(/\/$/, '');
}

// ============================================
// COMUNICAÇÃO COM O ESP32 (dados reais do sensor)
// ============================================

/**
 * Busca os dados reais do sensor no ESP32. Espera um endpoint
 * GET {baseUrl}/status retornando JSON no formato:
 * { "humidity": number, "temperature": number, "pump": boolean }
 * Se não houver ESP32 configurado ou a requisição falhar, cai em modo
 * de simulação local.
 */
async function fetchSensorData() {
    const baseUrl = buildBaseUrl();

    if (!baseUrl) {
        simulateSensorReading();
        sensorData.isOnline = false;
        sensorData.isSimulated = true;
        updateConnectionUI();
        updateAllCards();
        return;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`${baseUrl}/status`, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        sensorData.humidity = Number(data.humidity);
        sensorData.temperature = Number(data.temperature);
        sensorData.pumpStatus = Boolean(data.pump);
        sensorData.lastUpdate = getCurrentTime();
        sensorData.isOnline = true;
        sensorData.isSimulated = false;

        pushHistoryPoint(humidityHistory, sensorData.humidity);
        pushHistoryPoint(temperatureHistory, sensorData.temperature);
    } catch (err) {
        console.warn('Falha ao consultar ESP32, usando simulação:', err);
        simulateSensorReading();
        sensorData.isOnline = false;
        sensorData.isSimulated = true;
    }

    updateConnectionUI();
    updateAllCards();
}

/**
 * Liga/desliga a bomba de fato. Se houver ESP32 configurado, envia
 * POST {baseUrl}/pump?state=on|off. Caso contrário, alterna o estado
 * localmente (modo simulação), deixando claro na interface.
 */
async function setPumpState(turnOn, source) {
    if (pumpActionInFlight) return;
    pumpActionInFlight = true;

    const controlBtn = document.getElementById('controlBtn');
    if (controlBtn) controlBtn.disabled = true;

    const baseUrl = buildBaseUrl();

    try {
        if (baseUrl) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const response = await fetch(`${baseUrl}/pump?state=${turnOn ? 'on' : 'off'}`, {
                method: 'POST',
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            sensorData.isOnline = true;
        } else {
            // modo simulação: sem hardware real conectado
            sensorData.isOnline = false;
        }

        sensorData.pumpStatus = turnOn;
        sensorData.lastUpdate = getCurrentTime();
        addHistoryEvent(turnOn ? 'on' : 'off', source);
    } catch (err) {
        console.error('Falha ao acionar a bomba:', err);
        showControlError('Não foi possível falar com o ESP32. Verifique a conexão.');
    } finally {
        pumpActionInFlight = false;
        if (controlBtn) controlBtn.disabled = false;
        updateConnectionUI();
        updateAllCards();
    }
}

function showControlError(message) {
    const controlText = document.getElementById('controlText');
    if (controlText) {
        controlText.textContent = message;
        controlText.style.color = 'var(--color-red)';
        setTimeout(() => {
            controlText.style.color = '';
            updateControlButton();
        }, 3500);
    }
}

async function testConnection() {
    const statusEl = document.getElementById('settingsStatus');
    const baseUrl = buildBaseUrl();

    if (!statusEl) return;

    if (!baseUrl) {
        statusEl.textContent = 'Nenhum endereço informado — o painel funcionará em modo de simulação.';
        statusEl.className = 'settings-status';
        return;
    }

    statusEl.textContent = 'Testando conexão...';
    statusEl.className = 'settings-status';

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const response = await fetch(`${baseUrl}/status`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        statusEl.textContent = 'Conectado com sucesso ao ESP32!';
        statusEl.className = 'settings-status success';
    } catch (err) {
        statusEl.textContent = 'Não foi possível conectar. Verifique o IP e a rede Wi-Fi.';
        statusEl.className = 'settings-status error';
    }
}

// ============================================
// SIMULAÇÃO (usada quando não há ESP32 configurado)
// ============================================

function simulateSensorReading() {
    sensorData.humidity = Math.max(30, Math.min(100, sensorData.humidity + (Math.random() - 0.5) * 10));
    sensorData.temperature = Math.max(15, Math.min(35, sensorData.temperature + (Math.random() - 0.5) * 3));
    sensorData.lastUpdate = getCurrentTime();

    pushHistoryPoint(humidityHistory, sensorData.humidity);
    pushHistoryPoint(temperatureHistory, sensorData.temperature);

    // Irrigação automática simulada: liga quando o solo está seco
    const autoToggle = document.getElementById('autoModeToggle');
    if (autoToggle && autoToggle.checked && !pumpActionInFlight) {
        if (sensorData.humidity < 38 && !sensorData.pumpStatus) {
            void setPumpState(true, 'automatico');
        } else if (sensorData.humidity > 65 && sensorData.pumpStatus) {
            void setPumpState(false, 'automatico');
        }
    }
}

function pushHistoryPoint(arr, value) {
    arr.push({ time: getCurrentTime().slice(0, 5), value });
    if (arr.length > 24) arr.shift();
}

// ============================================
// CLIMA EXTERNO REAL (Open-Meteo, sem chave de API)
// ============================================

async function geocodeCity(city) {
    try {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        const result = data && data.results && data.results[0];
        if (!result) return null;
        return {
            lat: result.latitude,
            lon: result.longitude,
            label: `${result.name}${result.admin1 ? ', ' + result.admin1 : ''}`,
        };
    } catch (err) {
        console.warn('Falha ao geocodificar cidade:', err);
        return null;
    }
}

function getBrowserLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve(null);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 5000 }
        );
    });
}

async function fetchWeather() {
    let coords = null;
    let label = settings.city.trim() || 'localização atual';

    if (settings.city.trim()) {
        const geo = await geocodeCity(settings.city.trim());
        if (geo) {
            coords = { lat: geo.lat, lon: geo.lon };
            label = geo.label;
        }
    }

    if (!coords) {
        coords = await getBrowserLocation();
        label = coords ? 'sua localização atual' : label;
    }

    if (!coords) {
        weatherState = {
            temperature: null,
            humidity: null,
            locationLabel: 'não disponível — informe uma cidade nas configurações',
            updatedAt: null,
        };
        renderWeather();
        return;
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        weatherState = {
            temperature: data && data.current ? data.current.temperature_2m : null,
            humidity: data && data.current ? data.current.relative_humidity_2m : null,
            locationLabel: label,
            updatedAt: getCurrentTime(),
        };
    } catch (err) {
        console.warn('Falha ao buscar clima real:', err);
        weatherState.locationLabel = `${label} (falha ao atualizar)`;
    }

    renderWeather();
}

function renderWeather() {
    const tempEl = document.getElementById('weatherTempValue');
    const humidityEl = document.getElementById('weatherHumidity');
    const locationEl = document.getElementById('weatherLocation');
    const updatedEl = document.getElementById('weatherUpdated');

    if (tempEl) tempEl.textContent = weatherState.temperature != null ? Math.round(weatherState.temperature).toString() : '--';
    if (humidityEl) humidityEl.textContent = `Umidade do ar: ${weatherState.humidity != null ? Math.round(weatherState.humidity) : '--'}%`;
    if (locationEl) locationEl.textContent = `Localização: ${weatherState.locationLabel}`;
    if (updatedEl) updatedEl.textContent = weatherState.updatedAt ? `Atualizado às ${weatherState.updatedAt}` : '';
}

// ============================================
// ATUALIZAÇÃO DE UI
// ============================================

function updateConnectionUI() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const infoSensor = document.getElementById('infoSensor');

    if (statusDot && statusText) {
        if (sensorData.isOnline) {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'Online (ESP32)';
        } else if (sensorData.isSimulated) {
            statusDot.className = 'status-dot checking';
            statusText.textContent = 'Modo simulação';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Offline';
        }
    }

    if (infoSensor) {
        infoSensor.textContent = sensorData.isOnline
            ? 'Sensor conectado ao ESP32 e funcionando normalmente'
            : 'Sem conexão com o ESP32 — exibindo dados simulados. Configure o IP em Configurações.';
    }
}

function updateHumidityCard() {
    const humidityValue = document.getElementById('humidityValue');
    const humidityStatus = document.getElementById('humidityStatus');
    const humidityBar = document.getElementById('humidityBar');
    const infoHumidity = document.getElementById('infoHumidity');

    const status = getHumidityStatus(sensorData.humidity);

    humidityValue.textContent = Math.round(sensorData.humidity).toString();
    humidityStatus.textContent = status.label;
    humidityStatus.className = `status-badge ${status.className}`;
    humidityBar.style.width = `${sensorData.humidity}%`;

    if (infoHumidity) {
        const inRange = sensorData.humidity >= 40 && sensorData.humidity <= 80;
        infoHumidity.textContent = inRange
            ? `Umidade dentro dos limites recomendados (40-80%) — atual: ${Math.round(sensorData.humidity)}%`
            : `Atenção: umidade fora da faixa recomendada — atual: ${Math.round(sensorData.humidity)}%`;
    }
}

function updateTemperatureCard() {
    const temperatureValue = document.getElementById('temperatureValue');
    const temperatureBar = document.getElementById('temperatureBar');

    const tempPercentage = Math.min(100, (sensorData.temperature / 35) * 100);

    temperatureValue.textContent = Math.round(sensorData.temperature).toString();
    temperatureBar.style.width = `${tempPercentage}%`;
}

function updatePumpCard() {
    const pumpState = document.getElementById('pumpState');
    const pumpTime = document.getElementById('pumpTime');
    const pumpIndicator = document.getElementById('pumpIndicator');

    pumpState.textContent = sensorData.pumpStatus ? 'LIGADA' : 'DESLIGADA';
    pumpState.className = `pump-state ${sensorData.pumpStatus ? 'active' : ''}`;
    pumpTime.textContent = `Última atualização: ${sensorData.lastUpdate}`;

    pumpIndicator.classList.toggle('active', sensorData.pumpStatus);
}

function updateControlButton() {
    const controlBtn = document.getElementById('controlBtn');
    const controlText = document.getElementById('controlText');

    controlBtn.textContent = sensorData.pumpStatus ? 'Desligar Bomba' : 'Ligar Bomba';
    controlBtn.className = `btn-control ${sensorData.pumpStatus ? 'active' : ''}`;
    controlText.textContent = sensorData.isSimulated
        ? (sensorData.pumpStatus ? 'Irrigação em andamento (simulado)' : 'Clique para iniciar irrigação (simulado)')
        : (sensorData.pumpStatus ? 'Irrigação em andamento' : 'Clique para iniciar irrigação');
}

function updateNextIrrigationInfo() {
    const infoNext = document.getElementById('infoNext');
    const autoToggle = document.getElementById('autoModeToggle');
    if (!infoNext) return;

    if (!autoToggle || !autoToggle.checked) {
        infoNext.textContent = 'Irrigação automática desativada — controle manual.';
        return;
    }
    if (sensorData.pumpStatus) {
        infoNext.textContent = 'Irrigação em andamento agora.';
    } else if (sensorData.humidity < 40) {
        infoNext.textContent = 'Solo seco: irrigação automática deve iniciar em breve.';
    } else {
        infoNext.textContent = 'Próxima irrigação automática ocorrerá quando a umidade cair abaixo de 40%.';
    }
}

function updateAllCards() {
    updateHumidityCard();
    updateTemperatureCard();
    updatePumpCard();
    updateControlButton();
    updateNextIrrigationInfo();
}

function renderHistory() {
    const list = document.getElementById('historyList');
    if (!list) return;

    if (historyLog.length === 0) {
        list.innerHTML = '<li class="history-empty">Nenhum acionamento registrado ainda.</li>';
        return;
    }

    list.innerHTML = historyLog
        .map((event) => {
            const label = event.action === 'on' ? 'Bomba ligada' : 'Bomba desligada';
            const sourceLabel = event.source === 'manual' ? 'manual' : 'automático';
            const cls = event.action === 'on' ? 'event-on' : 'event-off';
            return `<li class="${cls}"><span>${label} (${sourceLabel})</span><span class="history-time">${event.timestamp}</span></li>`;
        })
        .join('');
}

// ============================================
// GRÁFICOS
// ============================================

function drawAreaChart(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth;
    canvas.height = 300;

    const width = canvas.width;
    const height = canvas.height;
    const padding = 40;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;

    if (data.length < 2) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Aguardando leituras suficientes para o gráfico...', width / 2, height / 2);
        return;
    }

    const values = data.map((d) => d.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue || 1;

    const fillColor = color === '#10b981' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(249, 115, 22, 0.1)';

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, height - padding);
    ctx.stroke();

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(padding, height - padding);

    data.forEach((point, index) => {
        const x = padding + (graphWidth / (data.length - 1)) * index;
        const normalizedValue = (point.value - minValue) / range;
        const y = height - padding - normalizedValue * graphHeight;
        ctx.lineTo(x, y);
    });

    ctx.lineTo(width - padding, height - padding);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    data.forEach((point, index) => {
        const x = padding + (graphWidth / (data.length - 1)) * index;
        const normalizedValue = (point.value - minValue) / range;
        const y = height - padding - normalizedValue * graphHeight;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.fillStyle = '#6b7280';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(data.length / 6));
    data.forEach((point, index) => {
        if (index % labelStep !== 0 && index !== data.length - 1) return;
        const x = padding + (graphWidth / (data.length - 1)) * index;
        ctx.fillText(point.time, x, height - padding + 20);
    });

    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const value = minValue + (range / 4) * i;
        const y = height - padding - (graphHeight / 4) * i;
        ctx.fillText(Math.round(value).toString(), padding - 10, y + 4);
    }
}

function updateCharts() {
    drawAreaChart('humidityCanvas', humidityHistory, '#10b981');
    drawAreaChart('temperatureCanvas', temperatureHistory, '#f97316');
}

// ============================================
// PAINEL DE CONFIGURAÇÕES
// ============================================

function openSettingsPanel() {
    const panel = document.getElementById('settingsPanel');
    const esp32Input = document.getElementById('esp32Url');
    const cityInput = document.getElementById('cityInput');

    esp32Input.value = settings.esp32Url;
    cityInput.value = settings.city;
    panel.classList.toggle('open');
}

function handleSaveSettings() {
    const esp32Input = document.getElementById('esp32Url');
    const cityInput = document.getElementById('cityInput');
    const statusEl = document.getElementById('settingsStatus');

    saveSettings({
        esp32Url: esp32Input.value.trim(),
        city: cityInput.value.trim(),
    });

    statusEl.textContent = 'Configurações salvas!';
    statusEl.className = 'settings-status success';

    void fetchSensorData();
    void fetchWeather();
}

// ============================================
// EVENT LISTENERS
// ============================================

function initializeEventListeners() {
    const controlBtn = document.getElementById('controlBtn');
    if (controlBtn) {
        controlBtn.addEventListener('click', () => {
            void setPumpState(!sensorData.pumpStatus, 'manual');
        });
    }

    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach((btn) => {
        btn.addEventListener('click', handleTabClick);
    });

    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsPanel);

    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', handleSaveSettings);

    const testConnBtn = document.getElementById('testConnBtn');
    if (testConnBtn) {
        testConnBtn.addEventListener('click', () => {
            const esp32Input = document.getElementById('esp32Url');
            settings.esp32Url = esp32Input.value.trim();
            void testConnection();
        });
    }

    const autoToggle = document.getElementById('autoModeToggle');
    if (autoToggle) autoToggle.addEventListener('change', updateNextIrrigationInfo);

    window.addEventListener('resize', updateCharts);
}

function handleTabClick(event) {
    const target = event.target;
    const tabName = target.getAttribute('data-tab');

    const allTabs = document.querySelectorAll('.tab-btn');
    allTabs.forEach((tab) => tab.classList.remove('active'));

    const allContainers = document.querySelectorAll('.chart-container');
    allContainers.forEach((container) => container.classList.remove('active'));

    target.classList.add('active');
    if (tabName) {
        const container = document.getElementById(tabName);
        if (container) {
            container.classList.add('active');
            if (tabName !== 'history-panel') {
                updateCharts();
            }
        }
    }
}

// ============================================
// INICIALIZAÇÃO
// ============================================

function initialize() {
    console.log('Inicializando Sistema de Irrigação...');

    renderHistory();
    renderWeather();
    void fetchSensorData();
    void fetchWeather();

    initializeEventListeners();

    setInterval(() => {
        void fetchSensorData();
    }, SENSOR_POLL_INTERVAL_MS);

    setInterval(() => {
        void fetchWeather();
    }, WEATHER_POLL_INTERVAL_MS);

    console.log('Sistema de Irrigação inicializado com sucesso!');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}
