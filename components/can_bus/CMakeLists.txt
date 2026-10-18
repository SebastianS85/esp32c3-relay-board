idf_component_register(SRCS "can_bus.c"
                    INCLUDE_DIRS "."
                    REQUIRES esp_driver_twai esp_timer freertos can_bus)