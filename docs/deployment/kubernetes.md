# Kubernetes deployment (optional)

> **Optional.** Docker Compose is the supported way to run this project ([getting started](../development/getting-started.md)). The Kubernetes manifests show how the same images run under an orchestrator; read [ADR-0013](../decisions/0013-when-kubernetes-becomes-worthwhile.md) before deciding you need them, and [production deployment](production.md) for the wider picture.

Manifests live in `infrastructure/kubernetes/` and use plain [Kustomize](https://kustomize.io/) (built into `kubectl`, no Helm):

```
infrastructure/kubernetes/
├── base/                         environment-neutral manifests
│   ├── services/<service>.yaml   Deployment + Service (+ PDB, + HPA) per service
│   ├── config/*.env              non-secret settings → generated ConfigMaps
│   ├── migration-job.yaml        one-shot release Job (migrator image)
│   ├── network-policies.yaml     default deny + explicit allows
│   ├── ingress.yaml              routes only to api-gateway
│   └── serviceaccount.yaml       no API token mounted
├── overlays/local/               kind / minikube
├── overlays/production-example/  starting point with placeholders
└── secrets.example.yaml          names and keys of every Secret (placeholders only)
```

## What the base contains

| Resource                 | Details                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployments (10)         | api-gateway, auth, user, product, inventory, order, payment, notification, audit, worker. Non-root (uid/gid 1000), read-only root filesystem with an `emptyDir` at `/tmp`, no privilege escalation, all capabilities dropped, `RuntimeDefault` seccomp — passes the `restricted` Pod Security Standard. RollingUpdate with `maxUnavailable: 0`, `maxSurge: 1`. Topology spread across zones and nodes (`ScheduleAnyway`). |
| Probes                   | `startupProbe` and `livenessProbe` on `/health/live`; `readinessProbe` on `/health/ready` (checks the service's dependencies and returns 503 once shutdown starts).                                                                                                                                                                                                                                                       |
| Shutdown                 | `preStop` sleeps 5 s so endpoint removal reaches kube-proxy and the ingress controller, then SIGTERM triggers the app's own drain (`SHUTDOWN_TIMEOUT_MS`, default 15 s). `terminationGracePeriodSeconds: 30` covers both.                                                                                                                                                                                                 |
| Configuration            | `emb-common` and `<service>-config` ConfigMaps generated from `base/config/*.env` (a hash suffix rolls pods when a value changes). Credentials only through `secretKeyRef` / Secret volumes.                                                                                                                                                                                                                              |
| Services                 | ClusterIP, same ports as Compose (gateway 8080 plus metrics 9464, services 3001–3009), so in-cluster URLs such as `http://auth-service:3001` match.                                                                                                                                                                                                                                                                       |
| PodDisruptionBudgets     | `minAvailable: 1` for every multi-replica service (not the single-replica worker).                                                                                                                                                                                                                                                                                                                                        |
| HorizontalPodAutoscalers | `autoscaling/v2`, CPU 70 %, 2–6 replicas for api-gateway, product, inventory and order. Their Deployments omit `replicas` so `kubectl apply` does not fight the HPA. Requires metrics-server.                                                                                                                                                                                                                             |
| NetworkPolicies          | Default deny (ingress and egress), DNS egress, and only the flows the code uses — see below.                                                                                                                                                                                                                                                                                                                              |
| Ingress                  | Host `api.example.com` → `api-gateway:http` only, TLS from Secret `emb-api-tls`. Controller-agnostic (no annotations).                                                                                                                                                                                                                                                                                                    |
| Migration Job            | `emb-migrate` runs `infrastructure/docker/migrate.sh` from the `migrator` image: `prisma migrate deploy` per service database, optional seed, RabbitMQ topology declaration.                                                                                                                                                                                                                                              |
| ServiceAccounts          | `emb-app` and `emb-migrator`, `automountServiceAccountToken: false`, no RBAC bindings.                                                                                                                                                                                                                                                                                                                                    |

Not included, on purpose: PostgreSQL, RabbitMQ and Redis. Run them as managed services or with operators (below). Observability backends (OpenTelemetry Collector, Prometheus, Loki, Jaeger, Grafana) are also out of scope; the base points at a placeholder collector address and the local overlay disables export.

### Network flows allowed

| From                                                                             | To                                                                  | Port                     | Why                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| namespace labelled `network.emb/ingress-controller=true`                         | api-gateway                                                         | 8080                     | public traffic                                   |
| api-gateway                                                                      | auth, user, product, inventory, order, payment, notification, audit | 3001–3008                | proxying (never the worker)                      |
| every service except gateway and auth                                            | auth-service                                                        | 3001                     | JWKS (`/.well-known/jwks.json`)                  |
| order-service                                                                    | product-service, payment-service                                    | 3003, 3006               | `/internal/*` price snapshots and payment status |
| namespace labelled `network.emb/monitoring=true`                                 | all services                                                        | app port, gateway 9464   | Prometheus scraping                              |
| pods labelled `network.emb/postgres-client` / `rabbitmq-client` / `redis-client` | namespaces labelled `network.emb/data-services=true`                | 5432 / 5672, 5671 / 6379 | backing services                                 |
| all app pods                                                                     | namespace labelled `network.emb/observability=true`                 | 4318                     | OTLP/HTTP                                        |
| notification-service                                                             | any                                                                 | 587, 465                 | SMTP relay (narrow it to your relay)             |
| all pods                                                                         | kube-dns in `kube-system`                                           | 53                       | DNS                                              |

Policies only take effect with a CNI that enforces them (Calico, Cilium, and many managed clusters; check yours — otherwise they are accepted and silently ignored). kubelet probes and `kubectl port-forward` are not affected by them on common CNIs. If your ingress controller uses `hostNetwork`, its traffic comes from node IPs, not its namespace — add an `ipBlock` for the node CIDR.

## Secrets

The manifests reference Secrets by name and never create them. [`secrets.example.yaml`](../../infrastructure/kubernetes/secrets.example.yaml) lists every name and key with `REPLACE_ME` placeholders:

| Secret                              | Keys                                      | Used by                                                                         |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `<service>-db` (9)                  | `DATABASE_URL`                            | each service (runtime role)                                                     |
| `emb-migration-db`                  | `<SERVICE>_DATABASE_URL` ×9               | migration Job (DDL role)                                                        |
| `emb-rabbitmq`                      | `RABBITMQ_URL`                            | all services but the gateway; migration Job                                     |
| `emb-redis`                         | `REDIS_URL`                               | api-gateway, product-service, worker                                            |
| `emb-internal-api-token`            | `INTERNAL_API_TOKEN` (≥ 32 chars)         | order, product, payment                                                         |
| `auth-jwt-signing-key`              | `jwt-private.pem` (ES256, PKCS#8)         | auth-service, mounted at `/run/secrets/jwt` and read via `JWT_PRIVATE_KEY_FILE` |
| `auth-admin-bootstrap` _(optional)_ | `ADMIN_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` | auth-service, first deployment only                                             |
| `notification-smtp` _(optional)_    | `SMTP_USER`, `SMTP_PASSWORD`              | notification-service with `EMAIL_TRANSPORT=smtp`                                |

How to supply them:

- **External Secrets Operator** — `ExternalSecret` objects copy keys from AWS Secrets Manager, GCP Secret Manager, Azure Key Vault or Vault into these Secrets. Usually the best fit when a cloud secret store exists.
- **Sealed Secrets** — encrypt a filled-in Secret with `kubeseal` and commit only the `SealedSecret`; the controller decrypts it in-cluster.
- **Secrets Store CSI Driver** — mount secrets as files. Every service reads `<NAME>_FILE` for any setting (e.g. `DATABASE_URL_FILE`), so you can mount instead of using `secretKeyRef`; this needs a small patch to the Deployments.
- **Local clusters only** — copy the example into a git-ignored directory (`.gitignore` excludes `infrastructure/**/secrets/`), fill it in and `kubectl apply` it. Never commit a filled-in copy.

## Local cluster with the `local` overlay

Differences from the base: images `emb/<service>:local`, one replica each, no HPAs or PDBs, Ingress host `emb.localhost` without TLS, `COOKIE_SECURE=false`, OpenTelemetry export disabled, `SAGA_PAYMENT_TIMEOUT_MS=15000` and seed data loaded (all as in Compose).

Requirements: Docker, `kubectl` ≥ 1.27 (any version with Kustomize v5), and [kind](https://kind.sigs.k8s.io/) or [minikube](https://minikube.sigs.k8s.io/). Allow roughly 4 CPUs and 6 GB of memory for the cluster including the data services.

### 1. Create a cluster and load the images

```sh
kind create cluster --name emb
# or: minikube start --cpus 4 --memory 6g --cni calico   (Calico enforces NetworkPolicies)

# Builds emb/<service>:local and emb/migrator:local from node-service.Dockerfile
# (targets `runtime` per SERVICE build-arg, and `migrator`).
docker compose build

for image in api-gateway auth-service user-service product-service inventory-service \
             order-service payment-service notification-service audit-service worker migrator; do
  kind load docker-image "emb/${image}:local" --name emb    # minikube: minikube image load "emb/${image}:local"
done
```

To build a single image without Compose: `docker build -f infrastructure/docker/node-service.Dockerfile --target runtime --build-arg SERVICE=order-service -t emb/order-service:local .` (use `--target migrator` and tag `emb/migrator:local` for the migrator).

### 2. Provide PostgreSQL, RabbitMQ and Redis

Use a separate namespace and label it so the NetworkPolicies allow traffic to it:

```sh
kubectl create namespace emb-data
kubectl label namespace emb-data network.emb/data-services=true
```

Recommended — the same operators you could use in production:

- **PostgreSQL: [CloudNativePG](https://cloudnative-pg.io/).** Install the operator per its docs, then create a cluster in `emb-data`, e.g. `kind: Cluster` named `emb-pg` with `instances: 1`. Its read-write Service is `emb-pg-rw.emb-data.svc:5432`. Create the nine databases and roles with the same script Compose uses:

  ```sh
  kubectl -n emb-data exec -i emb-pg-1 -c postgres -- env POSTGRES_USER=postgres \
    AUTH_DB_PASSWORD=... USER_DB_PASSWORD=... PRODUCT_DB_PASSWORD=... INVENTORY_DB_PASSWORD=... \
    ORDER_DB_PASSWORD=... PAYMENT_DB_PASSWORD=... NOTIFICATION_DB_PASSWORD=... AUDIT_DB_PASSWORD=... \
    WORKER_DB_PASSWORD=... sh -s < infrastructure/postgres/init/01-create-service-databases.sh
  ```

- **RabbitMQ: [RabbitMQ Cluster Operator](https://www.rabbitmq.com/kubernetes/operator/operator-overview).** `kubectl apply -f https://github.com/rabbitmq/cluster-operator/releases/latest/download/cluster-operator.yml`, then a `RabbitmqCluster` named `rabbitmq` in `emb-data` (`replicas: 1` locally, 3 in production for quorum queues). AMQP: `rabbitmq.emb-data.svc:5672`; generated credentials are in Secret `rabbitmq-default-user`.
- **Redis: [Valkey](https://valkey.io/) or Redis** as a single non-persistent instance — it is only a cache, rate-limit store and scheduler lock ([ADR-0007](../decisions/0007-redis-not-system-of-record.md)). Any operator or chart works; locally a one-replica Deployment plus Service named `redis` in `emb-data`, started with `--save '' --appendonly no --maxmemory 128mb --maxmemory-policy allkeys-lru` like Compose, is enough.

None of these are part of the repository's manifests. For a throwaway kind cluster, plain single-replica Deployments of `postgres:17-alpine`, `rabbitmq:4.1-management-alpine` and `redis:8-alpine` also work; do not use that shortcut for anything you want to keep.

### 3. Namespace and Secrets

```sh
kubectl apply -f infrastructure/kubernetes/overlays/local/namespace.yaml   # namespace `emb`, Pod Security "restricted"

# A development signing key in a git-ignored directory (*.pem and secrets/ are ignored).
node scripts/generate-dev-keys.mjs infrastructure/kubernetes/overlays/local/secrets
kubectl -n emb create secret generic auth-jwt-signing-key \
  --from-file=jwt-private.pem=infrastructure/kubernetes/overlays/local/secrets/jwt-private.pem

cp infrastructure/kubernetes/secrets.example.yaml infrastructure/kubernetes/overlays/local/secrets/secrets.yaml
# Edit: delete the auth-jwt-signing-key entry (created above), set hosts to
# emb-pg-rw.emb-data.svc / rabbitmq.emb-data.svc / redis.emb-data.svc, use the
# passwords from step 2, amqp:// and redis:// for local plaintext connections,
# and the same role in emb-migration-db as in <service>-db (Compose uses one owner role per DB).
kubectl -n emb apply -f infrastructure/kubernetes/overlays/local/secrets/secrets.yaml
```

### 4. Run the migration Job, then deploy

```sh
cd infrastructure/kubernetes
kubectl apply -k overlays/local -l app.kubernetes.io/component=migration
kubectl -n emb wait --for=condition=complete job/emb-migrate --timeout=10m
kubectl -n emb logs job/emb-migrate

kubectl apply -k overlays/local
kubectl -n emb wait --for=condition=available deployment --all --timeout=5m
```

The first command applies only the migrator's ServiceAccount and Job. Running migrations first means services never start against an empty schema or a broker without the topology. Jobs are immutable: before re-running it (new image, changed env) delete it with `kubectl -n emb delete job emb-migrate`. `RUN_SEED=true` in this overlay re-applies the idempotent demo seed on every run.

### 5. Use it

```sh
kubectl -n emb port-forward svc/api-gateway 8080:8080
curl -s http://localhost:8080/api/v1/products | head -c 300
open http://localhost:8080/docs     # aggregated Swagger UI
```

The bootstrap admin comes from `auth-admin-bootstrap` if you created it. The worker's dead-letter admin API is not exposed: `kubectl -n emb port-forward svc/worker 3009:3009`.

Optional Ingress: install any Ingress controller (prefer an actively maintained one — the community ingress-nginx project has announced its retirement — or use the Gateway API with an `HTTPRoute` to `api-gateway:8080` instead), label its namespace `network.emb/ingress-controller=true`, and route `emb.localhost` to it (for kind, see its _Ingress_ guide for the port mappings). Optional metrics: label the Prometheus namespace `network.emb/monitoring=true`; pods carry `prometheus.io/*` annotations.

Clean up with `kind delete cluster --name emb` (or `minikube delete`).

## The `production-example` overlay

A starting point, not a turnkey deployment. Every `REPLACE_ME`, `replace-me` and `example.com` value must be changed:

- images `registry.example.com/emb/<service>` — pin a release tag or, better, a digest;
- Ingress class and a `cert-manager.io/cluster-issuer` annotation so cert-manager issues `emb-api-tls`;
- CORS origin, password-reset URL, `COOKIE_SECURE=true`, SMTP relay, OTLP collector endpoint;
- egress to managed PostgreSQL/RabbitMQ/Redis via `ipBlock` (placeholder `192.0.2.0/24`) because namespace selectors cannot match services outside the cluster;
- two `ServiceMonitor`s (`servicemonitors.yaml`), which **require the Prometheus Operator CRDs** (`monitoring.coreos.com/v1`); remove that file from `kustomization.yaml` if you scrape via annotations;
- the gateway's zone spread is strict (`DoNotSchedule`).

Release flow: build and push images in CI → delete the previous `emb-migrate` Job → apply the migration Job and wait → `kubectl apply -k` (or GitOps with Argo CD / Flux, where the Job can run as a pre-sync hook).

## Validating the manifests

```sh
kubectl kustomize infrastructure/kubernetes/overlays/local > /tmp/emb-local.yaml
kubeconform -strict -summary -kubernetes-version 1.33.0 /tmp/emb-local.yaml
# production-example contains ServiceMonitors: add a CRD schema location, e.g.
#   -schema-location default -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
kubectl apply -k infrastructure/kubernetes/overlays/local --dry-run=server   # against a real cluster
```

## Limits of this setup

- Rolling updates, readiness gating, the `preStop` delay and graceful shutdown reduce disruption during deploys; they do **not** guarantee zero failed requests (long requests, client retries, broker reconnects). See [production deployment](production.md#zero-downtime-what-is-and-is-not-promised).
- Schema changes must be backward compatible with the version still running (expand → migrate → contract), because old and new pods overlap during a rollout.
- No observability stack, backups, or data services are provided by these manifests.
