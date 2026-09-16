#pragma once

#include <string>
#include <vector>

namespace cache::staging {

struct Swap {
    std::string staged;
    std::string target;
    std::string backup;
    bool        had_target = false;
    bool        installed  = false;
    bool        delete_target = false;
};

bool CommitSwaps(std::vector<Swap>& swaps);
bool InstallSwaps(std::vector<Swap>& swaps);
bool FinalizeSwaps(std::vector<Swap>& swaps);
bool RollbackSwaps(std::vector<Swap>& swaps);

}  // namespace cache::staging
