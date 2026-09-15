#include "storage/cache/cache_json.h"

#include <cJSON.h>
#include <limits>

#include "sync/manifest_contract.h"

namespace cache::internal {

std::string JsonStringField(cJSON* root, const char* key) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    return cJSON_IsString(value) && value->valuestring ? value->valuestring : "";
}

int JsonNonNegativeIntField(cJSON* root, const char* key, int default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    int    out   = default_value;
    if (sync_contract::ReadIntField({cJSON_IsNumber(value), cJSON_IsNumber(value) ? value->valuedouble : 0.0}, 0,
                                    std::numeric_limits<int>::max(), out))
        return out;
    return default_value;
}

uint32_t JsonUint32Field(cJSON* root, const char* key, uint32_t default_value) {
    cJSON* value = cJSON_GetObjectItemCaseSensitive(root, key);
    uint32_t out = default_value;
    if (sync_contract::ReadUint32Field({cJSON_IsNumber(value), cJSON_IsNumber(value) ? value->valuedouble : 0.0},
                                       out))
        return out;
    return default_value;
}

}  // namespace cache::internal
