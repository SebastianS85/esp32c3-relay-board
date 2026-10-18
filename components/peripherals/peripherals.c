#include "peripherals.h"
#include "can_bus.h"
#include "wifi_webserver.h"
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "driver/gpio.h"

static const char *TAG = "peripherals";

#define I2C_SCL_GPIO         GPIO_NUM_4
#define I2C_SDA_GPIO         GPIO_NUM_5
#define I2C_SPEED_HZ         400000

#define INA3221_ADDR_MIN     0x40
#define INA3221_ADDR_MAX     0x43
#define INA3221_REG_CONFIG   0x00
#define INA3221_REG_BUS_CH1  0x02
#define INA3221_REG_MANUF_ID 0xFE
#define INA3221_REG_DIE_ID   0xFF
#define INA3221_MANUF_ID     0x5449
#define INA3221_DIE_ID       0x3220
#define INA3221_CONFIG_VALUE 0x7127
#define INA3221_CHANNELS     3
#define INA3221_POLL_MS      500

#define MCP23017_REG_IODIRA  0x00
#define MCP23017_REG_IODIRB  0x01
#define MCP23017_REG_GPINTENB 0x05
#define MCP23017_REG_INTCONB 0x09
#define MCP23017_REG_IOCON   0x0A
#define MCP23017_REG_GPPUB   0x0D
#define MCP23017_REG_GPIOB   0x13
#define MCP23017_REG_OLATA   0x14
#define MCP23017_IOCON_VALUE 0x44
#define MCP23017_INT_GPIO    GPIO_NUM_3

#define OLED_WIDTH           128
#define OLED_PAGES           8

#define CAN_ID_SET_RELAYS      0x100
#define CAN_ID_SET_RELAY       0x101
#define CAN_ID_REQUEST_STATUS  0x110
#define CAN_ID_STATUS_IO       0x180
#define CAN_ID_STATUS_VOLTAGE  0x181
#define CAN_ID_HEARTBEAT       0x190
#define CAN_HEARTBEAT_MS       500
#define RELAY_COUNT            8

static i2c_master_dev_handle_t mcp_device = NULL;
static i2c_master_dev_handle_t ina_device = NULL;
static i2c_master_dev_handle_t oled_device = NULL;
static twai_node_handle_t local_can_node = NULL;

static uint8_t current_relay_mask = 0;
static uint8_t current_input_state = 0;
static uint16_t cached_voltages[3] = {0, 0, 0};
static QueueHandle_t peripheral_event_queue = NULL;
static uint8_t oled_buffer[1 + OLED_WIDTH * OLED_PAGES];
static volatile twai_error_state_t global_can_state = TWAI_ERROR_ACTIVE;

