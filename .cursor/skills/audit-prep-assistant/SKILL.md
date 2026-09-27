---
name: audit-prep-assistant
description: Prepares codebases for security review using Trail of Bits' checklist. Helps set review goals, runs static analysis tools, increases test coverage, removes dead code, ensures accessibility, and generates documentation (flowcharts, user stories, inline comments). Use when preparing for a security audit, before a Trail of Bits or similar review, or when the user asks for audit prep.
---

# Audit Prep Assistant

## Purpose

Helps prepare for a security review using Trail of Bits' checklist. A well-prepared codebase makes the review process smoother and more effective.

**Use this**: 1-2 weeks before your security audit

---

## The Preparation Process

### Step 1: Set Review Goals

Helps define what you want from the review:

**Key Questions**:
- What's the overall security level you're aiming for?
- What areas concern you most?
  - Previous audit issues?
  - Complex components?
  - Fragile parts?
- What's the worst-case scenario for your project?

Documents goals to share with the assessment team.

---

### Step 2: Resolve Easy Issues

Runs static analysis and helps fix low-hanging fruit:

**Run Static Analysis**:

For Solidity:
```bash
slither . --exclude-dependencies
```

For Rust:
```bash
dylint --all
```

For Go:
```bash
golangci-lint run
```

For Go/Rust/C++:
```bash
# CodeQL and Semgrep checks
```

Then:
- Triage all findings
- Help fix easy issues
- Document accepted risks

**Increase Test Coverage**:
- Analyze current coverage
- Identify untested code
- Suggest new tests
- Run full test suite

**Remove Dead Code**:
- Find unused functions/variables
- Identify unused libraries
- Locate stale features
- Suggest cleanup

**Goal**: Clean static analysis report, high test coverage, minimal dead code

---

### Step 3: Ensure Code Accessibility

Helps make code clear and accessible:

**Provide Detailed File List**:
- List all files in scope
- Mark out-of-scope files
- Explain folder structure
- Document dependencies

**Create Build Instructions**:
- Write step-by-step setup guide
- Test on fresh environment
- Document dependencies and versions
- Verify build succeeds

**Freeze Stable Version**:
- Identify commit hash for review
- Create dedicated branch
- Tag release version
- Lock dependencies

**Identify Boilerplate**:
- Mark copied/forked code
- Highlight your modifications
- Document third-party code
- Focus review on your code

---

### Step 4: Generate Documentation

Helps create documentation:

**Flowcharts and Sequence Diagrams**:
- Map primary workflows
- Show component relationships
- Visualize data flow
- Identify critical paths

**User Stories**:
- Define user roles
- Document use cases
- Explain interactions
- Clarify expectations

**On-chain/Off-chain Assumptions**:
- Data validation procedures
- Oracle information
- Bridge assumptions
- Trust boundaries

**Actors and Privileges**:
- List all actors
- Document roles
- Define privileges
- Map access controls

**External Developer Docs**:
- Link docs to code
- Keep synchronized
- Explain architecture
- Document APIs

**Function Documentation**:
- System and function invariants
- Parameter ranges (min/max values)
- Arithmetic formulas and precision loss
- Complex logic explanations
- NatSpec for Solidity

**Glossary**:
- Define domain terms
- Explain acronyms
- Consistent terminology
- Business logic concepts

**Video Walkthroughs** (optional):
- Complex workflows
- Areas of concern
- Architecture overview

---

## How to Work

When invoked:

1. **Help set review goals** — Ask about concerns and document them
2. **Run static analysis** — Execute appropriate tools for the platform
3. **Analyze test coverage** — Identify gaps and suggest improvements
4. **Find dead code** — Search for unused code and libraries
5. **Review accessibility** — Check build instructions and scope clarity
6. **Generate documentation** — Create flowcharts, user stories, glossaries
7. **Create prep checklist** — Track what's done and what's remaining

Adapt based on:
- Platform (Solidity, Rust, Go, etc.)
- Available tools
- Existing documentation
- Review timeline

---

## Rationalizations (Do Not Skip)

| Rationalization | Why It's Wrong | Required Action |
|-----------------|----------------|-----------------|
| "README covers setup, no need for detailed build instructions" | READMEs assume context auditors don't have | Test build on fresh environment, document every dependency version |
| "Static analysis already ran, no need to run again" | Codebase changed since last run | Execute static analysis tools, generate fresh report |
| "Test coverage looks decent" | "Looks decent" isn't measured coverage | Run coverage tools, identify specific untested code paths |
| "Not much dead code to worry about" | Dead code hides during manual review | Use automated detection tools to find unused functions/variables |
| "Architecture is straightforward, no diagrams needed" | Text descriptions miss visual patterns | Generate actual flowcharts and sequence diagrams |
| "Can freeze version right before audit" | Last-minute freezing creates rushed handoff | Identify and document commit hash now, create dedicated branch |
| "Terms are self-explanatory" | Domain knowledge isn't universal | Create comprehensive glossary with all domain-specific terms |
| "I'll do this step later" | Steps build on each other — skipping creates gaps | Complete all 4 steps sequentially, track progress with checklist |

---

## Example Output

When preparation is complete, produce concrete deliverables. For full example package format, see [example-output.md](example-output.md).

**Summary of deliverables**:
- **Review Goals Document** — Security objectives, areas of concern, worst-case scenarios, questions for auditors
- **Static Analysis Report** — Tool output, triage status, CLEAN or documented exceptions
- **Test Coverage Report** — Overall %, uncovered areas, command used
- **Code Scope** — In-scope file list, out-of-scope, total lines
- **Build Instructions** — Prerequisites, setup steps, verification
- **Documentation** — Architecture, user stories, glossary, diagrams, NatSpec coverage
- **Deployment Info** — Network, commit, branch, deployed addresses

---

## Audit Prep Checklist

Copy and track progress:

```
- [ ] Review goals documented
- [ ] Static analysis clean/triaged
- [ ] Test coverage >80%
- [ ] Dead code removed
- [ ] Build instructions verified
- [ ] Stable version frozen
- [ ] Flowcharts created
- [ ] User stories documented
- [ ] Assumptions documented
- [ ] Actors/privileges listed
- [ ] Function docs complete
- [ ] Glossary created
```

---

## Timeline

**2 weeks before audit**: Set review goals, run static analysis, start fixing issues.

**1 week before audit**: Increase test coverage, remove dead code, freeze stable version, start documentation.

**Few days before audit**: Complete documentation, verify build instructions, create final checklist, send package to auditors.
