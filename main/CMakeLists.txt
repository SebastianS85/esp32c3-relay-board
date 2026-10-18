idf_component_register(SRCS "main.c"
                    INCLUDE_DIRS "."
                    PRIV_REQUIRES PRIV_REQUIRES nvs_flash spiffs wifi_webserver can_bus peripherals)
