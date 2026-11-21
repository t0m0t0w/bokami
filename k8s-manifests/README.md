# Bokami – Kubernetes / Flux-manifester for Glemmen Fleet

Manifester er tilpasset `Blalange/glemmen-fleet` (Talos Linux + Flux v2 + Rook Ceph + Traefik).

Klon din fork av `glemmen-fleet` og kopier filene herfra inn i tilsvarende mapper:

1. **`flux/infrastructure/namespaces.yaml`**  
   Legg til `bokami`-namespacet nederst (vanlig baseline PSA, trenger ikke `privileged`-label):
   ```yaml
   ---
   apiVersion: v1
   kind: Namespace
   metadata:
     name: bokami
   ```

2. **`flux/clusters/glemmen/apps/bokami.yaml`**  
   Kopier [`flux-clusters-glemmen-apps-bokami.yaml`](./flux-clusters-glemmen-apps-bokami.yaml) hit (venter på både `infrastructure` og `rook-ceph`).

3. **`flux/clusters/glemmen/apps/kustomization.yaml`**  
   Legg til `- bokami.yaml` under `resources` (alfabetisk etter `artex.yaml`).

4. **`flux/apps/bokami/`**  
   Opprett mappen og kopier alle filene fra [`flux-apps-bokami/`](./flux-apps-bokami/) inn dit (`kustomization.yaml`, `pvc.yaml`, `deployment.yaml`, `service.yaml`, `ingress.yaml`).  
   Klusterets Rook Ceph-lagringsklasser brukes direkte (`nvme-rbd` / `ReadWriteOnce` for `bokami-data-ceph` og CephFS `fast-fs` / `ReadWriteMany` for `bokami-books-ceph`, begge med `reclaimPolicy: Retain` og `allowVolumeExpansion: true`), så ingen egen `StorageClass` trengs.

## Secrets (valgfri, opprettes manuelt — aldri i Git)

Du kan sette faste passord med en Secret før (eller mens) Flux ruller ut appen:

```sh
kubectl -n bokami create secret generic bokami-secrets \
  --from-literal=reader-password='ditt-leserpassord' \
  --from-literal=admin-password='ditt-admin-passord'
```

Fordi `deployment.yaml` bruker `optional: true` på `secretKeyRef`, vil Bokami fortsatt starte normalt uten denne Secreten — da genereres tilfeldige passord ved første oppstart og logges til konsollen (`kubectl -n bokami logs deploy/bokami`).

## Docker-image (`ghcr.io`)

`deployment.yaml` bruker `ghcr.io/t0m0t0w/bokami:latest`, som bygges og pushes automatisk av GitHub Actions (`.github/workflows/docker.yml`) når kode pushes til `main`.

> **Viktig:** Sørg for at pakken `bokami` under GitHub Packages på `github.com/t0m0t0w` settes til **Public** — eller opprett en `ghcr-pull` Secret i `bokami`-namespacet og legg til `imagePullSecrets: [{ name: ghcr-pull }]` i `deployment.yaml` slik `artex` gjør.

## Verifisering og opplasting av bøker

Når PR-en er merget og Flux har synkronisert:

```sh
kubectl -n bokami get pods,pvc,ingress
curl -fsS https://bokami.glem.men/healthz
```

* **CephFS-montering (anbefalt for bildeserier og større biblioteker):** Siden `bokami-books-ceph` bruker CephFS (`fast-fs` / `ReadWriteMany`), kan du montere bokvolumet direkte fra `glemmen-fleet`-repoet:
  ```sh
  ./scripts/mount-cephfs.py --pvc bokami-books-ceph -n bokami ~/bokami-books
  ```
* **PDF og EPUB:** Kan lastes opp direkte i nettleseren under **Innstillinger (⚙)** når du er logget inn som admin.
* **Via `kubectl cp`:** Alternativt kan mapper kopieres direkte inn i `/app/books`:
  ```sh
  kubectl -n bokami cp ./MinBok deploy/bokami:/app/books/MinBok
  ```
