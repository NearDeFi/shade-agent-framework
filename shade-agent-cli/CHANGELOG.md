# Changelog

## [3.0.0](https://github.com/NearDeFi/shade-agent-framework/compare/shade-agent-cli-v2.4.0...shade-agent-cli-v3.0.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **cli:** `deploy_to_phala` is replaced by `tee_config`. Move dstack_version, instance_type, public_logs and public_sysinfo to the top of `tee_config`, app_name and env_file_path into `tee_config.deploy`, and add `tee_config.phala.enabled: true`.

### Features

* **cli:** self-hosted dstack deploy backend, and a single tee_config block ([#197](https://github.com/NearDeFi/shade-agent-framework/issues/197)) ([baa7471](https://github.com/NearDeFi/shade-agent-framework/commit/baa74710159d594f3dfadc4fd39c0dc0c7e3f6b3))
