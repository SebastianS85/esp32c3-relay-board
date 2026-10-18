/*
 * Camper relay controller (ESP32-C3) ze wsparciem Web Bluetooth PWA
 */
#include <ctype.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_twai.h"
#include "esp_twai_onchip.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

// --- Nagłówki NimBLE (Bluetooth) ---
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define I2C_SCL_GPIO           GPIO_NUM_4
#define I2C_SDA_GPIO           GPIO_NUM_5
#define I2C_SPEED_HZ           400000

#define INA3221_ADDR_MIN       0x40
#define INA3221_ADDR_MAX       0x43
#define INA3221_REG_CONFIG     0x00
#define INA3221_REG_BUS_CH1    0x02
#define INA3221_REG_MANUF_ID   0xFE
#define INA3221_REG_DIE_ID     0xFF
#define INA3221_MANUF_ID       0x5449
#define INA3221_DIE_ID         0x3220
#define INA3221_CONFIG_VALUE   0x7127
#define INA3221_CHANNELS       3
#define INA3221_POLL_MS        500

#define MCP23017_ADDR_MIN      0x20
#define MCP23017_ADDR_MAX      0x27
#define MCP23017_REG_IODIRA    0x00
#define MCP23017_REG_IODIRB    0x01
#define MCP23017_REG_GPINTENB  0x05
#define MCP23017_REG_INTCONB   0x09
#define MCP23017_REG_IOCON     0x0A
#define MCP23017_REG_GPPUB     0x0D
#define MCP23017_REG_GPIOB     0x13
#define MCP23017_REG_OLATA     0x14
#define MCP23017_IOCON_VALUE   0x44
#define MCP23017_INT_GPIO      GPIO_NUM_3
#define RELAY_COUNT            8

#define OLED_ADDR_MIN          0x3C
#define OLED_ADDR_MAX          0x3D
#define OLED_WIDTH             128
#define OLED_PAGES             8
#define OLED_REFRESH_MS        500

#define CAN_TX_GPIO            GPIO_NUM_7
#define CAN_RX_GPIO            GPIO_NUM_6
#define CAN_BITRATE            500000
#define CAN_ID_SET_RELAYS      0x100
#define CAN_ID_SET_RELAY       0x101
#define CAN_ID_REQUEST_STATUS  0x110
#define CAN_ID_STATUS_IO       0x180
#define CAN_ID_STATUS_VOLTAGE  0x181
#define CAN_ID_HEARTBEAT       0x190
#define CAN_HEARTBEAT_MS       500
#define CAN_TX_QUEUE_DEPTH     8
#define CAN_TX_SLOTS           16

typedef enum {
    EVENT_CAN_RX,
    EVENT_MCP_INT,
    EVENT_BLE_RELAY_WRITE // Dodane: zdarzenie nadchodzące z Bluetooth
} event_type_t;

typedef struct {
    event_type_t type;
    uint32_t id;
    uint8_t len;
    uint8_t data[8];
} app_event_t;

typedef struct {
    twai_frame_t frame;
    uint8_t data[8];
} can_tx_slot_t;

static const char *TAG = "camper";

static i2c_master_dev_handle_t ina_device;
static i2c_master_dev_handle_t mcp_device;
static i2c_master_dev_handle_t oled_device;
static twai_node_handle_t can_node;
static QueueHandle_t event_queue;

static volatile uint8_t relay_mask;
static volatile uint8_t input_state;
static volatile uint16_t ina_millivolts[INA3221_CHANNELS];
static volatile twai_error_state_t can_state = TWAI_ERROR_ACTIVE;
static volatile uint32_t can_rx_count;
static volatile uint32_t can_tx_ok_count;
static volatile uint32_t can_error_count;

static can_tx_slot_t can_tx_slots[CAN_TX_SLOTS];
static uint8_t can_tx_next_slot;
static uint8_t oled_buffer[1 + OLED_WIDTH * OLED_PAGES];

/* ------------------------------------------------------------------ BLE Variables */
static uint16_t ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t relay_char_handle;
static uint16_t input_char_handle;
static uint16_t volt_char_handle;

