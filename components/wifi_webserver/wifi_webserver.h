#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

void wifi_init_sta_ap(QueueHandle_t app_event_queue);
void broadcast_ws_status(uint8_t relay_mask, uint8_t input_state, const uint16_t *voltages);


const char* get_display_ip(void);
bool get_is_ap_mode(void);