/* Czcionka 5x7 */
static const uint8_t font5x7[][5] = {
    {0x00, 0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x5F, 0x00, 0x00}, {0x00, 0x07, 0x00, 0x07, 0x00}, {0x14, 0x7F, 0x14, 0x7F, 0x14},
    {0x24, 0x2A, 0x7F, 0x2A, 0x12}, {0x23, 0x13, 0x08, 0x64, 0x62}, {0x36, 0x49, 0x56, 0x20, 0x50}, {0x00, 0x08, 0x07, 0x03, 0x00},
    {0x00, 0x1C, 0x22, 0x41, 0x00}, {0x00, 0x41, 0x22, 0x1C, 0x00}, {0x2A, 0x1C, 0x7F, 0x1C, 0x2A}, {0x08, 0x08, 0x3E, 0x08, 0x08},
    {0x00, 0x80, 0x70, 0x30, 0x00}, {0x08, 0x08, 0x08, 0x08, 0x08}, {0x00, 0x00, 0x60, 0x60, 0x00}, {0x20, 0x10, 0x08, 0x04, 0x02},
    {0x3E, 0x51, 0x49, 0x45, 0x3E}, {0x00, 0x42, 0x7F, 0x40, 0x00}, {0x72, 0x49, 0x49, 0x49, 0x46}, {0x21, 0x41, 0x49, 0x4D, 0x33},
    {0x18, 0x14, 0x12, 0x7F, 0x10}, {0x27, 0x45, 0x45, 0x45, 0x39}, {0x3C, 0x4A, 0x49, 0x49, 0x31}, {0x41, 0x21, 0x11, 0x09, 0x07},
    {0x36, 0x49, 0x49, 0x49, 0x36}, {0x46, 0x49, 0x49, 0x29, 0x1E}, {0x00, 0x00, 0x14, 0x00, 0x00}, {0x00, 0x40, 0x34, 0x00, 0x00},
    {0x00, 0x08, 0x14, 0x22, 0x41}, {0x14, 0x14, 0x14, 0x14, 0x14}, {0x00, 0x41, 0x22, 0x14, 0x08}, {0x02, 0x01, 0x59, 0x09, 0x06},
    {0x3E, 0x41, 0x5D, 0x59, 0x4E}, {0x7C, 0x12, 0x11, 0x12, 0x7C}, {0x7F, 0x49, 0x49, 0x49, 0x36}, {0x3E, 0x41, 0x41, 0x41, 0x22},
    {0x7F, 0x41, 0x41, 0x41, 0x3E}, {0x7F, 0x49, 0x49, 0x49, 0x41}, {0x7F, 0x09, 0x09, 0x09, 0x01}, {0x3E, 0x41, 0x41, 0x51, 0x73},
    {0x7F, 0x08, 0x08, 0x08, 0x7F}, {0x00, 0x41, 0x7F, 0x41, 0x00}, {0x20, 0x40, 0x41, 0x3F, 0x01}, {0x7F, 0x08, 0x14, 0x22, 0x41},
    {0x7F, 0x40, 0x40, 0x40, 0x40}, {0x7F, 0x02, 0x1C, 0x02, 0x7F}, {0x7F, 0x04, 0x08, 0x10, 0x7F}, {0x3E, 0x41, 0x41, 0x41, 0x3E},
    {0x7F, 0x09, 0x09, 0x09, 0x06}, {0x3E, 0x41, 0x51, 0x21, 0x5E}, {0x7F, 0x09, 0x19, 0x29, 0x46}, {0x26, 0x49, 0x49, 0x49, 0x32},
    {0x03, 0x01, 0x7F, 0x01, 0x03}, {0x3F, 0x40, 0x40, 0x40, 0x3F}, {0x1F, 0x20, 0x40, 0x20, 0x1F}, {0x3F, 0x40, 0x38, 0x40, 0x3F},
    {0x63, 0x14, 0x08, 0x14, 0x63}, {0x03, 0x04, 0x78, 0x04, 0x03}, {0x61, 0x59, 0x49, 0x4D, 0x43},
};

static void IRAM_ATTR mcp_isr_handler(void *arg) {
    if (!peripheral_event_queue) return;
    typedef struct { int type; uint32_t id; uint8_t len; uint8_t data[8]; } app_evt_t;
    app_evt_t event = { .type = 1 }; // EVENT_MCP_INT = 1
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(peripheral_event_queue, &event, &woken);
    if (woken == pdTRUE) portYIELD_FROM_ISR();
}

static esp_err_t read_register16(i2c_master_dev_handle_t device, uint8_t reg, uint16_t *value) {
    uint8_t data[2];
    esp_err_t err = i2c_master_transmit_receive(device, &reg, 1, data, sizeof(data), 100);
    if (err == ESP_OK) *value = ((uint16_t)data[0] << 8) | data[1];
    return err;
}

