idf_component_register(SRCS "wifi_webserver.c"
                    INCLUDE_DIRS "."
                    REQUIRES nvs_flash spiffs esp_wifi esp_netif esp_http_server)