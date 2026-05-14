SHELL := /bin/zsh
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

NPM ?= npm
SPEC ?=
PW_PROJECT ?= chromium

.PHONY: help install install-browsers install-browsers-ci typecheck test test-auth test-apps test-flows test-security test-all-browsers test-spec report clean

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "; print "Usage: make <target>\n\nTargets:"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install Node dependencies
	$(NPM) install

install-browsers: ## Install Playwright browsers (all)
	$(NPM) run install:browsers

install-browsers-ci: ## Install CI browser set (chromium)
	$(NPM) run install:browsers:ci

typecheck: ## Run TypeScript type-check
	npx tsc --noEmit

test: ## Run full test suite
	$(NPM) test

test-auth: ## Run auth tests
	$(NPM) run test:auth

test-apps: ## Run app tests
	$(NPM) run test:apps

test-flows: ## Run flow tests
	$(NPM) run test:flows

test-security: ## Run security tests
	$(NPM) run test:security

test-all-browsers: ## Run full suite on chromium+firefox+webkit
	$(NPM) run test:all-browsers

test-spec: ## Run one Playwright spec (usage: make test-spec SPEC=tests/security/headers.spec.ts PW_PROJECT=chromium)
	if [ -z "$(SPEC)" ]; then echo "SPEC is required (example: make test-spec SPEC=tests/security/headers.spec.ts)"; exit 2; fi
	npx dotenv -- playwright test "$(SPEC)" --project="$(PW_PROJECT)"

report: ## Open Playwright HTML report
	$(NPM) run report

clean: ## Remove generated test artifacts
	rm -rf playwright-report test-results

