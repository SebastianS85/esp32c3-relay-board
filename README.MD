# ESP32-C3 I/O Relay Development Board ⚡

A professional, modular, production-grade I/O and relay controller board powered by **ESP32-C3** and **ESP-IDF**. It features dual Wi-Fi (STA/AP fallback), real-time WebSocket communication, a local SPIFFS web application, a physical OLED status display, a CAN bus (TWAI) communication layer, and robust I2C peripheral management (MCP23017 for 8-channel relays/inputs and INA3221 for multi-channel voltage/sensor monitoring).

---

## 📸 Gallery

| Physical Relay Board & OLED Display | Web Application Control UI |
| :---: | :---: |
| *[Insert screenshot of hardware / OLED setup here]* | *[Insert screenshot of WebApp UI here]* |

---

## 🔌 Pinout & Wiring Connections

| Interface / Peripheral | ESP32-C3 Pin | Description |
| :--- | :--- | :--- |
| **I2C Bus (SCL)** | `GPIO 4` | I2C Clock (shared by MCP23017, INA3221, OLED) |
| **I2C Bus (SDA)** | `GPIO 5` | I2C Data (shared by MCP23017, INA3221, OLED) |
| **MCP23017 Interrupt** | `GPIO 3` | Hardware input change interrupt (active-low with pull-up) |
| **CAN Bus (TWAI TX)** | `GPIO 7` | Transmit data line to CAN transceiver |
| **CAN Bus (TWAI RX)** | `GPIO 6` | Receive data line from CAN transceiver |
| **Power Supply / Rails** | `+3.3V / GND` | Logic power supply from onboard regulator |

---

## 🛠️ Hardware Architecture

* **Microcontroller:** ESP32-C3 (RISC-V single-core).
* **I2C Peripherals (400kHz):**
  * **MCP23017:** 16-bit I/O expander handling 8 relay outputs and 8 digital inputs with hardware interrupt routing on **GPIO3** (including software debouncing).
  * **INA3221:** Triple-channel high-side current/voltage monitor for power rail and sensor monitoring.
  * **OLED Display (128x64 / SSD1306):** Real-time system status rendering using a custom 5x7 font engine.
* **CAN Bus (TWAI):** 500kbps interface with automated heartbeat broadcasting, frame error counters, and bus-off auto-recovery.
* **Network & Storage:** Dual STA/AP mode with automatic fallback to an AP access point and SPIFFS flash storage serving the responsive frontend web application.

---

## 📂 Project Structure

```text
camper_relay_tst/
├── CMakeLists.txt             # Root build configuration
├── partitions.csv             # Custom partition table (SPIFFS storage)
├── secrets_tmp.h              # Credentials template (copy to secrets.h)
├── webapp/                    # Frontend assets (HTML, CSS, JS)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── main/                      # Entry point & startup sequence
│   ├── CMakeLists.txt
│   └── main.c
└── components/                # Modular ESP-IDF components
    ├── can_bus/               # TWAI driver, filters, and state handlers
    ├── peripherals/           # I2C bus, INA3221 polling, MCP23017 ISR, OLED rendering
    └── wifi_webserver/        # Wi-Fi STA/AP manager, SPIFFS file server, WebSocket (/ws)
```

---

## 🚀 Getting Started

### 1. Prerequisites
* **ESP-IDF v6.0+** installed and configured in your environment.
* Python virtual environment (`idf.py` dependencies).

### 2. Clone and Configure
Clone the repository and set up your network credentials:
```bash
git clone https://github.com/your-username/esp32c3-relay-board.git
cd esp32c3-relay-board
```

Copy the credentials template to create your actual secrets file:
```bash
cp secrets_tmp.h secrets.h
```
Open `secrets.h` and fill in your Wi-Fi router SSID and password. *(Note: `secrets.h` is ignored by Git to protect your privacy).*

### 3. Build, Flash, and Monitor
Run a full clean build, flash the firmware, upload the SPIFFS web assets, and open the serial monitor:
```bash
idf.py fullclean
idf.py build flash monitor
```

---

## 🔌 CAN Bus Protocol Overview

| CAN ID | Type | Description | Payload Example |
| :---: | :---: | :--- | :--- |
| `0x100` | RX | Master command to set all relay states | `[relay_mask]` |
| `0x101` | RX | Master command to toggle/set a specific relay | `[relay_idx (1-8), state (0/1/2)]` |
| `0x110` | RX | Request status sync | `[]` |
| `0x180` | TX | Periodic/Triggered I/O status broadcast | `[relay_mask, input_state]` |
| `0x181` | TX | Periodic voltage sensor feedback | `[v1_lsb, v1_msb, v2_lsb, v2_msb, v3_lsb, v3_msb]` |
| `0x190` | TX | System Heartbeat (every 500ms) | `[counter, can_state, relay_mask, input_state]` |

---

## 🌐 Web Application Features
* **Multi-language Support:** Instant language switching (**PL / EN / DE**).
* **Circuit Synchronization:** Fully customizable channel labels matching physical relay wiring.
* **Real-time Telemetry:** Instant bi-directional updates via WebSocket (`/ws`) for sensor voltages and relay states.

---

## 📄 License
This project is open-source and available under the [MIT License](LICENSE).