// UUID w formacie Little Endian dla NimBLE
static const ble_uuid128_t svc_uuid = BLE_UUID128_INIT(0x14, 0x12, 0x8a, 0x76, 0x04, 0xd1, 0x6c, 0x4f, 0x7e, 0x53, 0xf2, 0xe8, 0x00, 0x00, 0xb1, 0x19);
static const ble_uuid128_t relay_uuid = BLE_UUID128_INIT(0x14, 0x12, 0x8a, 0x76, 0x04, 0xd1, 0x6c, 0x4f, 0x7e, 0x53, 0xf2, 0xe8, 0x01, 0x00, 0xb1, 0x19);
static const ble_uuid128_t input_uuid = BLE_UUID128_INIT(0x14, 0x12, 0x8a, 0x76, 0x04, 0xd1, 0x6c, 0x4f, 0x7e, 0x53, 0xf2, 0xe8, 0x02, 0x00, 0xb1, 0x19);
static const ble_uuid128_t volt_uuid = BLE_UUID128_INIT(0x14, 0x12, 0x8a, 0x76, 0x04, 0xd1, 0x6c, 0x4f, 0x7e, 0x53, 0xf2, 0xe8, 0x03, 0x00, 0xb1, 0x19);

/* Czcionka 5x7 (oryginalna) */
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

/* ------------------------------------------------------------------ BLE Logic */
static void ble_notify_relays(void) {
    if (ble_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat((uint8_t*)&relay_mask, 1);
        ble_gatts_notify_custom(ble_conn_handle, relay_char_handle, om);
    }
}
static void ble_notify_inputs(void) {
    if (ble_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat((uint8_t*)&input_state, 1);
        ble_gatts_notify_custom(ble_conn_handle, input_char_handle, om);
    }
}
static void ble_notify_volts(void) {
    if (ble_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        uint8_t data[6];
        for (int i = 0; i < 3; i++) {
            data[i*2] = ina_millivolts[i] & 0xFF;
            data[i*2+1] = (ina_millivolts[i] >> 8) & 0xFF;
        }
        struct os_mbuf *om = ble_hs_mbuf_from_flat(data, 6);
        ble_gatts_notify_custom(ble_conn_handle, volt_char_handle, om);
    }
}

static int gatt_svr_chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    if (ble_uuid_cmp(ctxt->chr->uuid, &relay_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            os_mbuf_append(ctxt->om, (uint8_t*)&relay_mask, 1);
            return 0;
        } else if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            if (ctxt->om->om_len == 1) {
                // Bezpieczne przekazanie zapisu do głównego wątku via kolejka
                app_event_t evt = { .type = EVENT_BLE_RELAY_WRITE, .len = 1 };
                evt.data[0] = ctxt->om->om_data[0];
                xQueueSend(event_queue, &evt, 0);
            }
            return 0;
        }
    } else if (ble_uuid_cmp(ctxt->chr->uuid, &input_uuid.u) == 0) {
        os_mbuf_append(ctxt->om, (uint8_t*)&input_state, 1);
        return 0;
    } else if (ble_uuid_cmp(ctxt->chr->uuid, &volt_uuid.u) == 0) {
        uint8_t data[6];
        for (int i = 0; i < 3; i++) {
            data[i*2] = ina_millivolts[i] & 0xFF;
            data[i*2+1] = (ina_millivolts[i] >> 8) & 0xFF;
        }
        os_mbuf_append(ctxt->om, data, 6);
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def gatt_svr_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            { .uuid = &relay_uuid.u, .access_cb = gatt_svr_chr_access, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY, .val_handle = &relay_char_handle },
            { .uuid = &input_uuid.u, .access_cb = gatt_svr_chr_access, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY, .val_handle = &input_char_handle },
            { .uuid = &volt_uuid.u, .access_cb = gatt_svr_chr_access, .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY, .val_handle = &volt_char_handle },
            { 0 }
        }
    }, { 0 }
};

static int ble_gap_event(struct ble_gap_event *event, void *arg) {
    if (event->type == BLE_GAP_EVENT_CONNECT) {
        if (event->connect.status == 0) {
            ble_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "BLE Connected");
        } else {
            ble_gap_adv_start(ble_hs_id_infer_auto(), NULL, BLE_HS_FOREVER, &(struct ble_gap_adv_params){.conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN}, NULL, NULL);
        }
    } else if (event->type == BLE_GAP_EVENT_DISCONNECT) {
        ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        ESP_LOGI(TAG, "BLE Disconnected");
        ble_gap_adv_start(ble_hs_id_infer_auto(), NULL, BLE_HS_FOREVER, &(struct ble_gap_adv_params){.conn_mode = BLE_GAP_CONN_MODE_UND, .disc_mode = BLE_GAP_DISC_MODE_GEN}, NULL, NULL);
    }
    return 0;
}

