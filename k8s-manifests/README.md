# Bokami – Kubernetes / Flux-manifester

Klon din fork av `glemmen-fleet` og kopier filene herfra inn i tilsvarende mapper:

1. **`flux/infrastructure/namespaces.yaml`**  
   Legg til `bokami`-namespacet nederst.

2. **`flux/clusters/glemmen/apps/bokami.yaml`**  
   Kopier [`flux-clusters-glemmen-apps-bokami.yaml`](./flux-clusters-glemmen-apps-bokami.yaml) hit.

3. **`flux/clusters/glemmen/apps/kustomization.yaml`**  
   Legg til `- bokami.yaml` under `resources`.

4. **`flux/apps/bokami/`**  
   Opprett mappen og kopier alle filene fra [`flux-apps-bokami/`](./flux-apps-bokami/) inn dit.

## Docker-image (`ghcr.io`)

`deployment.yaml` bruker `ghcr.io/t0m0t0w/bokami:latest`, som bygges og pushes automatisk av GitHub Actions (`.github/workflows/docker.yml`) når kode pushes til `main`.

> **Viktig:** Sørg for at pakken `bokami` under GitHub Packages på `github.com/t0m0t0w` settes til **Public** (eller legg inn en `imagePullSecret` i klusteret) slik at Kubernetes får lastet ned imaget uten autentiseringsfeil.
