# Changelog

## [0.3.2](https://github.com/agent-of-empires/castellan/compare/v0.3.1...v0.3.2) (2026-11-09)


### Bug Fixes

* **triage:** skip a project field without the needed option instead of aborting ([#90](https://github.com/agent-of-empires/castellan/issues/90)) ([863a4ef](https://github.com/agent-of-empires/castellan/commit/863a4efc547e91c0e9facb61f9c7f5e94dfbd826))

## [0.3.1](https://github.com/agent-of-empires/castellan/compare/v0.3.0...v0.3.1) (2026-11-09)


### Bug Fixes

* **pipeline:** read policy and codeowners at the base branch ref ([#86](https://github.com/agent-of-empires/castellan/issues/86)) ([7a802c2](https://github.com/agent-of-empires/castellan/commit/7a802c298d31fe4dcb9bf31d790f35f382656241))
* **triage:** accept extra keys in the model's reasons object ([#89](https://github.com/agent-of-empires/castellan/issues/89)) ([77ed77b](https://github.com/agent-of-empires/castellan/commit/77ed77b011bfcf7c3101a08f051ce909e041c54c))

## [0.3.0](https://github.com/agent-of-empires/castellan/compare/v0.2.1...v0.3.0) (2026-11-09)


### ⚠ BREAKING CHANGES

* **config:** add triage.enabled and drop the triage shadow mode ([#83](https://github.com/agent-of-empires/castellan/issues/83))

### Features

* **config:** add triage.enabled and drop the triage shadow mode ([#83](https://github.com/agent-of-empires/castellan/issues/83)) ([1b44038](https://github.com/agent-of-empires/castellan/commit/1b44038e14a9ea695d98893275257e4648bae398))


### Bug Fixes

* **lambda:** route issues.labeled so triage runs on needs-triage ([#81](https://github.com/agent-of-empires/castellan/issues/81)) ([68a9889](https://github.com/agent-of-empires/castellan/commit/68a98896b5125e8b341701b3f6c0dea23e997c3d))
* **llm:** add sonnet 4.6 and haiku 4.5 to the price table ([#80](https://github.com/agent-of-empires/castellan/issues/80)) ([a228c2c](https://github.com/agent-of-empires/castellan/commit/a228c2cd830fd93ff55a8c8ad997614401f50a92))

## [0.2.1](https://github.com/agent-of-empires/castellan/compare/v0.2.0...v0.2.1) (2026-11-09)


### Bug Fixes

* **pipeline:** log the failure detail when a model call fails ([#75](https://github.com/agent-of-empires/castellan/issues/75)) ([36eeb0f](https://github.com/agent-of-empires/castellan/commit/36eeb0f59c920e3f23a1ba0ca0850e2a67fcdfbc))
* **rules:** wait for CI to settle before posting a brief ([#72](https://github.com/agent-of-empires/castellan/issues/72)) ([127362e](https://github.com/agent-of-empires/castellan/commit/127362ed69eb6f99ca44a5ff390db5bd7d7cde6e))
* **snapshot:** handle github 406 diff too_large instead of crashing ([#76](https://github.com/agent-of-empires/castellan/issues/76)) ([516fce6](https://github.com/agent-of-empires/castellan/commit/516fce605b915b3d02b0dfbb3553537258a66b90))

## [0.2.0](https://github.com/agent-of-empires/castellan/compare/v0.1.1...v0.2.0) (2026-11-09)


### Features

* **brief:** readable comment, model in shadow, shadow status ([#69](https://github.com/agent-of-empires/castellan/issues/69)) ([1568997](https://github.com/agent-of-empires/castellan/commit/1568997f17a0dc80c0606ba0cf4a7e5a50e3af85))


### Bug Fixes

* **rules:** treat skipped required checks as satisfied ([#68](https://github.com/agent-of-empires/castellan/issues/68)) ([35103ce](https://github.com/agent-of-empires/castellan/commit/35103ce7e1dcc654d0fbc0e2a42151633a7102c5))

## [0.1.1](https://github.com/agent-of-empires/castellan/compare/v0.1.0...v0.1.1) (2026-11-09)


### Bug Fixes

* **lambda:** filter check_suite and sha PR lookups to this repo ([#62](https://github.com/agent-of-empires/castellan/issues/62)) ([0783f8b](https://github.com/agent-of-empires/castellan/commit/0783f8b191a5289def1e852ddab1983174e9c9ad))
* **pipeline:** fail closed on team lookup and snapshot errors ([#59](https://github.com/agent-of-empires/castellan/issues/59)) ([bc5aa38](https://github.com/agent-of-empires/castellan/commit/bc5aa3875d2b92f91226e1a36b430f25588d6e8d))

## 0.1.0 (2026-11-09)


### Features

* **act:** approve and queue squash auto-merge by mode ([#43](https://github.com/agent-of-empires/castellan/issues/43)) ([3129349](https://github.com/agent-of-empires/castellan/commit/31293495317cabd9f528a02b238f2f526635eaf5))
* **adapters:** add github action and cli adapters ([#47](https://github.com/agent-of-empires/castellan/issues/47)) ([fc3779b](https://github.com/agent-of-empires/castellan/commit/fc3779b695be09dc6dd19efd1cb5a497c8911b48))
* **cache:** add sticky comment block parsing and llm dedup ([#38](https://github.com/agent-of-empires/castellan/issues/38)) ([e69c7ea](https://github.com/agent-of-empires/castellan/commit/e69c7eabb12c6952ae9069f4fd3c87baa2f097cb))
* **ci:** add release-please and lambda zip release workflow ([#36](https://github.com/agent-of-empires/castellan/issues/36)) ([644f603](https://github.com/agent-of-empires/castellan/commit/644f6039d54b977546b89f0f3fcaaeab3b8e0be9))
* **config:** load and validate .castellan.yml from the base branch ([#29](https://github.com/agent-of-empires/castellan/issues/29)) ([87df6e8](https://github.com/agent-of-empires/castellan/commit/87df6e881a6c38766cc4f522a5762a7405c47c38))
* **eval:** historical replay, precision report and fixtures CI job ([#44](https://github.com/agent-of-empires/castellan/issues/44)) ([6f51fd7](https://github.com/agent-of-empires/castellan/commit/6f51fd7337b27a05e0b15a2e84b15682245dc622))
* **github:** add app auth client, ruleset checks and team membership ([#30](https://github.com/agent-of-empires/castellan/issues/30)) ([a328d0a](https://github.com/agent-of-empires/castellan/commit/a328d0a4da8105247a9e6633959793a494906559))
* **lambda:** add webhook adapter with hmac check, routing and sweep ([#48](https://github.com/agent-of-empires/castellan/issues/48)) ([bbd7e41](https://github.com/agent-of-empires/castellan/commit/bbd7e41526eaecc9c4a962395c0d7543be2634f4))
* **llm:** add fail-closed review client for anthropic and bedrock ([#32](https://github.com/agent-of-empires/castellan/issues/32)) ([a623e69](https://github.com/agent-of-empires/castellan/commit/a623e694674ac68db586559caac5b105b678aea9))
* **rules:** add deterministic skip and escalate pipeline ([#40](https://github.com/agent-of-empires/castellan/issues/40)) ([038f461](https://github.com/agent-of-empires/castellan/commit/038f461cb7bcf6c2a3d1e30e3bb918b40729a40b))
* **snapshot:** add pr snapshot builder with caps and exclusions ([#31](https://github.com/agent-of-empires/castellan/issues/31)) ([a7efde4](https://github.com/agent-of-empires/castellan/commit/a7efde4558a80ab96c3e70ab7d9c3bcf4765cea2))
* **triage:** classify issues and fill project fields by name ([#39](https://github.com/agent-of-empires/castellan/issues/39)) ([14a14c3](https://github.com/agent-of-empires/castellan/commit/14a14c32af4ab96d8f0ddc8a4950f267a099f6e8))
* **verdict:** add verdict, brief comment and commit status ([#41](https://github.com/agent-of-empires/castellan/issues/41)) ([2573c8b](https://github.com/agent-of-empires/castellan/commit/2573c8b2819766ab3079857f3494373bf4e2544a))
* **website:** add astro site for castellan.agent-of-empires.com ([#49](https://github.com/agent-of-empires/castellan/issues/49)) ([b2e8754](https://github.com/agent-of-empires/castellan/commit/b2e875452841d693266ba78ac0ecbb525e198748))


### Bug Fixes

* **release:** start versioning at 0.1.0 ([#46](https://github.com/agent-of-empires/castellan/issues/46)) ([7147ab1](https://github.com/agent-of-empires/castellan/commit/7147ab11f4f82f84a0268fd30037d76c77145bed))