static void ble_app_on_sync(void) {
    ble_hs_id_infer_auto(0, NULL);
    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    ble_gap_adv_start(ble_hs_id_infer_auto(), NULL, BLE_HS_FOREVER, &adv_params, ble_gap_event, NULL);
}

static void host_task(void *param) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* ------------------------------------------------------------------ I2C */
static esp_err_t read_register16(i2c_master_dev_handle_t device, uint8_t reg, uint16_t *value) {
    uint8_t data[2];
    esp_err_t err = i2c_master_transmit_receive(device, &reg, 1, data, sizeof(data), 100);
    if (err == ESP_OK) *value = ((uint16_t)data[0] << 8) | data[1];
    return err;
}
static esp_err_t add_i2c_device(i2c_master_bus_handle_t bus, uint8_t address, i2c_master_dev_handle_t *device) {
    const i2c_device_config_t config = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = address, .scl_speed_hz = I2C_SPEED_HZ };
    return i2c_master_bus_add_device(bus, &config, device);
}

/* ------------------------------------------------------------- MCP23017 */
static esp_err_t mcp23017_write(uint8_t reg, uint8_t value) {
    const uint8_t data[] = { reg, value };
    return i2c_master_transmit(mcp_device, data, sizeof(data), 100);
}
static esp_err_t mcp23017_read(uint8_t reg, uint8_t *value) {
    return i2c_master_transmit_receive(mcp_device, &reg, 1, value, 1, 100);
}

static void format_mask(char *out, size_t size, const char *prefix, uint8_t mask) {
    size_t used = 0; out[0] = '\0';
    for (uint8_t bit = 0; bit < 8; ++bit) {
        if ((mask & (1U << bit)) == 0) continue;
        int written = snprintf(out + used, size - used, "%s%s%u", used ? " " : "", prefix, (unsigned)bit);
        if (written < 0 || (size_t)written >= size - used) break;
        used += (size_t)written;
    }
    if (used == 0) snprintf(out, size, "none");
}

static esp_err_t set_relays(uint8_t mask) {
    if (mcp_device == NULL) return ESP_ERR_INVALID_STATE;
    esp_err_t err = mcp23017_write(MCP23017_REG_OLATA, mask);
    if (err != ESP_OK) return err;

    uint8_t changed = relay_mask ^ mask;
    relay_mask = mask;

    if (changed) {
        ble_notify_relays(); // Notify BLE about hardware change
    }
    return ESP_OK;
}

/* ------------------------------------------------------------------ CAN */
static esp_err_t can_send(uint32_t id, const uint8_t *data, uint8_t len) {
    if (can_node == NULL || len > 8) return ESP_ERR_INVALID_STATE;
    can_tx_slot_t *slot = &can_tx_slots[can_tx_next_slot];
    can_tx_next_slot = (can_tx_next_slot + 1) % CAN_TX_SLOTS;
    memcpy(slot->data, data, len);
    memset(&slot->frame, 0, sizeof(slot->frame));
    slot->frame.header.id = id;
    slot->frame.header.dlc = len;
    slot->frame.buffer = slot->data;
    slot->frame.buffer_len = len;
    return twai_node_transmit(can_node, &slot->frame, 10);
}

static void send_io_status(void) {
    const uint8_t data[2] = { relay_mask, input_state };
    can_send(CAN_ID_STATUS_IO, data, sizeof(data));
}
static void send_voltage_status(void) {
    uint8_t data[6];
    for (uint8_t channel = 0; channel < INA3221_CHANNELS; ++channel) {
        data[channel * 2] = (uint8_t)(ina_millivolts[channel] & 0xFF);
        data[channel * 2 + 1] = (uint8_t)(ina_millivolts[channel] >> 8);
    }
    can_send(CAN_ID_STATUS_VOLTAGE, data, sizeof(data));
}

static bool IRAM_ATTR can_rx_done_cb(twai_node_handle_t handle, const twai_rx_done_event_data_t *edata, void *user_ctx) {
    uint8_t buffer[8];
    twai_frame_t frame = { .buffer = buffer, .buffer_len = sizeof(buffer) };
    if (twai_node_receive_from_isr(handle, &frame) != ESP_OK) return false;
    can_rx_count++;
    if (frame.header.ide || frame.header.rtr) return false;

    app_event_t event = { .type = EVENT_CAN_RX, .id = frame.header.id, .len = (uint8_t)twaifd_dlc2len(frame.header.dlc) };
    if (event.len > sizeof(event.data)) event.len = sizeof(event.data);
    memcpy(event.data, buffer, event.len);
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(event_queue, &event, &woken);
    return woken == pdTRUE;
}
static bool IRAM_ATTR can_tx_done_cb(twai_node_handle_t handle, const twai_tx_done_event_data_t *edata, void *user_ctx) {
    if (edata->is_tx_success) can_tx_ok_count++;
    return false;
}
static bool IRAM_ATTR can_state_change_cb(twai_node_handle_t handle, const twai_state_change_event_data_t *edata, void *user_ctx) {
    can_state = edata->new_sta; return false;
}
static bool IRAM_ATTR can_error_cb(twai_node_handle_t handle, const twai_error_event_data_t *edata, void *user_ctx) {
    can_error_count++; return false;
}

