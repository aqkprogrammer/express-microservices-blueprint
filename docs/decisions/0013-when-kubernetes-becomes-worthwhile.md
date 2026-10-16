# ADR-0013: When Kubernetes becomes worthwhile

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The blueprint runs locally with Docker Compose. Teams often assume microservices require Kubernetes from day one. Kubernetes brings scheduling, self-healing, rolling updates and autoscaling, but also a substantial platform to operate and learn. This record states when the trade-off pays off.

## Decision

- **Docker Compose is the supported local environment.** It is not presented as a production orchestrator.
- **Kubernetes is recommended when several of the following are true**, not before:

| Signal                                               | Why Kubernetes helps                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Many services and replicas across several hosts      | Bin-packing and scheduling across a cluster                                   |
| Frequent independent deployments with zero downtime  | Rolling updates driven by readiness probes (`/health/ready`)                  |
| Load that varies enough to justify autoscaling       | Horizontal Pod Autoscaler on CPU or custom metrics (e.g. queue depth)         |
| A platform team (or managed Kubernetes) is available | Someone owns upgrades, networking, policies and cost                          |
| Need for standard policy enforcement                 | NetworkPolicies, Pod Security Standards, resource quotas, secrets integration |

- **Simpler options first** for small teams or few services: a managed container platform (e.g. AWS ECS/Fargate, Google Cloud Run, Azure Container Apps) or a single VM with Compose for internal tools. Databases, brokers and caches are best consumed as managed services in either case.

The services are already built to run under an orchestrator: stateless processes, configuration from environment and `*_FILE` secrets, liveness/readiness endpoints, graceful SIGTERM shutdown that drains HTTP and consumers, non-root images, and migrations as a separate release step. Manifests and guidance are described in [Kubernetes deployment](../deployment/kubernetes.md) and [production deployment](../deployment/production.md).

## Consequences

### Positive

- No team is forced to adopt a cluster before it has a reason to.
- Moving to Kubernetes later does not require application changes.

### Negative and trade-offs

- Without an orchestrator, restarts, scaling and rollouts are manual or platform-specific.
- Compose resource limits and health checks are a local approximation of what a cluster enforces.

## Alternatives considered

| Option                  | Why not chosen as the default                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes from day one | High fixed cost (cluster operation, YAML/Helm, ingress, observability stack) before there is a scale or deployment-frequency problem. |
| Compose in production   | Acceptable for very small, non-critical deployments on one host; no multi-host scheduling or rolling updates.                         |
| Serverless functions    | Long-lived AMQP consumers and in-process outbox relays do not fit a request-scoped execution model.                                   |

## Operational cost

If adopted: cluster upgrades, ingress and certificate management, network policies, secrets integration, monitoring of the cluster itself, and the skills to debug scheduling and networking issues. Managed Kubernetes reduces but does not remove this cost.
