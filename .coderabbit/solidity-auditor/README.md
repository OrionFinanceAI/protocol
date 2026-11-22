# Solidity auditor review guidelines (for CodeRabbit)

Vendored, unmodified, from the open-source [pashov/skills](https://github.com/pashov/skills/tree/main/solidity-auditor)
`solidity-auditor` skill (MIT, see [LICENSE](LICENSE)), pinned at commit `eacfc09b365d2697b83355909d0300607e596ffc` (skill version 4.1). Refresh with
`scripts/sync-solidity-auditor.sh` and review the diff before merging.

Only the knowledge parts of the skill are vendored: the attack-surface lenses in `hacking-agents/` (what to look for),
`senior-auditor-sop.md` (how to think) and `judging.md` (when a finding is valid). The skill's orchestration (agent
fan-out, bundles, report assembly) is Claude Code specific and intentionally not included.

## How CodeRabbit should use these files

The upstream files are written for a multi-agent harness. When reviewing a pull request, interpret them as follows:

1. Treat each file in `hacking-agents/` as a review lens and apply the lenses that fit the changed Solidity code. Ignore
   references to "bundles", "agents", dedup tags and the FINDING/LEAD output format.
2. Follow `senior-auditor-sop.md` for how to reason and `judging.md` plus the "Do not report" list in
   `hacking-agents/shared-rules.md` for what is worth reporting.
3. Report a security issue as an ordinary inline review comment containing: the concrete attack path (caller, function,
   state change, impact), the concrete values or state sequence that demonstrate it, and a one-sentence fix. If there is
   no concrete path, do not raise it as a defect; mention it at most as a question.
4. Review only code touched by the pull request (plus the code it interacts with). Do not report admin-only actions,
   generic "admin can rug" claims, standard DeFi trade-offs, or self-harm-only bugs.
5. Repository-specific rules in `.coderabbit.yaml` path instructions take precedence over these generic files.