static esp_err_t initialize_can(void) {
    twai_onchip_node_config_t config = {0};
    config.io_cfg.tx = CAN_TX_GPIO; config.io_cfg.rx = CAN_RX_GPIO;
    config.io_cfg.quanta_clk_out = GPIO_NUM_NC; config.io_cfg.bus_off_indicator = GPIO_NUM_NC;
    config.bit_timing.bitrate = CAN_BITRATE; config.tx_queue_depth = CAN_TX_QUEUE_DEPTH;
    config.fail_retry_cnt = 3; config.flags.enable_self_test = 1;
    esp_err_t err = twai_new_node_onchip(&config, &can_node);
    if (err != ESP_OK) return err;
    const twai_event_callbacks_t callbacks = { .on_tx_done = can_tx_done_cb, .on_rx_done = can_rx_done_cb, .on_state_change = can_state_change_cb, .on_error = can_error_cb };
    err = twai_node_register_event_callbacks(can_node, &callbacks, NULL);
    if (err == ESP_OK) err = twai_node_enable(can_node);
    if (err != ESP_OK) { twai_node_delete(can_node); can_node = NULL; }
    return err;
}

static void handle_can_frame(const app_event_t *event) {
    switch (event->id) {
    case CAN_ID_SET_RELAYS:
        if (event->len >= 1) { (void)set_relays(event->data[0]); send_io_status(); }
        break;
    case CAN_ID_SET_RELAY:
        if (event->len >= 2 && event->data[0] >= 1 && event->data[0] <= RELAY_COUNT && event->data[1] <= 2) {
            uint8_t bit = (uint8_t)(1U << (event->data[0] - 1));
            uint8_t mask = relay_mask;
            if (event->data[1] == 0) mask &= (uint8_t)~bit;
            else if (event->data[1] == 1) mask |= bit;
            else mask ^= bit;
            (void)set_relays(mask);
            send_io_status();
        }
        break;
    case CAN_ID_REQUEST_STATUS:
        send_io_status(); send_voltage_status();
        break;
    }
}

/* --------------------------------------------------------------- Tasks */
static void handle_input_interrupt(void) {
    uint8_t inputs;
    if (mcp23017_read(MCP23017_REG_GPIOB, &inputs) != ESP_OK) return;

    uint8_t changed = inputs ^ input_state;
    input_state = inputs;

    if (changed) {
        ble_notify_inputs(); // Update BLE
    }

    static TickType_t last_gpb7_press_time = 0;
    const TickType_t debounce_delay = pdMS_TO_TICKS(200);
    if ((changed & 0x80) && ((inputs & 0x80) == 0)) { 
        TickType_t now = xTaskGetTickCount();
        if ((now - last_gpb7_press_time) > debounce_delay) {
            (void)set_relays(relay_mask ^ 0x01);
            last_gpb7_press_time = now;
        }
    }
    send_io_status();
}

static void control_task(void *arg) {
    app_event_t event;
    const TickType_t heartbeat_period = pdMS_TO_TICKS(CAN_HEARTBEAT_MS);
    TickType_t next_heartbeat = xTaskGetTickCount() + heartbeat_period;
    uint8_t heartbeat_counter = 0;

    for (;;) {
        TickType_t now = xTaskGetTickCount();
        TickType_t wait = (next_heartbeat > now) ? next_heartbeat - now : 0;

        if (xQueueReceive(event_queue, &event, wait) == pdTRUE) {
            if (event.type == EVENT_MCP_INT) {
                handle_input_interrupt();
            } else if (event.type == EVENT_CAN_RX) {
                handle_can_frame(&event);
            } else if (event.type == EVENT_BLE_RELAY_WRITE) {
                (void)set_relays(event.data[0]);
                send_io_status();
            }
        }

        now = xTaskGetTickCount();
        if (now >= next_heartbeat) {
            const uint8_t data[4] = { heartbeat_counter++, (uint8_t)can_state, relay_mask, input_state };
            (void)can_send(CAN_ID_HEARTBEAT, data, sizeof(data));
            next_heartbeat += heartbeat_period;
            if (next_heartbeat <= now) next_heartbeat = now + heartbeat_period;
        }
        if (can_node != NULL && can_state == TWAI_ERROR_BUS_OFF) {
            (void)twai_node_recover(can_node);
        }
    }
}

