# 11. CI/CD pipeline

[← Kubernetes (optional)](10-kubernetes.md) · [Index](README.md) · Next: [Failure recovery →](12-failure-recovery.md)

The GitHub Actions workflows are in [`.github/workflows`](../../.github/workflows). There are three
of them, plus Dependabot. All use least-privilege `permissions` and pin third-party actions to
commit SHAs.

```mermaid
flowchart LR
    pr["pull request · push to main"] --> quality

    subgraph ci["CI workflow (ci.yml)"]
        direction LR
        quality["quality<br/>format:check · build · typecheck tests<br/>lint · unit (coverage) · contract<br/>docs:validate · generated-artefact drift"]
        compat["node-compatibility<br/>unit tests on Node 22 and 24"]
        integration["integration<br/>Testcontainers: PostgreSQL · RabbitMQ · Redis"]
        images["images<br/>docker compose build (no push)<br/>Trivy: fail on fixable HIGH/CRITICAL"]
        e2e["e2e<br/>docker compose up --wait<br/>test:e2e · test:resilience<br/>logs uploaded on failure"]
        quality --> integration
        quality --> images
        integration --> e2e
        images --> e2e
    end
    pr --> compat

    subgraph security["Security workflow (security.yml) · also weekly"]
        codeql["CodeQL<br/>security-and-quality"]
        audit["npm audit<br/>prod deps fail on high"]
        gitleaks["gitleaks<br/>full git history"]
        review["dependency review<br/>pull requests only"]
    end
    pr --> codeql
    pr --> audit
    pr --> gitleaks
    pr --> review

    tag["tag v*.*.*"] --> verify["verify<br/>build · lint · npm test"]
    verify --> ghrelease["GitHub release<br/>notes from CHANGELOG.md"]
    verify -.->|"only if vars.PUBLISH_IMAGES == 'true'"| ghcr[("GHCR images<br/>with SBOM + provenance")]

    dependabot["Dependabot<br/>npm (grouped) · actions · Docker"] -.-> pr
```

## Notes

- **Cheap checks run first.** The `quality` job (formatting, compilation, lint, unit and contract
  tests, documentation and OpenAPI validation) must pass before any job starts containers. It also
  regenerates the RabbitMQ definitions, the Grafana dashboards and the animated SVGs, and fails if
  they differ from the committed files.
- **Integration tests** start real PostgreSQL, RabbitMQ and Redis containers with Testcontainers,
  so the outbox, the consumers and the SQL run against the same engines as production.
- **Images** are built from the single multi-stage Dockerfile and scanned with Trivy. Each image is
  scanned on its own, and the job fails on fixable HIGH or CRITICAL findings. Nothing is pushed
  from CI.
- **End-to-end and resilience** tests run the whole stack with Docker Compose. The resilience tests
  stop and start containers. The runner is torn down with `--volumes` afterwards because it is
  ephemeral.
- **Releases** run on semantic-version tags. Release notes come from the matching `CHANGELOG.md`
  section. Images go to GHCR only when the repository variable `PUBLISH_IMAGES` is `true`. Nothing is
  ever deployed automatically.

_Keep this page in sync with the workflow files. If a job is renamed or reordered in
`.github/workflows`, update the diagram._
