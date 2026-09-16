#include "cJSON.h"

#include <cstdlib>
#include <cstring>
#include <limits>
#include <sstream>
#include <string>

namespace {

char* Dup(const std::string& value) {
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (!out)
        return nullptr;
    std::memcpy(out, value.c_str(), value.size() + 1);
    return out;
}

void AppendChild(cJSON* object, cJSON* child, const char* key) {
    if (!object || object->type != cJSON::kObject || !child)
        return;
    child->string = Dup(key ? key : "");
    if (!object->child) {
        object->child = child;
        return;
    }
    cJSON* cur = object->child;
    while (cur->next)
        cur = cur->next;
    cur->next = child;
}

std::string Escape(const char* raw) {
    std::string out;
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(raw ? raw : ""); *p; ++p) {
        if (*p == '"' || *p == '\\')
            out.push_back('\\');
        out.push_back(static_cast<char>(*p));
    }
    return out;
}

void PrintValue(const cJSON* item, std::string& out) {
    if (!item) {
        out += "null";
        return;
    }
    switch (item->type) {
        case cJSON::kObject: {
            out.push_back('{');
            for (const cJSON* child = item->child; child; child = child->next) {
                if (child != item->child)
                    out.push_back(',');
                out.push_back('"');
                out += Escape(child->string);
                out += "\":";
                PrintValue(child, out);
            }
            out.push_back('}');
            break;
        }
        case cJSON::kString:
            out.push_back('"');
            out += Escape(item->valuestring);
            out.push_back('"');
            break;
        case cJSON::kNumber: {
            std::ostringstream oss;
            oss.precision(17);
            oss << item->valuedouble;
            out += oss.str();
            break;
        }
        case cJSON::kNull:
            out += "null";
            break;
    }
}

class Parser {
   public:
    Parser(const char* text, std::size_t len) : text_(text), len_(len) {
    }

    cJSON* Parse() {
        SkipWs();
        cJSON* root = ParseObject();
        SkipWs();
        if (!root || pos_ != len_) {
            cJSON_Delete(root);
            return nullptr;
        }
        return root;
    }

   private:
    void SkipWs() {
        while (pos_ < len_ && (text_[pos_] == ' ' || text_[pos_] == '\n' || text_[pos_] == '\r' || text_[pos_] == '\t'))
            ++pos_;
    }

    bool Consume(char ch) {
        SkipWs();
        if (pos_ >= len_ || text_[pos_] != ch)
            return false;
        ++pos_;
        return true;
    }

    std::string ParseStringLiteral(bool& ok) {
        ok = false;
        SkipWs();
        if (pos_ >= len_ || text_[pos_] != '"')
            return {};
        ++pos_;
        std::string out;
        while (pos_ < len_) {
            char ch = text_[pos_++];
            if (ch == '"') {
                ok = true;
                return out;
            }
            if (ch == '\\') {
                if (pos_ >= len_)
                    return {};
                ch = text_[pos_++];
            }
            out.push_back(ch);
        }
        return {};
    }

    cJSON* ParseObject() {
        if (!Consume('{'))
            return nullptr;
        cJSON* object = cJSON_CreateObject();
        SkipWs();
        if (Consume('}'))
            return object;
        while (true) {
            bool ok = false;
            std::string key = ParseStringLiteral(ok);
            if (!ok || !Consume(':')) {
                cJSON_Delete(object);
                return nullptr;
            }
            cJSON* value = ParseValue();
            if (!value) {
                cJSON_Delete(object);
                return nullptr;
            }
            AppendChild(object, value, key.c_str());
            if (Consume('}'))
                return object;
            if (!Consume(',')) {
                cJSON_Delete(object);
                return nullptr;
            }
        }
    }

    cJSON* ParseValue() {
        SkipWs();
        if (pos_ >= len_)
            return nullptr;
        if (text_[pos_] == '"') {
            bool ok = false;
            std::string value = ParseStringLiteral(ok);
            if (!ok)
                return nullptr;
            cJSON* item = new cJSON();
            item->type = cJSON::kString;
            item->valuestring = Dup(value);
            return item;
        }
        if (text_[pos_] == '{')
            return ParseObject();
        if (text_[pos_] == 'n' && pos_ + 4 <= len_ && std::strncmp(text_ + pos_, "null", 4) == 0) {
            pos_ += 4;
            cJSON* item = new cJSON();
            item->type = cJSON::kNull;
            return item;
        }
        std::size_t token_end = pos_;
        if (!ParseNumberToken(token_end))
            return nullptr;
        std::string token(text_ + pos_, token_end - pos_);
        char* end = nullptr;
        double value = std::strtod(token.c_str(), &end);
        if (end != token.c_str() + token.size())
            return nullptr;
        pos_ = token_end;
        SkipWs();
        if (pos_ >= len_ || (text_[pos_] != ',' && text_[pos_] != '}'))
            return nullptr;
        cJSON* item = new cJSON();
        item->type = cJSON::kNumber;
        item->valuedouble = value;
        item->valueint = value > static_cast<double>(std::numeric_limits<int>::max()) ? std::numeric_limits<int>::max()
                       : value < static_cast<double>(std::numeric_limits<int>::min()) ? std::numeric_limits<int>::min()
                                                                                      : static_cast<int>(value);
        return item;
    }

