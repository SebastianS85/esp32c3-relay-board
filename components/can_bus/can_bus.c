#include "can_bus.h"
#include <string.h>

#define CAN_TX_GPIO 7
#define CAN_RX_GPIO 6
#define CAN_BITRATE 500000
#define CAN_TX_QUEUE_DEPTH 8
#define CAN_TX_SLOTS 16

typedef struct {
    twai_frame_t frame;
    uint8_t data[8];
} can_tx_slot_t;

static can_tx_slot_t can_tx_slots[CAN_TX_SLOTS];
static uint8_t can_tx_next_slot = 0;
static QueueHandle_t can_event_queue = NULL;

// Liczniki statystyk CAN
static volatile uint32_t can_rx_count = 0;
static volatile uint32_t can_tx_ok_count = 0;
static volatile uint32_t can_error_count = 0;

uint32_t get_can_rx_count(void) { return can_rx_count; }
uint32_t get_can_tx_ok_count(void) { return can_tx_ok_count; }
uint32_t get_can_error_count(void) { return can_error_count; }

static bool IRAM_ATTR can_rx_done_cb(twai_node_handle_t handle, const twai_rx_done_event_data_t *edata, void *user_ctx) {
    uint8_t buffer[8];
    twai_frame_t frame = { .buffer = buffer, .buffer_len = sizeof(buffer) };
    if (twai_node_receive_from_isr(handle, &frame) != ESP_OK) return false;
    
    can_rx_count++; // Inkrementacja licznika odebranych ramek
    
    if (frame.header.ide || frame.header.rtr) return false;

    typedef struct { int type; uint32_t id; uint8_t len; uint8_t data[8]; } app_evt_t;
    app_evt_t event = { .type = 0, .id = frame.header.id, .len = (uint8_t)twaifd_dlc2len(frame.header.dlc) }; // EVENT_CAN_RX = 0
    if (event.len > 8) event.len = 8;
    memcpy(event.data, buffer, event.len);
    BaseType_t woken = pdFALSE;
    xQueueSendFromISR(can_event_queue, &event, &woken);
    return woken == pdTRUE;
}

static bool IRAM_ATTR can_state_change_cb(twai_node_handle_t handle, const twai_state_change_event_data_t *edata, void *user_ctx) { 
    return false; 
}

static bool IRAM_ATTR can_error_cb(twai_node_handle_t handle, const twai_error_event_data_t *edata, void *user_ctx) { 
    can_error_count++; // Inkrementacja licznika błędów CAN
    return false; 
}

static bool IRAM_ATTR can_tx_done_cb(twai_node_handle_t handle, const twai_tx_done_event_data_t *edata, void *user_ctx) { 
    if (edata->is_tx_success) {
        can_tx_ok_count++; // Inkrementacja licznika wysłanych ramek
    }
    return false; 
}

esp_err_t initialize_can(QueueHandle_t queue, twai_node_handle_t *out_node) {
    can_event_queue = queue;
    twai_onchip_node_config_t config = {0};
    config.io_cfg.tx = CAN_TX_GPIO; config.io_cfg.rx = CAN_RX_GPIO;
    config.bit_timing.bitrate = CAN_BITRATE; config.tx_queue_depth = CAN_TX_QUEUE_DEPTH;
    config.fail_retry_cnt = 3; config.flags.enable_self_test = 1;

    esp_err_t err = twai_new_node_onchip(&config, out_node);
    if (err != ESP_OK) return err;

    const twai_event_callbacks_t callbacks = { .on_tx_done = can_tx_done_cb, .on_rx_done = can_rx_done_cb, .on_state_change = can_state_change_cb, .on_error = can_error_cb };
    err = twai_node_register_event_callbacks(*out_node, &callbacks, NULL);
    if (err == ESP_OK) err = twai_node_enable(*out_node);
    return err;
}

esp_err_t can_send(twai_node_handle_t node, uint32_t id, const uint8_t *data, uint8_t len) {
    if (node == NULL || len > 8) return ESP_ERR_INVALID_STATE;
    can_tx_slot_t *slot = &can_tx_slots[can_tx_next_slot];
    can_tx_next_slot = (can_tx_next_slot + 1) % CAN_TX_SLOTS;
    memcpy(slot->data, data, len);
    memset(&slot->frame, 0, sizeof(slot->frame));
    slot->frame.header.id = id;
    slot->frame.header.dlc = len;
    slot->frame.buffer = slot->data;
    slot->frame.buffer_len = len;
    return twai_node_transmit(node, &slot->frame, 10);
}

const char *can_state_name(twai_error_state_t state) {
    switch (state) { 
        case TWAI_ERROR_ACTIVE: return "ACTIVE"; 
        case TWAI_ERROR_WARNING: return "WARN"; 
        case TWAI_ERROR_PASSIVE: return "PASSIVE"; 
        default: return "BUSOFF"; 
    }
}