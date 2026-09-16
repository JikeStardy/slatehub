#pragma once

#include <cstddef>

struct cJSON {
    enum Type {
        kObject,
        kString,
        kNumber,
        kNull,
    } type = kNull;
    char*  string = nullptr;
    char*  valuestring = nullptr;
    double valuedouble = 0.0;
    int    valueint = 0;
    cJSON* child = nullptr;
    cJSON* next = nullptr;
};

using cJSON_bool = int;

cJSON* cJSON_CreateObject();
void   cJSON_Delete(cJSON* item);
void   cJSON_AddStringToObject(cJSON* object, const char* key, const char* value);
void   cJSON_AddNumberToObject(cJSON* object, const char* key, double value);
void   cJSON_AddNullToObject(cJSON* object, const char* key);
char*  cJSON_PrintUnformatted(cJSON* item);
void   cJSON_free(void* ptr);
cJSON* cJSON_ParseWithLength(const char* text, std::size_t len);
cJSON* cJSON_ParseWithOpts(const char* text, const char** return_parse_end, cJSON_bool require_null_terminated);
cJSON* cJSON_Parse(const char* text);
cJSON* cJSON_GetObjectItemCaseSensitive(const cJSON* object, const char* key);

bool cJSON_IsObject(const cJSON* item);
bool cJSON_IsString(const cJSON* item);
bool cJSON_IsNumber(const cJSON* item);
bool cJSON_IsNull(const cJSON* item);
