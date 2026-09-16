#pragma once

#include <cstddef>
#include <memory>
#include <string>
#include <string_view>

namespace firmware_update {

struct FirmwareOfferResult;

class AcceptedFirmwareOffer {
   public:
    AcceptedFirmwareOffer(const AcceptedFirmwareOffer&)            = delete;
    AcceptedFirmwareOffer& operator=(const AcceptedFirmwareOffer&) = delete;
    AcceptedFirmwareOffer(AcceptedFirmwareOffer&&)                 = delete;
    AcceptedFirmwareOffer& operator=(AcceptedFirmwareOffer&&)      = delete;

    const std::string& board_id() const {
        return board_id_;
    }
    const std::string& version() const {
        return version_;
    }
    const std::string& release_tag() const {
        return release_tag_;
    }
    const std::string& filename() const {
        return filename_;
    }
    const std::string& download_url() const {
        return download_url_;
    }
    const std::string& sha256() const {
        return sha256_;
    }
    std::size_t size_bytes() const {
        return size_bytes_;
    }

   private:
    friend struct FirmwareOfferResult;
    friend FirmwareOfferResult ReadFirmwareOffer(std::string_view);

    AcceptedFirmwareOffer() = default;

    std::string board_id_;
    std::string version_;
    std::string release_tag_;
    std::string filename_;
    std::string download_url_;
    std::string sha256_;
    std::size_t size_bytes_ = 0;
};

struct FirmwareOfferResult {
    FirmwareOfferResult()                                      = default;
    FirmwareOfferResult(const FirmwareOfferResult&)            = delete;
    FirmwareOfferResult& operator=(const FirmwareOfferResult&) = delete;
    FirmwareOfferResult(FirmwareOfferResult&&)                 = default;
    FirmwareOfferResult& operator=(FirmwareOfferResult&&)      = default;

    bool                                   accepted = false;
    std::unique_ptr<AcceptedFirmwareOffer> offer;
    std::string                            reject_reason;
};

FirmwareOfferResult ReadFirmwareOffer(std::string_view metadata_json);

}  // namespace firmware_update
