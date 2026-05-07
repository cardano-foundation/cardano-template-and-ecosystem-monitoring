# Contributing to this project

First off, thanks for taking the time to contribute! 🎉

When contributing to this repository, please first describe the change you wish to make [via an issue](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/issues/new) before making a change. For every other form of discussion use the [discussions section](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/discussions) of this repo.
Please note we have a [code of conduct](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/blob/main/CODE_OF_CONDUCT.md), please follow it in all your interactions with the project.

## Development

### Adding a new framework

The pipeline (discovery, dashboard, version checks) is driven by a single registry at `frameworks.json`. To add a new on-chain language or off-chain SDK:

1. **Add an entry to `frameworks.json`**:
   ```json
   {
     "id": "<unique-id>",
     "label": "<Display Name>",
     "kind": "onchain",
     "discoveryPath": "onchain/<dir>/<manifest-file>",
     "statusPrefix": "<short-prefix>"
   }
   ```
   The discovery script will start scanning for `*/onchain/<dir>/<manifest-file>` and the dashboard will add a column automatically. `statusPrefix` is what shows up in `.local-test-results/<prefix>-<example>-status.txt` and in the GitHub Actions artifact name (`logs-<prefix>-...`); keep it short and stable.

2. **Add a CI job to `.github/workflows/ecosystem-test.yml`**: copy one of the existing `test-*` jobs (or `compile-aiken` for a compile-only on-chain job) and adapt the toolchain setup, run command, working directory, and artifact name. There's a comment block above `test-lucid` with the full checklist.

3. **(Optional) Add library version pins**: if your framework uses pinned upstream libraries you want tracked, add them to `versions.json` and a corresponding section in `scripts/sync-versions.sh` and `scripts/check-library-versions.sh`. (You can skip this if you only want the framework to appear in the matrix and have CI run its tests.)

To verify your registry entry is wired up correctly, run locally:

```bash
bash scripts/local-test-discovery.sh   # confirm discovery finds your examples
bash scripts/generate-dashboard.sh     # confirm dashboard.json gets a new column
cd docs && python3 -m http.server 8000 # then open http://localhost:8000
```

## Issues and pull requests

### Bug reports

[Submit an issue](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/issues/new) using the provided template for bug reports. If the template does not fit your purpose start with a blank issue.

For bug reports, it's very important to fill in the information in the structure provided by the templates to help us analyzing the bug.

### Feature requests and ideas

[Submit an issue](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/issues/new) using the provided template for feature requests. If the template does not fit your purpose start with a blank issue but make sure the name starts with a "FEATURE" in square brackets.

If you are starting with a very vague idea instead of a concrete feature request post it in the [discussions section](https://github.com/cardano-foundation/cardano-blueprint-and-ecosystem-monitoring/discussions) of the repository where we can refine the idea with you and create a structured feature request from it.

### Creating a pull request

Thank you for contributing your changes by opening a pull requests! To get something merged we usually require:

- ❗ Description of the changes - please follow the [Conventional Commits specification](https://www.conventionalcommits.org/en/v1.0.0/#specification) as we use it to automatically generate our CHANGELOG ❗
- Quality of changes is ensured - through new or updated automated tests
- Change is related to an issue (feature request or bug report) - ideally discussed beforehand
- Well-scoped - we prefer multiple PRs, rather than a big one
