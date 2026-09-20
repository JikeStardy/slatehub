#include <cstdio>
#include <cstring>
#include <string>

#include "update/firmware_offer.h"

namespace {

int g_failures = 0;

void Check(bool ok, const char* expr, int line) {
    if (ok)
        return;
    std::fprintf(stderr, "CHECK failed line=%d expr=%s\n", line, expr);
    ++g_failures;
}

#define CHECK(expr) Check((expr), #expr, __LINE__)

constexpr const char* kSha256Abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

std::string OfferJson(const char* board_id = "zectrix-note4",
                      const char* url = "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                      const char* filename = "slatehub-zectrix-note4-v0.2.0-ota.bin",
                      const char* sha256 = kSha256Abc, const char* size_json = "3", int schema_version = 1,
                      const char* product = "slatehub", const char* kind = "ota", const char* version = "0.2.0",
                      const char* release_tag = "v0.2.0", const char* top_extra = "",
                      const char* artifact_extra = "") {
    return std::string("{\"schema_version\":") + std::to_string(schema_version) +
           ",\"product\":\"" + product + "\",\"board_id\":\"" + board_id + "\",\"version\":\"" +
           version + "\",\"release_tag\":\"" + release_tag + "\",\"artifact\":{\"kind\":\"" + kind +
           "\",\"filename\":\"" + filename + "\",\"size_bytes\":" + size_json + ",\"sha256\":\"" +
           sha256 + "\",\"download_url\":\"" + url + "\"" + artifact_extra + "}" + top_extra + "}";
}

firmware_update::FirmwareOfferResult Read(const std::string& json) {
    return firmware_update::ReadFirmwareOffer(json);
}

std::string ReplaceOnce(std::string value, const char* from, const char* to) {
    const std::size_t position = value.find(from);
    CHECK(position != std::string::npos);
    if (position != std::string::npos)
        value.replace(position, std::strlen(from), to);
    return value;
}

void TestAcceptsMatchingOffer() {
    firmware_update::FirmwareOfferResult result = Read(OfferJson());
    CHECK(result.accepted);
    CHECK(result.reject_reason.empty());
    CHECK(result.offer != nullptr);
    if (result.offer) {
        CHECK(result.offer->board_id() == "zectrix-note4");
        CHECK(result.offer->version() == "0.2.0");
        CHECK(result.offer->release_tag() == "v0.2.0");
        CHECK(result.offer->filename() == "slatehub-zectrix-note4-v0.2.0-ota.bin");
        CHECK(result.offer->download_url() ==
              "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin");
        CHECK(result.offer->size_bytes() == 3);
        CHECK(result.offer->sha256() == kSha256Abc);
    }
}

void TestRejectsCrossBoardWithoutExposingOffer() {
    firmware_update::FirmwareOfferResult result = Read(OfferJson("other-esp-screen"));
    CHECK(!result.accepted);
    CHECK(result.reject_reason == "board_id_mismatch");
    CHECK(result.offer == nullptr);
}

void TestRejectsMissingMetadataFields() {
    firmware_update::FirmwareOfferResult result = Read("{}");
    CHECK(!result.accepted);
    CHECK(result.reject_reason == "metadata_fields_invalid");
}

void TestRejectsInvalidFields() {
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1,
                         "slatehub\\u0000evil"))
              .reject_reason == "metadata_invalid");
    std::string embedded_nul = OfferJson();
    embedded_nul.insert(embedded_nul.size() / 2, 1, '\0');
    CHECK(Read(embedded_nul).reject_reason == "metadata_invalid");
    CHECK(Read(ReplaceOnce(OfferJson(), "\"schema_version\":1", "\"schema_version\":1.5"))
              .reject_reason == "schema_version_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 2))
              .reject_reason == "schema_version_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "other"))
              .reject_reason == "product_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "s" "late"))
              .reject_reason == "product_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "full"))
              .reject_reason == "artifact_kind_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "0"))
              .reject_reason == "size_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", ""))
              .reject_reason == "version_missing");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         ""))
              .reject_reason == "release_tag_missing");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         "0.2.0"))
              .reject_reason == "release_tag_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v1.2-ota.bin",
                         "slatehub-zectrix-note4-v1.2-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "1.2",
                         "v1.2"))
              .reject_reason == "version_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota",
                         "0.2.0\\u000a", "v0.2.0"))
              .reject_reason == "version_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "http://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin"))
              .reject_reason == "url_not_https");
    CHECK(Read(OfferJson("zectrix-note4", "https:///slatehub-zectrix-note4-v0.2.0-ota.bin"))
              .reject_reason == "url_not_https");
    CHECK(Read(OfferJson("zectrix-note4",
                         "https://updates.example:bad/slatehub-zectrix-note4-v0.2.0-ota.bin"))
              .reject_reason == "url_not_https");
    CHECK(Read(OfferJson("zectrix-note4",
                         "https://user@updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin"))
              .reject_reason == "url_not_https");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/other.bin")).reject_reason ==
          "filename_url_basename_mismatch");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "other.bin"))
              .reject_reason == "filename_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", "ABC"))
              .reject_reason == "sha256_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3.5"))
              .reject_reason == "size_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "1e400"))
              .reject_reason == "size_invalid");
}

void TestRejectsAdditionalProperties() {
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         "v0.2.0", ",\"extra\":\"nope\""))
              .reject_reason == "metadata_fields_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         "v0.2.0", "", ",\"extra\":\"nope\""))
              .reject_reason == "artifact_fields_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         "v0.2.0", ",\"board_id\":\"other-esp-screen\""))
              .reject_reason == "metadata_fields_invalid");
    CHECK(Read(OfferJson("zectrix-note4", "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin",
                         "slatehub-zectrix-note4-v0.2.0-ota.bin", kSha256Abc, "3", 1, "slatehub", "ota", "0.2.0",
                         "v0.2.0", "", ",\"download_url\":\"https://evil.example/payload.bin\""))
              .reject_reason == "artifact_fields_invalid");
}

}  // namespace

int main() {
    TestAcceptsMatchingOffer();
    TestRejectsCrossBoardWithoutExposingOffer();
    TestRejectsMissingMetadataFields();
    TestRejectsInvalidFields();
    TestRejectsAdditionalProperties();
    return g_failures == 0 ? 0 : 1;
}