    bool ParseNumberToken(std::size_t& token_end) const {
        std::size_t p = token_end;
        if (p >= len_)
            return false;
        if (text_[p] == '-')
            ++p;
        if (p >= len_)
            return false;
        if (text_[p] == '0') {
            ++p;
        } else if (text_[p] >= '1' && text_[p] <= '9') {
            do {
                ++p;
            } while (p < len_ && text_[p] >= '0' && text_[p] <= '9');
        } else {
            return false;
        }
        if (p < len_ && text_[p] == '.') {
            ++p;
            const std::size_t first_fraction_digit = p;
            while (p < len_ && text_[p] >= '0' && text_[p] <= '9')
                ++p;
            if (p == first_fraction_digit)
                return false;
        }
        if (p < len_ && (text_[p] == 'e' || text_[p] == 'E')) {
            ++p;
            if (p < len_ && (text_[p] == '+' || text_[p] == '-'))
                ++p;
            const std::size_t first_exponent_digit = p;
            while (p < len_ && text_[p] >= '0' && text_[p] <= '9')
                ++p;
            if (p == first_exponent_digit)
                return false;
        }
        token_end = p;
        return true;
    }

    const char* text_ = nullptr;
    std::size_t len_ = 0;
    std::size_t pos_ = 0;
};

}  // namespace

cJSON* cJSON_CreateObject() {
    cJSON* item = new cJSON();
    item->type = cJSON::kObject;
    return item;
}

void cJSON_Delete(cJSON* item) {
    if (!item)
        return;
    cJSON* child = item->child;
    while (child) {
        cJSON* next = child->next;
        cJSON_Delete(child);
        child = next;
    }
    std::free(item->string);
    std::free(item->valuestring);
    delete item;
}

void cJSON_AddStringToObject(cJSON* object, const char* key, const char* value) {
    cJSON* item = new cJSON();
    item->type = cJSON::kString;
    item->valuestring = Dup(value ? value : "");
    AppendChild(object, item, key);
}

void cJSON_AddNumberToObject(cJSON* object, const char* key, double value) {
    cJSON* item = new cJSON();
    item->type = cJSON::kNumber;
    item->valuedouble = value;
    item->valueint = value > static_cast<double>(std::numeric_limits<int>::max()) ? std::numeric_limits<int>::max()
                   : value < static_cast<double>(std::numeric_limits<int>::min()) ? std::numeric_limits<int>::min()
                                                                                  : static_cast<int>(value);
    AppendChild(object, item, key);
}

void cJSON_AddNullToObject(cJSON* object, const char* key) {
    cJSON* item = new cJSON();
    item->type = cJSON::kNull;
    AppendChild(object, item, key);
}

char* cJSON_PrintUnformatted(cJSON* item) {
    std::string out;
    PrintValue(item, out);
    return Dup(out);
}

void cJSON_free(void* ptr) {
    std::free(ptr);
}

cJSON* cJSON_ParseWithLength(const char* text, std::size_t len) {
    Parser parser(text, len);
    return parser.Parse();
}

cJSON* cJSON_ParseWithOpts(const char* text, const char** return_parse_end, cJSON_bool require_null_terminated) {
    if (!text) {
        if (return_parse_end)
            *return_parse_end = nullptr;
        return nullptr;
    }
    const std::size_t len  = std::strlen(text);
    cJSON*           value = cJSON_ParseWithLength(text, len);
    if (return_parse_end)
        *return_parse_end = value ? text + len : text;
    (void)require_null_terminated;
    return value;
}

cJSON* cJSON_Parse(const char* text) {
    return text ? cJSON_ParseWithLength(text, std::strlen(text)) : nullptr;
}

cJSON* cJSON_GetObjectItemCaseSensitive(const cJSON* object, const char* key) {
    if (!object || object->type != cJSON::kObject)
        return nullptr;
    for (cJSON* child = object->child; child; child = child->next) {
        if (child->string && std::strcmp(child->string, key) == 0)
            return child;
    }
    return nullptr;
}

bool cJSON_IsObject(const cJSON* item) {
    return item && item->type == cJSON::kObject;
}

bool cJSON_IsString(const cJSON* item) {
    return item && item->type == cJSON::kString;
}

bool cJSON_IsNumber(const cJSON* item) {
    return item && item->type == cJSON::kNumber;
}

bool cJSON_IsNull(const cJSON* item) {
    return item && item->type == cJSON::kNull;
}
