#pragma once
#include <stdint.h>
#include "esp_err.h"
#include "esp_twai.h"
#include "esp_twai_onchip.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

esp_err_t initialize_can(QueueHandle_t queue, twai_node_handle_t *out_node);
esp_err_t can_send(twai_node_handle_t node, uint32_t id, const uint8_t *data, uint8_t len);
const char *can_state_name(twai_error_state_t state);

// Deklaracje liczników wymagane przez peryferia (OLED)
uint32_t get_can_rx_count(void);
uint32_t get_can_tx_ok_count(void);
uint32_t get_can_error_count(void);