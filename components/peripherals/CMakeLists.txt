idf_component_register(SRCS "peripherals.c"
                    INCLUDE_DIRS "."
                    REQUIRES esp_driver_gpio esp_driver_i2c esp_timer esp_driver_twai can_bus wifi_webserver)