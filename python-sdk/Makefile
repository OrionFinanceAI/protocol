.PHONY: uv-download
uv-download:
	curl -LsSf https://astral.sh/uv/install.sh | sh

.PHONY: venv
venv:
	rm -rf .venv build dist *.egg-info
	uv venv


.PHONY: install
install:
	uv pip install -e ."[dev]"
	uv run pre-commit install

.PHONY: codestyle
codestyle:
	uv run ruff check --select I --fix ./
	uv run ruff format ./

.PHONY: check-codestyle
check-codestyle:
	uv run ruff check --select I --fix --exit-non-zero-on-fix ./
	uv run ruff format --diff ./

.PHONY: docs
docs:
	uv run pydocstyle

.PHONY: test
test:
	uv run pytest -c pyproject.toml tests/
