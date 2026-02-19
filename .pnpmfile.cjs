/**
 * pnpm hook to trim non-Solidity transitive dependencies from @chainlink/contracts.
 *
 * @chainlink/contracts ships build-tool packages (@arbitrum/nitro-contracts,
 * @eslint/eslintrc, @changesets/*, etc.) as production dependencies.
 * These pull in vulnerable transitive deps (minimatch <10.2.1 — GHSA-3ppc-4f35-3m26)
 * and are not needed for Solidity compilation.
 *
 * This hook removes them at install time, keeping only the Solidity source files.
 */
function readPackage(pkg) {
  if (pkg.name === "@chainlink/contracts") {
    pkg.dependencies = {};
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
