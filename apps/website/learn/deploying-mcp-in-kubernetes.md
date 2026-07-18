---
title: Deploying MCP in Kubernetes
description: "Deploying MCP in Kubernetes means running your MCP gateway on your own cluster with Helm, multiple replicas, a shared store, secrets, ingress and TLS."
---

# Deploying MCP in Kubernetes

**Deploying MCP in Kubernetes** means running your Model Context Protocol gateway as a workload on your own
cluster — installed with Helm, scaled across multiple replicas, backed by a shared store, and exposed
through ingress with TLS. It is how organizations run MCP with high availability inside their own perimeter.

## Why Kubernetes for an MCP gateway

The gateway is the single point every AI client goes through to reach your tools, which makes it critical
infrastructure. Kubernetes gives it the properties critical infrastructure needs: self-healing pods,
rolling upgrades with no downtime, horizontal scaling, and declarative configuration you can version and
review. If you already run workloads on Kubernetes, the gateway fits your existing deployment, secrets and
observability patterns rather than becoming a snowflake.

## Installing with Helm

A well-packaged gateway ships as a Helm chart, so a single `helm install` stands up the deployment, service
and supporting resources. Values files let you pin the image, size resources, wire up the database, and set
identity and TLS configuration per environment. Keep those values in version control so dev, staging and
production stay reproducible.

## High availability and the shared store

For availability you run **more than one replica** behind a service. The moment you do, any state that must
be consistent across pods — sessions, caches, coordination — cannot live in a single pod's memory. The
standard answer is a **shared store** that every replica reads and writes, so requests can land on any pod
and behave identically. Run at least two replicas across nodes so a single node failure never takes the
gateway offline.

## Persistence choices

The gateway's registry and configuration need a database, and Kubernetes gives you two shapes:

- **Embedded / in-cluster** — a small embedded database on a PersistentVolume is fine for evaluation or
  low-scale use, but ties durability to that volume.
- **External managed database** — for production, point the gateway at PostgreSQL, MySQL/MariaDB or SQL
  Server (often a managed instance). This decouples data durability and backups from the pods and is the
  right choice for HA.

## Secrets and configuration

Never bake credentials into images or values committed to git. Store database passwords, signing keys and
upstream MCP-server credentials in Kubernetes **Secrets** (or an external secrets manager / KMS) and mount
them as environment variables or files. Keep non-sensitive settings in a **ConfigMap**. This separation lets
you rotate secrets without rebuilding the application.

## Ingress, TLS and scaling

Expose the gateway through an **Ingress** (or gateway API) that terminates **TLS** — MCP clients and OAuth
2.1 authorization flows require HTTPS. Terminate certificates at the ingress (for example via cert-manager)
and route to the service. To scale, increase the replica count or attach a HorizontalPodAutoscaler keyed on
CPU or custom metrics; because replicas are stateless behind the shared store, scaling out is
straightforward. Pair this with liveness and readiness probes so Kubernetes only sends traffic to healthy
pods.

## How Kravn fits

[Kravn](/) ships as a single container image with a Helm chart, so `helm install` brings up an MCP gateway
that is **multi-replica ready** with a **shared store** for cross-pod state. It supports embedded SQLite or
external PostgreSQL, MySQL/MariaDB and SQL Server, uses standard Kubernetes Secrets and ConfigMaps, and
comes with a documented [disaster-recovery / business-continuity runbook](/guide/dr-bcp). See the
[installation guide](/guide/installation) and [configuration reference](/guide/configuration) to get started.

## Related

- [Running MCP On-Premise](/learn/running-mcp-on-premise)
- [Enterprise MCP Architecture](/learn/enterprise-mcp-architecture)
- [MCP Observability & Auditing](/learn/mcp-observability)
- [What is an MCP Gateway?](/learn/what-is-an-mcp-gateway)
