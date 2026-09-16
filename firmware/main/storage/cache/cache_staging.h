#pragma once

#include <string>
#include <vector>

namespace cache::staging {

struct Swap {
    std::string staged;
    std::string target;
    std::string backup;
    bool        had_target     = false;
    bool        installed      = false;
    bool        delete_target  = false;
    bool        target_existed = false;
};

bool CommitSwaps(std::vector<Swap>& swaps);
bool InstallSwaps(std::vector<Swap>& swaps);
bool FinalizeSwaps(std::vector<Swap>& swaps);
bool RollbackSwaps(std::vector<Swap>& swaps);
bool WriteJournal(const std::string& journal_path, const std::vector<Swap>& swaps);
bool RemoveJournal(const std::string& journal_path);
bool RecoverJournal(const std::string& journal_path);

#ifdef SLATE_HOST_TEST
void TestFailNextRename(const std::string& from, const std::string& to);
void TestFailNextUnlink(const std::string& path);
#endif

}  // namespace cache::staging