static void voltage_polling_task(void *arg) {
    for (;;) {
        if (ina_device) {
            for (uint8_t channel = 0; channel < INA3221_CHANNELS; ++channel) {
                uint16_t raw;
                if (read_register16(ina_device, INA3221_REG_BUS_CH1 + channel * 2, &raw) == ESP_OK) {
                    cached_voltages[channel] = (uint16_t)((raw >> 3) * 8);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(INA3221_POLL_MS));
    }
}

static void oled_line(uint8_t line, const char *format, ...) {
    char text[24]; va_list args; va_start(args, format); vsnprintf(text, sizeof(text), format, args); va_end(args);
    uint8_t *page = &oled_buffer[1 + line * OLED_WIDTH];
    memset(page, 0, OLED_WIDTH);
    size_t x = 0;
    for (const char *p = text; *p != '\0' && x + 5 <= OLED_WIDTH; ++p) {
        int c = toupper((unsigned char)*p); if (c < 0x20 || c > 0x5A) c = '?';
        memcpy(&page[x], font5x7[c - 0x20], 5); x += 6;
    }
}

static void bits_to_text(char *out, uint8_t value) {
    for (uint8_t bit = 0; bit < 8; ++bit) out[bit] = (value & (1U << bit)) ? '1' : '0';
    out[8] = '\0';
}

static void oled_task(void *arg) {
    for (;;) {
        if (oled_device) {
            char relays[9]; char inputs[9];
            bits_to_text(relays, current_relay_mask); 
            bits_to_text(inputs, current_input_state);
            
            oled_line(0, "%s %s", get_is_ap_mode() ? "AP" : "STA", get_display_ip());
            
            if (local_can_node) { 
                oled_line(1, "CAN %lu %lu E%lu", (unsigned long)get_can_rx_count(), (unsigned long)get_can_tx_ok_count(), (unsigned long)get_can_error_count()); 
            } else { 
                oled_line(1, "CAN INIT FAILED"); 
            }
            
            oled_line(3, mcp_device ? "RLY %s" : "RLY N/A", relays);
            oled_line(4, mcp_device ? "IN  %s" : "IN  N/A", inputs);
            
            for (uint8_t ch = 0; ch < INA3221_CHANNELS; ++ch) {
                if (ina_device) { 
                    unsigned int mv = cached_voltages[ch]; 
                    oled_line(5 + ch, "CH%u %u.%03uV", ch + 1U, mv / 1000, mv % 1000); 
                } else { 
                    oled_line(5 + ch, "CH%u N/A", ch + 1U); 
                }
            }

            const uint8_t window[] = { 0x21, 0, OLED_WIDTH - 1, 0x22, 0, OLED_PAGES - 1 };
            uint8_t cmd_data[32]; cmd_data[0] = 0x00; memcpy(&cmd_data[1], window, sizeof(window));
            i2c_master_transmit(oled_device, cmd_data, sizeof(window) + 1, 100);
            i2c_master_transmit(oled_device, oled_buffer, sizeof(oled_buffer), 200);
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

static void send_io_status(void) {
    uint8_t r_mask = get_relay_mask();
    uint8_t i_state = get_input_state();
    const uint8_t data[2] = { r_mask, i_state };
    if (local_can_node) can_send(local_can_node, CAN_ID_STATUS_IO, data, sizeof(data));
}

static void send_voltage_status(void) {
    uint16_t mv[3];
    get_voltages(mv);
    uint8_t data[6];
    for (uint8_t channel = 0; channel < 3; ++channel) {
        data[channel * 2] = (uint8_t)(mv[channel] & 0xFF);
        data[channel * 2 + 1] = (uint8_t)(mv[channel] >> 8);
    }
    if (local_can_node) can_send(local_can_node, CAN_ID_STATUS_VOLTAGE, data, sizeof(data));
}

static void handle_can_frame(const void *event_ptr) {
    const struct { int type; uint32_t id; uint8_t len; uint8_t data[8]; } *event = event_ptr;
    switch (event->id) {
    case CAN_ID_SET_RELAYS:
        if (event->len >= 1) { 
            set_relays_hw(event->data[0]); 
            send_io_status(); 
        }
        break;
    case CAN_ID_SET_RELAY:
        if (event->len >= 2 && event->data[0] >= 1 && event->data[0] <= RELAY_COUNT && event->data[1] <= 2) {
            uint8_t bit = (uint8_t)(1U << (event->data[0] - 1));
            uint8_t mask = get_relay_mask();
            if (event->data[1] == 0) mask &= (uint8_t)~bit;
            else if (event->data[1] == 1) mask |= bit;
            else mask ^= bit;
            set_relays_hw(mask);
            send_io_status();
        }
        break;
    case CAN_ID_REQUEST_STATUS:
        send_io_status(); 
        send_voltage_status();
        break;
    }
}

static void handle_input_interrupt(void) {
    uint8_t inputs = get_input_state();
    uint8_t r_mask = get_relay_mask();

    static TickType_t last_gpb7_press_time = 0;
    const TickType_t debounce_delay = pdMS_TO_TICKS(200);
    if ((inputs & 0x80) == 0) { 
        TickType_t now = xTaskGetTickCount();
        if ((now - last_gpb7_press_time) > debounce_delay) {
            set_relays_hw(r_mask ^ 0x01);
            last_gpb7_press_time = now;
        }
    }
    send_io_status();
    uint16_t mv[3]; get_voltages(mv);
    broadcast_ws_status(get_relay_mask(), inputs, mv);
}

static void control_task(void *arg) {
    QueueHandle_t queue = (QueueHandle_t)arg;
    typedef struct { int type; uint32_t id; uint8_t len; uint8_t data[8]; } app_evt_t;
    app_evt_t event;
    const TickType_t heartbeat_period = pdMS_TO_TICKS(CAN_HEARTBEAT_MS);
    TickType_t next_heartbeat = xTaskGetTickCount() + heartbeat_period;
    uint8_t heartbeat_counter = 0;

    for (;;) {
        TickType_t now = xTaskGetTickCount();
        TickType_t wait = (next_heartbeat > now) ? next_heartbeat - now : 0;

        if (xQueueReceive(queue, &event, wait) == pdTRUE) {
            if (event.type == 1) { // EVENT_MCP_INT
                handle_input_interrupt();
            } else if (event.type == 0) { // EVENT_CAN_RX
                handle_can_frame(&event);
                uint16_t mv[3]; get_voltages(mv);
                broadcast_ws_status(get_relay_mask(), get_input_state(), mv);
            } else if (event.type == 2) { // EVENT_WIFI_RELAY_WRITE
                set_relays_hw(event.data[0]);
                send_io_status();
                uint16_t mv[3]; get_voltages(mv);
                broadcast_ws_status(get_relay_mask(), get_input_state(), mv);
            }
        }

        now = xTaskGetTickCount();
        if (now >= next_heartbeat) {
            uint8_t r_mask = get_relay_mask();
            uint8_t i_state = get_input_state();
            const uint8_t data[4] = { heartbeat_counter++, (uint8_t)global_can_state, r_mask, i_state };
            if (local_can_node) can_send(local_can_node, CAN_ID_HEARTBEAT, data, sizeof(data));
            next_heartbeat += heartbeat_period;
            if (next_heartbeat <= now) next_heartbeat = now + heartbeat_period;
        }
        
        uint16_t mv[3]; get_voltages(mv);
        broadcast_ws_status(get_relay_mask(), get_input_state(), mv);
    }
}

void init_peripherals(i2c_master_bus_handle_t *bus, i2c_master_dev_handle_t *ina, i2c_master_dev_handle_t *mcp, i2c_master_dev_handle_t *oled, QueueHandle_t queue, twai_node_handle_t can_node_ref) {
    peripheral_event_queue = queue;
    local_can_node = can_node_ref;

    i2c_master_bus_config_t bus_config = { 
        .i2c_port = I2C_NUM_0, 
        .scl_io_num = I2C_SCL_GPIO, 
        .sda_io_num = I2C_SDA_GPIO, 
        .clk_source = I2C_CLK_SRC_DEFAULT, 
        .glitch_ignore_cnt = 7, 
        .flags.enable_internal_pullup = false 
    };
    i2c_new_master_bus(&bus_config, bus);

    // INA3221 search
    for (uint8_t addr = INA3221_ADDR_MIN; addr <= INA3221_ADDR_MAX; ++addr) {
        if (i2c_master_probe(*bus, addr, 50) != ESP_OK) continue;
        i2c_device_config_t dev_cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = I2C_SPEED_HZ };
        i2c_master_bus_add_device(*bus, &dev_cfg, ina);
        uint16_t manuf, die;
        if (read_register16(*ina, INA3221_REG_MANUF_ID, &manuf) == ESP_OK && read_register16(*ina, INA3221_REG_DIE_ID, &die) == ESP_OK) {
            if (manuf == INA3221_MANUF_ID && die == INA3221_DIE_ID) {
                const uint8_t conf[] = { INA3221_REG_CONFIG, (uint8_t)(INA3221_CONFIG_VALUE >> 8), (uint8_t)INA3221_CONFIG_VALUE };
                if (i2c_master_transmit(*ina, conf, sizeof(conf), 100) == ESP_OK) { ina_device = *ina; break; }
            }
        }
        i2c_master_bus_rm_device(*ina);
        *ina = NULL;
    }

    // OLED search
    for (uint8_t addr = 0x3C; addr <= 0x3D; ++addr) {
        if (i2c_master_probe(*bus, addr, 50) == ESP_OK) {
            i2c_device_config_t dev_cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = I2C_SPEED_HZ };
            if (i2c_master_bus_add_device(*bus, &dev_cfg, oled) == ESP_OK) {
                oled_device = *oled;
                const uint8_t init_seq[] = { 0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF };
                oled_buffer[0] = 0x40;
                uint8_t data[32]; data[0] = 0x00; memcpy(&data[1], init_seq, sizeof(init_seq));
                i2c_master_transmit(oled_device, data, sizeof(init_seq) + 1, 100);
                break;
            }
        }
    }

    // MCP23017 search
    for (uint8_t addr = 0x20; addr <= 0x27; ++addr) {
        if (i2c_master_probe(*bus, addr, 50) == ESP_OK) {
            i2c_device_config_t dev_cfg = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr, .scl_speed_hz = I2C_SPEED_HZ };
            if (i2c_master_bus_add_device(*bus, &dev_cfg, mcp) == ESP_OK) {
                mcp_device = *mcp;
                uint8_t d1[] = { MCP23017_REG_IOCON, MCP23017_IOCON_VALUE }; i2c_master_transmit(mcp_device, d1, 2, 100);
                uint8_t d2[] = { MCP23017_REG_GPINTENB, 0x00 }; i2c_master_transmit(mcp_device, d2, 2, 100);
                uint8_t d3[] = { MCP23017_REG_OLATA, 0x00 }; i2c_master_transmit(mcp_device, d3, 2, 100);
                uint8_t d4[] = { MCP23017_REG_IODIRA, 0x00 }; i2c_master_transmit(mcp_device, d4, 2, 100);
                uint8_t d5[] = { MCP23017_REG_IODIRB, 0xFF }; i2c_master_transmit(mcp_device, d5, 2, 100);
                uint8_t d6[] = { MCP23017_REG_GPPUB, 0xFF }; i2c_master_transmit(mcp_device, d6, 2, 100);
                uint8_t d7[] = { MCP23017_REG_INTCONB, 0x00 }; i2c_master_transmit(mcp_device, d7, 2, 100);
                
                uint8_t reg = MCP23017_REG_GPIOB;
                i2c_master_transmit_receive(mcp_device, &reg, 1, (uint8_t*)&current_input_state, 1, 100);

                gpio_config_t pin_config = { .pin_bit_mask = 1ULL << MCP23017_INT_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_NEGEDGE };
                gpio_config(&pin_config);
                gpio_install_isr_service(0);
                gpio_isr_handler_add(MCP23017_INT_GPIO, mcp_isr_handler, NULL);

                uint8_t d8[] = { MCP23017_REG_GPINTENB, 0xFF }; i2c_master_transmit(mcp_device, d8, 2, 100);
                break;
            }
        }
    }

    // Uruchomienie zadań FreeRTOS w tle
    if (ina_device) xTaskCreate(voltage_polling_task, "ina3221", 3072, NULL, 4, NULL);
    if (oled_device) xTaskCreate(oled_task, "oled", 4096, NULL, 3, NULL);
    xTaskCreate(control_task, "control", 4096, queue, 6, NULL);

    ESP_LOGI(TAG, "Peryferia i zadania sterujące zainicjalizowane.");
}

esp_err_t set_relays_hw(uint8_t mask) {
    if (mcp_device == NULL) return ESP_ERR_INVALID_STATE;
    uint8_t data[] = { MCP23017_REG_OLATA, mask };
    esp_err_t err = i2c_master_transmit(mcp_device, data, sizeof(data), 100);
    if (err == ESP_OK) current_relay_mask = mask;
    return err;
}

uint8_t get_relay_mask(void) { return current_relay_mask; }

uint8_t get_input_state(void) {
    if (mcp_device != NULL) {
        uint8_t reg = MCP23017_REG_GPIOB;
        i2c_master_transmit_receive(mcp_device, &reg, 1, (uint8_t*)&current_input_state, 1, 100);
    }
    return current_input_state;
}

void get_voltages(uint16_t *dest) {
    dest[0] = cached_voltages[0];
    dest[1] = cached_voltages[1];
    dest[2] = cached_voltages[2];
}