static void ina3221_task(void *arg) {
    for (;;) {
        bool voltage_changed = false;
        for (uint8_t channel = 0; channel < INA3221_CHANNELS; ++channel) {
            uint16_t raw;
            if (read_register16(ina_device, INA3221_REG_BUS_CH1 + channel * 2, &raw) == ESP_OK) {
                uint16_t mv = (uint16_t)((raw >> 3) * 8);
                if (ina_millivolts[channel] != mv) {
                    ina_millivolts[channel] = mv;
                    voltage_changed = true;
                }
            }
        }
        if (voltage_changed) ble_notify_volts(); // Update BLE
        vTaskDelay(pdMS_TO_TICKS(INA3221_POLL_MS));
    }
}

static void IRAM_ATTR mcp23017_isr_handler(void *arg) {
    app_event_t event = { .type = EVENT_MCP_INT };
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(event_queue, &event, &woken);
    if (woken == pdTRUE) portYIELD_FROM_ISR();
}

/* ----------------------------------------------------------------- OLED */
static esp_err_t oled_send_commands(const uint8_t *commands, size_t count) {
    uint8_t data[32]; data[0] = 0x00; memcpy(&data[1], commands, count);
    return i2c_master_transmit(oled_device, data, count + 1, 100);
}
static esp_err_t oled_init(void) {
    const uint8_t init_seq[] = { 0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF };
    oled_buffer[0] = 0x40;
    return oled_send_commands(init_seq, sizeof(init_seq));
}
static esp_err_t oled_flush(void) {
    const uint8_t window[] = { 0x21, 0, OLED_WIDTH - 1, 0x22, 0, OLED_PAGES - 1 };
    if (oled_send_commands(window, sizeof(window)) != ESP_OK) return ESP_FAIL;
    return i2c_master_transmit(oled_device, oled_buffer, sizeof(oled_buffer), 200);
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
static const char *can_state_name(twai_error_state_t state) {
    switch (state) { case TWAI_ERROR_ACTIVE: return "ACTIVE"; case TWAI_ERROR_WARNING: return "WARN"; case TWAI_ERROR_PASSIVE: return "PASSIVE"; default: return "BUSOFF"; }
}
static void bits_to_text(char *out, uint8_t value) {
    for (uint8_t bit = 0; bit < 8; ++bit) out[bit] = (value & (1U << bit)) ? '1' : '0';
    out[8] = '\0';
}
static void oled_task(void *arg) {
    for (;;) {
        char relays[9]; char inputs[9];
        bits_to_text(relays, relay_mask); bits_to_text(inputs, input_state);
        
        oled_line(0, "BLE:%s UP %lus", ble_conn_handle != BLE_HS_CONN_HANDLE_NONE ? "OK" : "--", (unsigned long)(esp_timer_get_time() / 1000000));
        if (can_node) { oled_line(1, "CAN 500K %s", can_state_name(can_state)); oled_line(2, "RX%lu TX%lu E%lu", (unsigned long)can_rx_count, (unsigned long)can_tx_ok_count, (unsigned long)can_error_count); }
        else { oled_line(1, "CAN INIT FAILED"); oled_line(2, ""); }
        oled_line(3, mcp_device ? "RLY %s" : "RLY N/A", relays);
        oled_line(4, mcp_device ? "IN  %s" : "IN  N/A", inputs);
        for (uint8_t ch = 0; ch < INA3221_CHANNELS; ++ch) {
            if (ina_device) { unsigned int mv = ina_millivolts[ch]; oled_line(5 + ch, "CH%u %u.%03uV", ch + 1U, mv / 1000, mv % 1000); }
            else { oled_line(5 + ch, "CH%u N/A", ch + 1U); }
        }
        (void)oled_flush();
        vTaskDelay(pdMS_TO_TICKS(OLED_REFRESH_MS));
    }
}

/* ----------------------------------------------------------- Discovery */
static esp_err_t find_ina3221(i2c_master_bus_handle_t bus) {
    for (uint8_t addr = INA3221_ADDR_MIN; addr <= INA3221_ADDR_MAX; ++addr) {
        if (i2c_master_probe(bus, addr, 50) != ESP_OK) continue;
        i2c_master_dev_handle_t dev;
        if (add_i2c_device(bus, addr, &dev) != ESP_OK) return ESP_FAIL;
        uint16_t manuf, die;
        if (read_register16(dev, INA3221_REG_MANUF_ID, &manuf) == ESP_OK && read_register16(dev, INA3221_REG_DIE_ID, &die) == ESP_OK) {
            if (manuf == INA3221_MANUF_ID && die == INA3221_DIE_ID) {
                const uint8_t conf[] = { INA3221_REG_CONFIG, (uint8_t)(INA3221_CONFIG_VALUE >> 8), (uint8_t)INA3221_CONFIG_VALUE };
                if (i2c_master_transmit(dev, conf, sizeof(conf), 100) == ESP_OK) { ina_device = dev; return ESP_OK; }
            }
        }
        i2c_master_bus_rm_device(dev);
    }
    return ESP_ERR_NOT_FOUND;
}
static esp_err_t find_first_device(i2c_master_bus_handle_t bus, uint8_t first, uint8_t last, i2c_master_dev_handle_t *dev) {
    for (uint8_t addr = first; addr <= last; ++addr) {
        if (i2c_master_probe(bus, addr, 50) == ESP_OK && add_i2c_device(bus, addr, dev) == ESP_OK) return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

static esp_err_t initialize_mcp23017(void) {
    if (mcp23017_write(MCP23017_REG_IOCON, MCP23017_IOCON_VALUE) != ESP_OK) return ESP_FAIL;
    mcp23017_write(MCP23017_REG_GPINTENB, 0x00);
    mcp23017_write(MCP23017_REG_OLATA, 0x00);
    mcp23017_write(MCP23017_REG_IODIRA, 0x00);
    mcp23017_write(MCP23017_REG_IODIRB, 0xFF);
    mcp23017_write(MCP23017_REG_GPPUB, 0xFF);
    mcp23017_write(MCP23017_REG_INTCONB, 0x00);
    mcp23017_read(MCP23017_REG_GPIOB, (uint8_t*)&input_state);
    return ESP_OK;
}
static esp_err_t initialize_mcp_interrupt(void) {
    gpio_config_t pin_config = { .pin_bit_mask = 1ULL << MCP23017_INT_GPIO, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE, .intr_type = GPIO_INTR_NEGEDGE };
    if (gpio_config(&pin_config) != ESP_OK) return ESP_FAIL;
    esp_err_t err = gpio_install_isr_service(0);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
    return gpio_isr_handler_add(MCP23017_INT_GPIO, mcp23017_isr_handler, NULL);
}

void app_main(void) {
    // 1. Inicjalizacja NimBLE (Bluetooth)
    nimble_port_init();
    ble_svc_gap_device_name_set("Camper");
    ble_gatts_count_cfg(gatt_svr_svcs);
    ble_gatts_add_svcs(gatt_svr_svcs);
    ble_hs_cfg.sync_cb = ble_app_on_sync;
    nimble_port_freertos_init(host_task);

    // 2. Inicjalizacja Kolejki
    event_queue = xQueueCreate(16, sizeof(app_event_t));

    // 3. Inicjalizacja I2C
    const i2c_master_bus_config_t bus_config = { .i2c_port = I2C_NUM_0, .scl_io_num = I2C_SCL_GPIO, .sda_io_num = I2C_SDA_GPIO, .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = false };
    i2c_master_bus_handle_t bus;
    i2c_new_master_bus(&bus_config, &bus);

    find_ina3221(bus);
    if (find_first_device(bus, OLED_ADDR_MIN, OLED_ADDR_MAX, &oled_device) == ESP_OK) oled_init();
    
    if (find_first_device(bus, MCP23017_ADDR_MIN, MCP23017_ADDR_MAX, &mcp_device) == ESP_OK) {
        initialize_mcp23017();
        initialize_mcp_interrupt();
    }

    // 4. Inicjalizacja CAN
    initialize_can();

    // 5. Uruchomienie Tasków
    xTaskCreate(control_task, "control", 4096, NULL, 6, NULL);
    if (ina_device) xTaskCreate(ina3221_task, "ina3221", 3072, NULL, 4, NULL);
    if (oled_device) xTaskCreate(oled_task, "oled", 4096, NULL, 3, NULL);

    if (mcp_device) mcp23017_write(MCP23017_REG_GPINTENB, 0xFF);
}