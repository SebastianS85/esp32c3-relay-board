#include "wifi_webserver.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_spiffs.h"
#include "esp_log.h"
#include "secrets.h"

static const char *TAG = "wifi_webserver";
static esp_netif_t *netif_sta = NULL;
static esp_netif_t *netif_ap = NULL;
static int wifi_retry_num = 0;
static char display_ip[16] = "0.0.0.0";
static bool is_ap_mode = false;
static httpd_handle_t web_server = NULL;
static QueueHandle_t external_event_queue = NULL;

#define WIFI_MAX_RETRY 5

static httpd_handle_t start_webserver(void);

const char* get_display_ip(void) { return display_ip; }
bool get_is_ap_mode(void) { return is_ap_mode; }

static void start_ap_mode(void) {
    ESP_LOGW(TAG, "Switching to Access Point mode...");
    esp_wifi_stop();
    
    wifi_config_t wifi_config_ap = {
        .ap = {
            .ssid = WIFI_AP_SSID,
            .ssid_len = strlen(WIFI_AP_SSID),
            .password = WIFI_AP_PASS,
            .max_connection = 4,
            .authmode = WIFI_AUTH_WPA2_PSK
        },
    };
    
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wifi_config_ap));
    ESP_ERROR_CHECK(esp_wifi_start());
    
    is_ap_mode = true;
    esp_netif_ip_info_t ip_info;
    esp_netif_get_ip_info(netif_ap, &ip_info);
    snprintf(display_ip, sizeof(display_ip), IPSTR, IP2STR(&ip_info.ip));
    
    if (web_server == NULL) web_server = start_webserver();
}

static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (!is_ap_mode) {
            if (wifi_retry_num < WIFI_MAX_RETRY) {
                esp_wifi_connect();
                wifi_retry_num++;
                ESP_LOGI(TAG, "Retrying Wi-Fi connection (%d/%d)...", wifi_retry_num, WIFI_MAX_RETRY);
            } else {
                ESP_LOGE(TAG, "Failed to connect to base station. Falling back to AP.");
                start_ap_mode();
            }
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t* event = (ip_event_got_ip_t*) event_data;
        snprintf(display_ip, sizeof(display_ip), IPSTR, IP2STR(&event->ip_info.ip));
        is_ap_mode = false;
        wifi_retry_num = 0;
        ESP_LOGI(TAG, "Connected in STA mode! IP Address: %s", display_ip);
        if (web_server == NULL) web_server = start_webserver();
    }
}

void wifi_init_sta_ap(QueueHandle_t app_event_queue) {
    external_event_queue = app_event_queue;
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    
    netif_sta = esp_netif_create_default_wifi_sta();
    netif_ap = esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL);

    wifi_config_t wifi_config_sta = {
        .sta = {
            .ssid = WIFI_STA_SSID,
            .password = WIFI_STA_PASS,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config_sta));
    ESP_ERROR_CHECK(esp_wifi_start());

    esp_vfs_spiffs_conf_t conf = {
      .base_path = "/spiffs", .partition_label = NULL, .max_files = 5, .format_if_mount_failed = true
    };
    esp_vfs_spiffs_register(&conf);
}

void broadcast_ws_status(uint8_t relay_mask, uint8_t input_state, const uint16_t *voltages) {
    if (!web_server) return;
    
    char resp[128];
    snprintf(resp, sizeof(resp), 
             "{\"relays\":%d, \"inputs\":%d, \"v1\":%d, \"v2\":%d, \"v3\":%d}", 
             relay_mask, input_state, voltages[0], voltages[1], voltages[2]);

    size_t clients = 8;
    int client_fds[8];
    if (httpd_get_client_list(web_server, &clients, client_fds) == ESP_OK) {
        for (size_t i = 0; i < clients; ++i) {
            int fd = client_fds[i];
            if (httpd_ws_get_fd_info(web_server, fd) == HTTPD_WS_CLIENT_WEBSOCKET) {
                httpd_ws_frame_t ws_pkt;
                memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
                ws_pkt.payload = (uint8_t*)resp;
                ws_pkt.len = strlen(resp);
                ws_pkt.type = HTTPD_WS_TYPE_TEXT;
                httpd_ws_send_frame_async(web_server, fd, &ws_pkt);
            }
        }
    }
}

static esp_err_t ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) return ESP_OK;

    httpd_ws_frame_t ws_pkt;
    memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
    ws_pkt.type = HTTPD_WS_TYPE_TEXT;

    esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
    if (ret != ESP_OK) return ret;

    if (ws_pkt.len) {
        uint8_t *buf = calloc(1, ws_pkt.len + 1);
        if (buf) {
            ws_pkt.payload = buf;
            ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
            if (ret == ESP_OK && external_event_queue) {
                typedef struct { int type; uint32_t id; uint8_t len; uint8_t data[8]; } app_evt_t;
                app_evt_t evt = { .type = 2, .len = 1 }; // EVENT_WIFI_RELAY_WRITE = 2
                evt.data[0] = (uint8_t)atoi((char*)buf);
                xQueueSend(external_event_queue, &evt, 0);
            }
            free(buf);
        }
    }
    return ret;
}

static esp_err_t file_server_handler(httpd_req_t *req) {
    char filepath[600];
    if (strcmp(req->uri, "/") == 0) snprintf(filepath, sizeof(filepath), "/spiffs/index.html");
    else snprintf(filepath, sizeof(filepath), "/spiffs%s", req->uri);

    FILE *fd = fopen(filepath, "r");
    if (!fd) { httpd_resp_send_404(req); return ESP_FAIL; }

    if (strstr(filepath, ".html")) httpd_resp_set_type(req, "text/html");
    else if (strstr(filepath, ".css")) httpd_resp_set_type(req, "text/css");
    else if (strstr(filepath, ".js")) httpd_resp_set_type(req, "application/javascript");
    else if (strstr(filepath, ".json")) httpd_resp_set_type(req, "application/json");

    char chunk[512];
    size_t read_bytes;
    while ((read_bytes = fread(chunk, 1, sizeof(chunk), fd)) > 0) {
        httpd_resp_send_chunk(req, chunk, read_bytes);
    }
    httpd_resp_send_chunk(req, NULL, 0);
    fclose(fd);
    return ESP_OK;
}

static httpd_handle_t start_webserver(void) {
    httpd_handle_t server = NULL;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.uri_match_fn = httpd_uri_match_wildcard;

    if (httpd_start(&server, &config) == ESP_OK) {
        httpd_uri_t uri_ws = { .uri = "/ws", .method = HTTP_GET, .handler = ws_handler, .is_websocket = true };
        httpd_register_uri_handler(server, &uri_ws);
        
        httpd_uri_t uri_file_server = { .uri = "/*", .method = HTTP_GET, .handler = file_server_handler };
        httpd_register_uri_handler(server, &uri_file_server);
    }
    return server;
}