# ADR-006 · Compose ingress network

Status: accepted for M2.07 implementation. Issue/spec: [M2.07 / #29](https://github.com/costaapps/ca_meta_app/issues/29), [Compose environments](../specs/compose-environments.md). Functional owner role: DevOps / delivery engineering. Evidence SHA: pending final M2.07 smoke.

## Contexto comprovado

The Compose model publishes only the web container's port. API, worker, migration and database have no published host ports. During the M2.07 local smoke, the `edge` bridge was marked `internal: true`; Docker inspection showed the requested web HostConfig binding `127.0.0.1:<port>`, but `NetworkSettings.Ports` had no active binding and the host had no listener. The web healthcheck inside its container passed. The issue was therefore the network boundary preventing host ingress, not the web process.

Docker's [Compose networking documentation](https://docs.docker.com/compose/how-tos/networking/) says an internal network is created without connection to the host's network interfaces. The real host firewall, Docker Desktop forwarding behavior outside this local run and LAN isolation are not established by the checkout.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Keep `edge` internal and remove web port publication | Strong host isolation | Browser/ingress cannot reach the web container; fails the single-origin contract | Local smoke showed no active host port listener |
| Make `edge` a normal host-connected bridge; publish only web | Supports the required web ingress while API, worker, migration and DB remain without host ports | Services attached to `edge` may gain egress; host firewall and LAN behavior require separate verification | Compose service model plus a local host-port smoke after the change |

## Decisão e consequência

Use a normal bridge for `edge` so the published web port can accept ingress. Keep the database on the isolated `internal` network. Preserve the existing port policy: web alone publishes a host port; API, worker, migration and database do not. API remains on `edge`, `internal` and `outbound` to serve `/api` through web and reach its dependencies.

The change enables ingress at the Docker host; it does not configure TLS, a reverse proxy, DNS, a public firewall or an egress policy. API's attachment to `edge` means its effective egress path is **Not confirmed**. Production must use the approved ingress/firewall configuration before exposure.

## Segurança, efeitos e reversibilidade

- Tenant and authorization boundary: unchanged; Docker network membership is not tenant authorization.
- Secret and credential custody/rotation boundary: unchanged; secrets remain file-backed Compose secrets.
- Async or external side effects: none introduced; migration and worker ordering are unchanged.
- Reversible switch and rollback: restore `edge: internal: true` to disable host ingress, which also makes the published web port unavailable. Do not change a shared production stack without its separate deployment gate.
- Bounded decision scope: Compose network reachability only. This does not prove LAN isolation, host firewall rules, DNS, TLS or real ingress.

## Prova, implantação e recuperação

The coordinator will run `pwsh -NoProfile -File tools/m2-07/run-compose-smoke.ps1` on the stable candidate and record the exact SHA, Docker Engine and Compose versions, project cleanup and result in M2 delivery evidence. The smoke checks loopback web ingress, internal API health/readiness, absence of other published ports, migration gating, data persistence and local DB restart. It does not prove external firewall behavior. `DOCKER_INSECURE_NO_IPTABLES_RAW` is set in the local daemon environment, so LAN isolation remains **Not confirmed**.

## Revisão futura

Revisit if the deployment platform supplies a distinct ingress network, enforces egress independently, or does not support this bridge/port-binding model. Revalidate the Compose port model and external firewall before using a public staging/production host.
