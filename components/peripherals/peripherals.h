#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "driver/i2c_master.h"
#include "esp_twai.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

void init_peripherals(i2c_master_bus_handle_t *bus, i2c_master_dev_handle_t *ina, i2c_master_dev_handle_t *mcp, i2c_master_dev_handle_t *oled, QueueHandle_t queue, twai_node_handle_t can_node_ref);
esp_err_t set_relays_hw(uint8_t mask);
uint8_t get_relay_mask(void);
uint8_t get_input_state(void);
void get_voltages(uint16_t *dest);