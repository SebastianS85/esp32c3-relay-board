let currentRelayMask = 0;
let ws = null;

// Słownik z dokładnymi nazwami z ekranu LCD (poprawiona kolejność!)
const translations = {
    pl: {
        status_wait: "Oczekiwanie...",
        status_ok: "WEBAPP ONLINE",
        status_lost: "Brak łączności...",
        battery_voltages: "Odczyty Sensorów",
        v_batt: "Bateria",
        v_fresh: "Świeża woda",
        v_waste: "Szara woda",
        relays: "Sterowanie Obwodami",
        inputs: "Diagnostyka wejść",
        r0: "Światło Przód", // Front Light 
        r1: "Łazienka",      // Bath Light 
        r2: "Zewnętrzne",    // Outside Light 
        r3: "Nastrojowe",    // Ambient Light 
        r4: "Pompa Wody",    // Water Pump 
        r5: "Przetwornica",  // Inverter 
        r6: "Ogrzewanie",    // Heating
        r7: "Światło Główne" // Main Light
    },
    en: {
        status_wait: "Waiting...",
        status_ok: "WEBAPP ONLINE",
        status_lost: "Connection lost...",
        battery_voltages: "Sensor Readings",
        v_batt: "Battery",
        v_fresh: "Fresh water",
        v_waste: "Waste water",
        relays: "Circuit Control",
        inputs: "Input Diagnostics",
        r0: "Front Light",
        r1: "Bath Light",
        r2: "Outside Light",
        r3: "Ambient Light",
        r4: "Water Pump",
        r5: "Inverter",
        r6: "Heating",
        r7: "Main Light"
    },
    de: {
        status_wait: "Warten...",
        status_ok: "WEBAPP ONLINE",
        status_lost: "Verbindung getrennt...",
        battery_voltages: "Sensorwerte",
        v_batt: "Batterie",
        v_fresh: "Frischwasser",
        v_waste: "Abwasser",
        relays: "Schalter",
        inputs: "Eingangsdiagnose",
        r0: "Frontlicht",
        r1: "Badlicht",
        r2: "Außenlicht",
        r3: "Ambiente",
        r4: "Wasserpumpe",
        r5: "Wechselrichter",
        r6: "Heizung",
        r7: "Hauptlicht"
    }
};

let currentLang = localStorage.getItem('camper_lang');
if (!translations[currentLang]) currentLang = 'en'; // domyślnie angielski (jak na wyświetlaczu)

document.addEventListener('DOMContentLoaded', () => {
    const selector = document.getElementById('lang-selector');
    if (selector) selector.value = currentLang;

    const relaysContainer = document.getElementById('relays-container');
    const inputsContainer = document.getElementById('inputs-container');

    // Generowanie 8 przycisków
    for (let i = 0; i < 8; i++) {
        const btn = document.createElement('button');
        btn.className = 'relay-btn';
        btn.id = `relay-${i}`;
        btn.onclick = () => toggleRelay(i);
        relaysContainer.appendChild(btn);
    }

    // Generowanie 8 wskaźników wejść
    for (let i = 0; i < 8; i++) {
        const ind = document.createElement('div');
        ind.className = 'input-indicator';
        ind.id = `input-${i}`;
        ind.innerText = `IN ${i + 1}`;
        inputsContainer.appendChild(ind);
    }

    applyLanguage(); 
    connectWebSocket();
});

window.changeLanguage = function(lang) {
    if (!translations[lang]) return;
    currentLang = lang;
    localStorage.setItem('camper_lang', lang);
    applyLanguage();
    
    const statusEl = document.getElementById('status-text');
    if (ws && ws.readyState === WebSocket.OPEN) statusEl.innerText = translations[currentLang].status_ok;
    else statusEl.innerText = translations[currentLang].status_lost;
};

function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[currentLang][key]) el.innerText = translations[currentLang][key];
    });

    for (let i = 0; i < 8; i++) {
        const btn = document.getElementById(`relay-${i}`);
        if(btn) btn.innerText = translations[currentLang][`r${i}`];
    }
}

// Funkcja pomocnicza do pasków postępu (zakładamy max 15V = 100%)
function updateBar(id, mv_value) {
    const max_mv = 15000;
    let percentage = (mv_value / max_mv) * 100;
    if(percentage > 100) percentage = 100;
    document.getElementById(id).style.width = `${percentage}%`;
}

function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}/ws`);

    ws.onopen = () => {
        document.getElementById('status-text').innerText = translations[currentLang].status_ok;
        document.getElementById('status-badge').className = "status-badge connected";
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            currentRelayMask = data.relays;

            document.getElementById('v1').innerText = (data.v1 / 1000).toFixed(2) + ' V';
            document.getElementById('v2').innerText = (data.v2 / 1000).toFixed(2) + ' V';
            document.getElementById('v3').innerText = (data.v3 / 1000).toFixed(2) + ' V';

            updateBar('bar-v1', data.v1);
            updateBar('bar-v2', data.v2);
            updateBar('bar-v3', data.v3);

            for (let i = 0; i < 8; i++) {
                const btn = document.getElementById(`relay-${i}`);
                if (btn) (data.relays & (1 << i)) ? btn.classList.add('active') : btn.classList.remove('active');
            }

            for (let i = 0; i < 8; i++) {
                const ind = document.getElementById(`input-${i}`);
                if (ind) (data.inputs & (1 << i)) ? ind.classList.add('active') : ind.classList.remove('active');
            }
        } catch (error) { console.error("WS Parse Error", error); }
    };

    ws.onclose = () => {
        document.getElementById('status-text').innerText = translations[currentLang].status_lost;
        document.getElementById('status-badge').className = "status-badge disconnected";
        setTimeout(connectWebSocket, 2000);
    };
    ws.onerror = () => ws.close();
}

function toggleRelay(bitIndex) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send((currentRelayMask ^ (1 << bitIndex)).toString());
    }
}