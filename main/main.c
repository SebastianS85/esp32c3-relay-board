#include <stdio.h>
#include "nvs_flash.h"
#include "esp_log.h"

#include "wifi_webserver.h"
#include "can_bus.h"
#include "peripherals.h"

static const char *TAG = "main";

void app_main(void) {
    // 1. Initialisation of NVS (Non-Volatile Storage)
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_flash_init();
    }

    // 2. Creation of the main system event queue
    QueueHandle_t event_queue = xQueueCreate(16, sizeof(int) + sizeof(uint32_t) + 10);

    // 3. Starting Wi-Fi, SPIFFS, and the WWW server with WebSocket
    wifi_init_sta_ap(event_queue);

    // 4. Initialization of the CAN (TWAI) bus
    twai_node_handle_t can_node = NULL;
    initialize_can(event_queue, &can_node);

    // 5. Initialization of I2C peripherals (INA, MCP, OLED) and start of all background tasks (control, oled, voltages)
    i2c_master_bus_handle_t i2c_bus;
    i2c_master_dev_handle_t ina_dev, mcp_dev, oled_dev;
    init_peripherals(&i2c_bus, &ina_dev, &mcp_dev, &oled_dev, event_queue, can_node);

    ESP_LOGI(TAG, "Running...");
}